/**
 * CLI pour la synchronisation des utilisateurs Odoo vers Saasy.
 *
 * Usage :
 *   saasy-odoo-agent users sync --api-key sk_xxx
 *     [--odoo-container odoo]
 *     [--db-container <name>]
 *     [--db-name odoo]
 *     [--db-user odoo]
 *     [--include-portal]
 *     [--batch-size 200]
 *     [--dry-run]
 *
 * La cle API peut aussi etre fournie via SAASY_APP_API_KEY. C'est une cle
 * API d'app (sk_..., scope feedback, permission tracked_users:write) — pas
 * la cle agent infrastructure.
 */
import { syncUsers } from './odoo';

interface ParsedArgs {
  odooContainer?: string;
  dbContainer?: string;
  dbName?: string;
  dbUser?: string;
  apiKey?: string;
  includePortal?: boolean;
  batchSize?: number;
  dryRun?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--odoo-container': args.odooContainer = next; i++; break;
      case '--db-container': args.dbContainer = next; i++; break;
      case '--db-name': args.dbName = next; i++; break;
      case '--db-user': args.dbUser = next; i++; break;
      case '--api-key': args.apiKey = next; i++; break;
      case '--include-portal': args.includePortal = true; break;
      case '--batch-size': args.batchSize = parseInt(next, 10); i++; break;
      case '--dry-run': args.dryRun = true; break;
    }
  }
  return args;
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  async sync(args) {
    const apiKey = args.apiKey || process.env.SAASY_APP_API_KEY;
    if (!apiKey && !args.dryRun) {
      console.error('[FATAL] Cle API requise : --api-key sk_xxx ou SAASY_APP_API_KEY');
      process.exit(1);
    }
    await syncUsers({
      odooContainer: args.odooContainer || 'odoo',
      dbContainer: args.dbContainer,
      dbName: args.dbName,
      dbUser: args.dbUser,
      apiKey: apiKey || '',
      includePortal: args.includePortal,
      batchSize: args.batchSize,
      dryRun: args.dryRun,
    });
  },
};

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    console.error('Usage: saasy-odoo-agent users <command> [options]');
    console.error('Commandes: ' + Object.keys(COMMANDS).join(', '));
    process.exit(1);
  }
  await handler(parseArgs(rest));
}
