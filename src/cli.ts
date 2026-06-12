/**
 * Saasy Odoo Agent CLI entry point.
 *
 * Usage: node dist/cli.js <module> <command> [options]
 *   saasy-odoo-agent jupyter install --env-id xxx
 *   saasy-odoo-agent jupyter start --env-id xxx
 *   saasy-odoo-agent ...
 */
import { runCli as runJupyterCli } from './jupyter/cli';
import { runCli as runBackupCli } from './backup/cli';
import { runCli as runUsersCli } from './users/cli';

const MODULES: Record<string, (argv: string[]) => Promise<void>> = {
  jupyter: runJupyterCli,
  backup: runBackupCli,
  users: runUsersCli,
};

async function main() {
  const [, , module, ...rest] = process.argv;
  if (!module || !MODULES[module]) {
    console.error('Usage: saasy-odoo-agent <module> <command> [options]');
    console.error('Modules: ' + Object.keys(MODULES).join(', '));
    process.exit(1);
  }
  await MODULES[module](rest);
}

main().catch((err) => {
  console.error('[CLI] Erreur fatale:', err);
  process.exit(1);
});
