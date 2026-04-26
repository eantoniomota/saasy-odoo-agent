/**
 * CLI pour le module backup de l'agent Saasy.
 *
 * Usage :
 *   saasy-agent backup odoo --env-id <id>
 *     [--odoo-container odoo]
 *     [--db-container <name>]
 *     [--db-name odoo]
 *     [--db-user odoo]
 *     [--filestore-path /var/lib/odoo/filestore]
 *     [--name "label affiche dans Saasy"]
 */
import { backupOdoo } from './odoo';

interface ParsedArgs {
  envId?: string;
  odooContainer?: string;
  dbContainer?: string;
  dbName?: string;
  dbUser?: string;
  filestorePath?: string;
  name?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--env-id': args.envId = next; i++; break;
      case '--odoo-container': args.odooContainer = next; i++; break;
      case '--db-container': args.dbContainer = next; i++; break;
      case '--db-name': args.dbName = next; i++; break;
      case '--db-user': args.dbUser = next; i++; break;
      case '--filestore-path': args.filestorePath = next; i++; break;
      case '--name': args.name = next; i++; break;
    }
  }
  return args;
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    console.error(`[FATAL] Argument requis manquant : ${name}`);
    process.exit(1);
  }
  return value;
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  async odoo(args) {
    const envId = requireArg(args.envId, '--env-id');
    const result = await backupOdoo({
      environmentId: envId,
      odooContainer: args.odooContainer || 'odoo',
      dbContainer: args.dbContainer,
      dbName: args.dbName,
      dbUser: args.dbUser,
      filestorePath: args.filestorePath,
      name: args.name,
    });
    console.log(`[Backup] Backup id: ${result.id}`);
  },
};

export async function runCli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (!cmd || !COMMANDS[cmd]) {
    console.error('Usage: saasy-agent backup <command> [options]');
    console.error('Commands: ' + Object.keys(COMMANDS).join(', '));
    process.exit(1);
  }
  const args = parseArgs(argv.slice(1));
  try {
    await COMMANDS[cmd](args);
  } catch (err) {
    console.error('[Backup] Erreur:', (err as Error).message);
    process.exit(1);
  }
}
