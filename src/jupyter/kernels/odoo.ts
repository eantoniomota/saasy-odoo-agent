/**
 * Odoo-specific kernel for Jupyter.
 *
 * This file is dedicated to Odoo and is OUT OF the generic agent core.
 * It builds a custom Docker image that combines Odoo + Jupyter
 * with an env-loaded kernel (equivalent to `odoo-bin shell`).
 */
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const KERNEL_PY = `"""
Odoo Jupyter kernel — loads Odoo env automatically on startup.
Equivalent to \`odoo-bin shell\` but inside a Jupyter notebook.
"""
import os
import odoo
from odoo.tools import config

config_file = os.environ.get('ODOO_RC', '/etc/odoo/odoo.conf')
db_name = os.environ.get('ODOO_DB', 'odoo')

config.parse_config(['-c', config_file, '-d', db_name])

registry = odoo.registry(db_name)
cr = registry.cursor()
env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})

from ipykernel.kernelapp import IPKernelApp
from ipykernel.ipkernel import IPythonKernel

class OdooKernel(IPythonKernel):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.shell.user_ns.update({
            'env': env,
            'registry': registry,
            'cr': cr,
            'odoo': odoo,
            'SUPERUSER_ID': odoo.SUPERUSER_ID,
        })
        banner = (
            f"Odoo {odoo.release.version} kernel — DB: {db_name}\\n"
            f"Available: env, registry, cr, odoo, SUPERUSER_ID"
        )
        print(banner)

if __name__ == '__main__':
    IPKernelApp.launch_instance(kernel_class=OdooKernel)
`;

const DOCKERFILE = `FROM odoo:17

USER root

RUN apt-get update && apt-get install -y python3-pip python3-venv \\
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --ignore-installed \\
    jupyterlab ipykernel jupyter-server

COPY odoo_kernel.py /opt/odoo_kernel.py
RUN python3 -m ipykernel install --name odoo --display-name "Odoo (env loaded)" \\
    --prefix=/usr/local
RUN cp /opt/odoo_kernel.py /usr/local/share/jupyter/kernels/odoo/kernel.py

USER odoo
EXPOSE 8888
CMD ["jupyter", "lab", "--ip=0.0.0.0", "--port=8888", "--no-browser"]
`;

import type { NotebookTemplate } from '../templates';

export const ODOO_TEMPLATES: NotebookTemplate[] = [
  {
    name: 'Odoo — Introduction',
    filename: 'odoo-00-intro.ipynb',
    description: 'Premier contact avec env Odoo',
    cells: [
      {
        type: 'markdown',
        source: [
          '# Odoo Notebook\n',
          'Le kernel **Odoo** charge automatiquement :\n',
          '- `env` : Odoo Environment (SUPERUSER_ID)\n',
          '- `registry`, `cr`, `odoo`\n',
          '\n',
          '⚠️ Tu agis en superadmin. **Toujours commiter** avec `env.cr.commit()`.',
        ],
      },
      { type: 'code', source: ['# Combien de contacts ?\n', "env['res.partner'].search_count([])"] },
      { type: 'code', source: ['# 5 derniers contacts\n', "for p in env['res.partner'].search([], limit=5, order='id desc'):\n", '    print(p.id, p.name, p.email)'] },
    ],
  },
  {
    name: 'Odoo — Export contacts',
    filename: 'odoo-export-contacts.ipynb',
    description: 'Exporter les contacts en CSV',
    cells: [
      { type: 'markdown', source: ['# Export contacts en CSV'] },
      {
        type: 'code',
        source: [
          'import csv\n',
          "partners = env['res.partner'].search([('customer_rank', '>', 0)])\n",
          "with open('/home/jovyan/work/contacts.csv', 'w') as f:\n",
          "    w = csv.writer(f)\n",
          "    w.writerow(['id', 'name', 'email', 'country'])\n",
          '    for p in partners:\n',
          "        w.writerow([p.id, p.name, p.email or '', p.country_id.name or ''])\n",
          "print(f'{len(partners)} contacts exportés vers contacts.csv')",
        ],
      },
    ],
  },
];

export interface OdooImageOptions {
  imageName: string;
  odooVersion: string;
}

/**
 * Build a Docker image that combines Odoo + Jupyter with the Odoo kernel.
 * The image is then used by the generic Jupyter installer.
 */
export function buildOdooImage(opts: OdooImageOptions): void {
  const dir = join(tmpdir(), `saasy-odoo-jupyter-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'odoo_kernel.py'), KERNEL_PY);
  writeFileSync(
    join(dir, 'Dockerfile'),
    DOCKERFILE.replace(/FROM odoo:17/, `FROM odoo:${opts.odooVersion}`),
  );

  execSync(`docker build -t ${opts.imageName} ${dir}`, { stdio: 'inherit' });
}

import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { renderNotebook } from '../templates';
import { sendJupyterStatus } from '../../transport/api';

export interface InstallOdooOptions {
  environmentId: string;
  containerName: string;
  port: number;
  notebookDir: string;
  odooVersion: string;
  dbName: string;
  allowOrigin: string;
  odooContainerName?: string; // par defaut "odoo"
  network?: string;            // auto-detecte si non fourni
  odooConfPath?: string;       // auto-detecte si non fourni
}

function dockerExec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function detectOdooNetwork(odooContainerName: string): string {
  try {
    const out = dockerExec(
      `docker inspect ${odooContainerName} --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\\n"}}{{end}}'`,
    );
    const networks = out.split('\n').filter(Boolean);
    if (networks.length === 0) {
      throw new Error(`Aucun network detecte sur ${odooContainerName}`);
    }
    return networks[0];
  } catch (err) {
    throw new Error(
      `Impossible de detecter le network du container "${odooContainerName}". ` +
      `Verifie qu'il tourne, ou passe --network manuellement. (${(err as Error).message})`,
    );
  }
}

function detectOdooConfPath(odooContainerName: string): string {
  try {
    const out = dockerExec(
      `docker inspect ${odooContainerName} --format '{{range .Mounts}}{{if eq .Destination "/etc/odoo/odoo.conf"}}{{.Source}}{{end}}{{end}}'`,
    );
    if (!out) {
      throw new Error(`Aucun mount /etc/odoo/odoo.conf trouve sur ${odooContainerName}`);
    }
    return out;
  } catch (err) {
    throw new Error(
      `Impossible de detecter le chemin de odoo.conf depuis "${odooContainerName}". ` +
      `Verifie le mount, ou passe --odoo-conf manuellement. (${(err as Error).message})`,
    );
  }
}

/**
 * Install complet Jupyter+Odoo : build l'image, detecte le network/odoo.conf,
 * genere le token et lance le container. Equivalent de jupyter.install pour Odoo.
 */
export async function installOdoo(opts: InstallOdooOptions): Promise<{ token: string; version: string }> {
  await sendJupyterStatus({ environmentId: opts.environmentId, status: 'installing' });

  const imageName = `saasy-odoo-jupyter:${opts.odooVersion}`;
  const odooContainer = opts.odooContainerName || 'odoo';

  // 1. Build l'image
  console.log(`[Jupyter] Build image ${imageName}...`);
  buildOdooImage({ imageName, odooVersion: opts.odooVersion });

  // 2. Auto-detect network + odoo.conf
  const network = opts.network || detectOdooNetwork(odooContainer);
  const odooConfPath = opts.odooConfPath || detectOdooConfPath(odooContainer);
  console.log(`[Jupyter] Network: ${network}`);
  console.log(`[Jupyter] odoo.conf: ${odooConfPath}`);

  // 3. Genere le token
  const token = randomBytes(32).toString('hex');

  // 4. Pre-install templates
  try {
    if (!existsSync(opts.notebookDir)) mkdirSync(opts.notebookDir, { recursive: true });
    for (const tpl of ODOO_TEMPLATES) {
      const path = join(opts.notebookDir, tpl.filename);
      if (!existsSync(path)) writeFileSync(path, renderNotebook(tpl));
    }
  } catch (err) {
    console.warn('[Jupyter] Templates non installes:', (err as Error).message);
  }

  // 5. Remove old container if any
  try {
    const exists = dockerExec(`docker ps -a --filter name=^${opts.containerName}$ --format "{{.Names}}"`);
    if (exists === opts.containerName) {
      execSync(`docker rm -f ${opts.containerName}`, { stdio: 'ignore' });
    }
  } catch { /* ignore */ }

  // 6. Run container
  const cmd = [
    'docker run -d',
    `--name ${opts.containerName}`,
    '--restart unless-stopped',
    `--network ${network}`,
    `-p 127.0.0.1:${opts.port}:8888`,
    `-v ${opts.notebookDir}:/home/jovyan/work`,
    `-v ${odooConfPath}:/etc/odoo/odoo.conf:ro`,
    `-e ODOO_DB=${opts.dbName}`,
    `-e ODOO_RC=/etc/odoo/odoo.conf`,
    `-e JUPYTER_TOKEN="${token}"`,
    `-e ALLOW_ORIGIN="${opts.allowOrigin}"`,
    imageName,
  ].join(' ');

  execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] });

  // 7. Wait for boot
  await new Promise((r) => setTimeout(r, 3000));

  // 8. Get version
  let version = 'unknown';
  try {
    version = dockerExec(`docker exec ${opts.containerName} jupyter --version | head -1`);
  } catch { /* ignore */ }

  await sendJupyterStatus({
    environmentId: opts.environmentId,
    status: 'running',
    version,
    kernels: ['python3', 'odoo'],
    adminToken: token,
  });

  return { token, version };
}
