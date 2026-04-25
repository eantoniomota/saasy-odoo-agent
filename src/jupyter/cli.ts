/**
 * CLI for Jupyter management on the Saasy agent.
 *
 * Usage:
 *   saasy-agent jupyter install --env-id <id> --port 8888 --domain notebook.x.com [--kernels python3,node,bash]
 *   saasy-agent jupyter install-odoo --env-id <id> --odoo-version 17 [--db-name odoo]
 *   saasy-agent jupyter start --env-id <id>
 *   saasy-agent jupyter stop --env-id <id>
 *   saasy-agent jupyter status --env-id <id>
 *   saasy-agent jupyter rotate-token --env-id <id>
 *   saasy-agent jupyter logs --env-id <id> [--tail 100]
 */
import { execSync } from 'child_process';
import * as jupyter from './index';
import { installOdoo } from './kernels/odoo';

interface ParsedArgs {
  envId?: string;
  port?: number;
  domain?: string;
  kernels?: string[];
  odooVersion?: string;
  dbName?: string;
  tail?: number;
  notebookDir?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--env-id': args.envId = next; i++; break;
      case '--port': args.port = parseInt(next, 10); i++; break;
      case '--domain': args.domain = next; i++; break;
      case '--kernels': args.kernels = next.split(',').map((k) => k.trim()); i++; break;
      case '--odoo-version': args.odooVersion = next; i++; break;
      case '--db-name': args.dbName = next; i++; break;
      case '--tail': args.tail = parseInt(next, 10); i++; break;
      case '--notebook-dir': args.notebookDir = next; i++; break;
    }
  }
  return args;
}

function containerName(envId: string): string {
  return `saasy-jupyter-${envId.slice(-12)}`;
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    console.error(`[FATAL] Argument requis manquant : ${name}`);
    process.exit(1);
  }
  return value;
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  async install(args) {
    const envId = requireArg(args.envId, '--env-id');
    const port = args.port || 8888;
    const allowOrigin = process.env.SAASY_API_URL?.replace(/\/$/, '').replace(/^https?:\/\/api\./, 'https://app.') || 'https://app.saasy.fr';
    const result = await jupyter.install({
      environmentId: envId,
      containerName: containerName(envId),
      port,
      notebookDir: args.notebookDir || `/home/jupyter/notebooks-${envId.slice(-8)}`,
      kernels: args.kernels || ['python3'],
      allowOrigin,
    });
    console.log(`[Jupyter] Installé. Token: ${result.token.slice(0, 8)}... Version: ${result.version}`);
  },

  async 'install-odoo'(args) {
    const envId = requireArg(args.envId, '--env-id');
    const odooVersion = requireArg(args.odooVersion, '--odoo-version');
    const port = args.port || 8888;
    const allowOrigin = process.env.SAASY_API_URL?.replace(/\/$/, '').replace(/^https?:\/\/api\./, 'https://app.') || 'https://app.saasy.fr';
    const result = await installOdoo({
      environmentId: envId,
      containerName: containerName(envId),
      port,
      notebookDir: args.notebookDir || `/home/jupyter/notebooks-${envId.slice(-8)}`,
      odooVersion,
      dbName: args.dbName || 'odoo',
      allowOrigin,
    });
    console.log(`[Jupyter] Installé. Token: ${result.token.slice(0, 8)}... Version: ${result.version}`);
    console.log(`[Jupyter] Acces local : http://127.0.0.1:${port}/?token=${result.token}`);
  },

  async start(args) {
    const envId = requireArg(args.envId, '--env-id');
    await jupyter.start({ environmentId: envId, containerName: containerName(envId) });
    console.log('[Jupyter] Démarré');
  },

  async stop(args) {
    const envId = requireArg(args.envId, '--env-id');
    await jupyter.stop({ environmentId: envId, containerName: containerName(envId) });
    console.log('[Jupyter] Arrêté');
  },

  async status(args) {
    const envId = requireArg(args.envId, '--env-id');
    const status = jupyter.getStatus(containerName(envId));
    console.log(`[Jupyter] Statut: ${status}`);
    await jupyter.reportStatus({ environmentId: envId, containerName: containerName(envId) });
  },

  async 'rotate-token'(args) {
    const envId = requireArg(args.envId, '--env-id');
    const token = await jupyter.rotateToken({ environmentId: envId, containerName: containerName(envId) });
    console.log(`[Jupyter] Token régénéré: ${token.slice(0, 8)}...`);
  },

  async logs(args) {
    const envId = requireArg(args.envId, '--env-id');
    const tail = args.tail || 100;
    const out = execSync(`docker logs --tail ${tail} ${containerName(envId)}`, { encoding: 'utf-8' });
    console.log(out);
  },
};

export async function runCli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (!cmd || !COMMANDS[cmd]) {
    console.error('Usage: saasy-agent jupyter <command> [options]');
    console.error('Commands: ' + Object.keys(COMMANDS).join(', '));
    process.exit(1);
  }
  const args = parseArgs(argv.slice(1));
  try {
    await COMMANDS[cmd](args);
  } catch (err) {
    console.error('[Jupyter] Erreur:', (err as Error).message);
    process.exit(1);
  }
}
