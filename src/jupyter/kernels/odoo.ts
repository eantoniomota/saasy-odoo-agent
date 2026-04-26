/**
 * Odoo-specific kernel for Jupyter.
 *
 * This file is dedicated to Odoo and is OUT OF the generic agent core.
 * It builds a custom Docker image that combines Odoo + Jupyter
 * with an env-loaded kernel (equivalent to `odoo-bin shell`).
 */
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, cpSync, existsSync as existsSyncFs } from 'fs';
import { join, resolve } from 'path';
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

const JUPYTER_CONFIG_PY = `# Jupyter server config — genere par Saasy agent
c.ServerApp.allow_origin_pat = '^https://.*$'
c.ServerApp.disable_check_xsrf = True
# Cookies en SameSite=None pour fonctionner dans une iframe cross-origin (Saasy dashboard)
# Depuis Jupyter Server 2.0, cookie_options est sur IdentityProvider (pas ServerApp).
c.IdentityProvider.cookie_options = {'SameSite': 'None', 'Secure': True}
c.ServerApp.root_dir = '/home/jovyan/work'
`;

const DARK_THEME_SETTINGS = JSON.stringify({ theme: 'JupyterLab Dark' });

const DOCKERFILE = `FROM odoo:17

USER root

# docker.io pour permettre a l'extension Odoo Admin (depuis Jupyter)
# d'executer docker exec/restart sur le container Odoo via /var/run/docker.sock
RUN apt-get update && apt-get install -y python3-pip python3-venv docker.io \\
    && rm -rf /var/lib/apt/lists/*

# Permettre au user 'odoo' d'utiliser le socket Docker (membre du groupe docker)
RUN usermod -aG docker odoo

RUN pip3 install --break-system-packages --ignore-installed \\
    jupyterlab ipykernel jupyter-server

COPY odoo_kernel.py /opt/odoo_kernel.py
COPY kernel.json /opt/kernel.json
COPY jupyter_server_config.py /etc/jupyter/jupyter_server_config.py
COPY themes.jupyterlab-settings /tmp/themes.jupyterlab-settings

# Extension Odoo Admin : server-side (handlers HTTP) + frontend (menu top-bar).
# Le frontend est build pendant pip install via hatch-jupyter-builder
# (necessite Node.js, installe temporairement puis retire).
COPY jupyter-extension /tmp/jupyter-extension
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\
    && apt-get install -y nodejs \\
    && pip3 install --break-system-packages --ignore-installed /tmp/jupyter-extension \\
    && apt-get remove -y nodejs \\
    && apt-get autoremove -y \\
    && rm -rf /var/lib/apt/lists/* /tmp/jupyter-extension

RUN python3 -m ipykernel install --name odoo --display-name "Odoo (env loaded)" \\
    --prefix=/usr/local
# Remplace le kernel.py par le notre + force kernel.json a pointer dessus
RUN cp /opt/odoo_kernel.py /usr/local/share/jupyter/kernels/odoo/kernel.py \\
    && chmod +x /usr/local/share/jupyter/kernels/odoo/kernel.py \\
    && cp /opt/kernel.json /usr/local/share/jupyter/kernels/odoo/kernel.json

# Dark theme par defaut pour JupyterLab
RUN mkdir -p /var/lib/odoo/.jupyter/lab/user-settings/@jupyterlab/apputils-extension \\
    && cp /tmp/themes.jupyterlab-settings /var/lib/odoo/.jupyter/lab/user-settings/@jupyterlab/apputils-extension/themes.jupyterlab-settings \\
    && chown -R odoo:odoo /var/lib/odoo/.jupyter

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

  // kernel.json : pointe vers notre kernel.py custom au lieu du
  // ipykernel_launcher par defaut. {connection_file} est un placeholder
  // que Jupyter substitue au lancement du kernel.
  const kernelJson = {
    argv: [
      '/usr/bin/python3',
      '/usr/local/share/jupyter/kernels/odoo/kernel.py',
      '-f',
      '{connection_file}',
    ],
    display_name: 'Odoo (env loaded)',
    language: 'python',
  };
  writeFileSync(join(dir, 'kernel.json'), JSON.stringify(kernelJson, null, 2));

  writeFileSync(join(dir, 'jupyter_server_config.py'), JUPYTER_CONFIG_PY);
  writeFileSync(join(dir, 'themes.jupyterlab-settings'), DARK_THEME_SETTINGS);

  // Copie l'extension JupyterLab "saasy_jupyter_odoo" dans la build context.
  // Le Dockerfile fait ensuite pip install /tmp/jupyter-extension
  // __dirname = .../dist/jupyter/kernels (compile JS) ou src/jupyter/kernels (TS dev)
  // jupyter-extension est a la racine du package : 3 niveaux au-dessus
  const extensionSource = resolve(__dirname, '../../../jupyter-extension');
  if (existsSyncFs(extensionSource)) {
    cpSync(extensionSource, join(dir, 'jupyter-extension'), { recursive: true });
  } else {
    console.warn(`[Jupyter] Extension Odoo Admin introuvable a ${extensionSource} — le menu "Odoo" ne sera pas disponible.`);
  }

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
 * Detecte le path hote du dossier addons monte sur /mnt/extra-addons
 * dans le container Odoo. Retourne null si non trouve (l'admin module
 * sera quand meme fonctionnel mais sans support du file browser pour
 * les addons).
 */
function detectOdooAddonsPath(odooContainerName: string): string | null {
  try {
    const out = dockerExec(
      `docker inspect ${odooContainerName} --format '{{range .Mounts}}{{if eq .Destination "/mnt/extra-addons"}}{{.Source}}{{end}}{{end}}'`,
    );
    return out || null;
  } catch {
    return null;
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

  // 2. Auto-detect network + odoo.conf + addons path
  const network = opts.network || detectOdooNetwork(odooContainer);
  const odooConfPath = opts.odooConfPath || detectOdooConfPath(odooContainer);
  const addonsPath = detectOdooAddonsPath(odooContainer);
  console.log(`[Jupyter] Network: ${network}`);
  console.log(`[Jupyter] odoo.conf: ${odooConfPath}`);
  console.log(`[Jupyter] Addons: ${addonsPath || '(non detecte — file browser sans addons)'}`);

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

  // 6. Run container — override CMD pour passer les flags CSP/allow_origin
  // necessaires a l'embed dans l'iframe Saasy dashboard.
  // --workdir et --ServerApp.root_dir : Jupyter demarre dans le bon dossier.
  // Mount Docker socket : permet au menu "Odoo" de l'extension JupyterLab
  // d'executer docker exec/restart sur le container Odoo.
  // Mount addons (si detecte) : permet de browser et editer les modules
  // Odoo directement depuis JupyterLab.
  const cmd = [
    'docker run -d',
    `--name ${opts.containerName}`,
    '--restart unless-stopped',
    `--network ${network}`,
    `-p 127.0.0.1:${opts.port}:8888`,
    `-v ${opts.notebookDir}:/home/jovyan/work`,
    `-v ${odooConfPath}:/etc/odoo/odoo.conf:ro`,
    '-v /var/run/docker.sock:/var/run/docker.sock',
    addonsPath ? `-v ${addonsPath}:/mnt/extra-addons` : '',
    '--workdir /home/jovyan/work',
    `-e ODOO_DB=${opts.dbName}`,
    `-e ODOO_RC=/etc/odoo/odoo.conf`,
    `-e ODOO_CONTAINER=${odooContainer}`,
    `-e JUPYTER_TOKEN="${token}"`,
    `-e ALLOW_ORIGIN="${opts.allowOrigin}"`,
    imageName,
    'jupyter', 'lab',
    '--ip=0.0.0.0',
    '--port=8888',
    '--no-browser',
    // allow_origin_pat, cookie_options, disable_check_xsrf, root_dir :
    // sont definis dans /etc/jupyter/jupyter_server_config.py (image)
    // Ici on garde uniquement le CSP frame-ancestors qui est dynamique
    `--ServerApp.tornado_settings='{"headers":{"Content-Security-Policy":"frame-ancestors ${opts.allowOrigin}"}}'`,
  ].filter(Boolean).join(' ');

  execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] });

  // 7. Fix permissions du dossier de travail :
  // l'image odoo:18 tourne en user 'odoo', mais le mount cote hote est cree
  // par Docker en root. Sans chown, "Permission denied" a la creation de notebooks.
  try {
    execSync(
      `docker exec --user root ${opts.containerName} chown -R odoo:odoo /home/jovyan/work`,
      { stdio: 'ignore' },
    );
  } catch (err) {
    console.warn('[Jupyter] chown post-launch echoue (non critique):', (err as Error).message);
  }

  // 8. Wait for boot
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
