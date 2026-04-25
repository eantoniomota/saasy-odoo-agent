/**
 * Saasy Agent CLI entry point.
 *
 * Usage: node dist/cli.js <module> <command> [options]
 *   saasy-agent jupyter install --env-id xxx
 *   saasy-agent jupyter start --env-id xxx
 *   saasy-agent ...
 */
import { runCli as runJupyterCli } from './jupyter/cli';

const MODULES: Record<string, (argv: string[]) => Promise<void>> = {
  jupyter: runJupyterCli,
};

async function main() {
  const [, , module, ...rest] = process.argv;
  if (!module || !MODULES[module]) {
    console.error('Usage: saasy-agent <module> <command> [options]');
    console.error('Modules: ' + Object.keys(MODULES).join(', '));
    process.exit(1);
  }
  await MODULES[module](rest);
}

main().catch((err) => {
  console.error('[CLI] Erreur fatale:', err);
  process.exit(1);
});
