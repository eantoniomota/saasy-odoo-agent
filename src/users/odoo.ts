/**
 * Synchronisation des utilisateurs Odoo vers Saasy.
 *
 * Lit les utilisateurs directement dans PostgreSQL (container DB auto-detecte
 * depuis odoo.conf, comme le module backup) et les pousse vers l'endpoint
 * public `POST /api/v1/tracked-users/bulk` (cle API app `sk_...`, permission
 * tracked_users:write).
 *
 * Le payload de chaque utilisateur est identique a celui du JWT SSO genere
 * par le module Odoo `saasy` (id = str(user.id), email = email or login,
 * companies = [{name, externalId: str(company_id)}]) afin que l'import
 * fusionne avec les utilisateurs crees au login, et inversement.
 */
import { execSync } from 'child_process';

export interface SyncUsersOptions {
  odooContainer: string;
  dbContainer?: string;       // defaut: auto-detecte depuis odoo.conf (db_host)
  dbName?: string;            // defaut: auto-detecte depuis odoo.conf, sinon "odoo"
  dbUser?: string;            // defaut: auto-detecte depuis odoo.conf, sinon "odoo"
  apiKey: string;             // cle API app sk_... (scope feedback, tracked_users:write)
  includePortal?: boolean;    // inclure les utilisateurs portail (share = true)
  batchSize?: number;         // defaut: 200
  dryRun?: boolean;           // liste sans envoyer
}

export interface OdooUserRow {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  company_id: number;
  company_name: string;
}

export interface SyncResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
}

function dockerExec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

function containerRunning(name: string): boolean {
  try {
    const out = dockerExec(`docker ps --filter name=^${name}$ --format "{{.Names}}"`);
    return out === name;
  } catch {
    return false;
  }
}

function readOdooConf(odooContainer: string): Partial<Record<'db_host' | 'db_user' | 'db_name', string>> {
  try {
    const conf = dockerExec(`docker exec ${odooContainer} cat /etc/odoo/odoo.conf`);
    const result: Record<string, string> = {};
    for (const line of conf.split('\n')) {
      const m = line.match(/^\s*(db_host|db_user|db_name)\s*=\s*(.+?)\s*$/);
      if (m) result[m[1]] = m[2];
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Lit tous les utilisateurs Odoo actifs depuis PostgreSQL.
 * Par defaut : utilisateurs internes uniquement (share = false), hors OdooBot.
 */
export function fetchOdooUsers(opts: SyncUsersOptions): { users: OdooUserRow[]; dbName: string } {
  if (!containerRunning(opts.odooContainer)) {
    throw new Error(
      `Le container Odoo "${opts.odooContainer}" n'est pas en cours d'execution. ` +
      `Lance-le, ou passe --odoo-container <nom> avec le bon nom.`,
    );
  }

  const conf = readOdooConf(opts.odooContainer);
  const dbContainer = opts.dbContainer || conf.db_host;
  if (!dbContainer || dbContainer === 'localhost' || dbContainer === '127.0.0.1' || dbContainer === 'False') {
    throw new Error(
      `Impossible de determiner le container PostgreSQL. ` +
      `db_host dans odoo.conf vaut "${conf.db_host || '(absent)'}". ` +
      `Passe --db-container <nom> explicitement.`,
    );
  }
  if (!containerRunning(dbContainer)) {
    throw new Error(`Le container PostgreSQL "${dbContainer}" n'est pas en cours d'execution.`);
  }

  const dbName = opts.dbName || conf.db_name || 'odoo';
  const dbUser = opts.dbUser || conf.db_user || 'odoo';

  const shareFilter = opts.includePortal ? '' : 'AND u.share = false';
  const sql =
    `SELECT COALESCE(json_agg(t), '[]') FROM (` +
    `SELECT u.id, u.login, p.name, p.email, u.company_id, c.name AS company_name ` +
    `FROM res_users u ` +
    `JOIN res_partner p ON p.id = u.partner_id ` +
    `JOIN res_company c ON c.id = u.company_id ` +
    `WHERE u.active = true ${shareFilter} AND u.id != 1 ` +
    `ORDER BY u.id) t`;

  const out = dockerExec(
    `docker exec ${dbContainer} psql -U ${dbUser} -d ${dbName} -t -A -c "${sql.replace(/"/g, '\\"')}"`,
  );
  return { users: JSON.parse(out) as OdooUserRow[], dbName };
}

/** Construit le payload bulk au meme format que le JWT SSO du module Odoo. */
export function toBulkPayload(rows: OdooUserRow[]): Array<Record<string, unknown>> {
  return rows.map((u) => ({
    id: String(u.id),
    email: u.email || u.login,
    name: u.name || u.login,
    companies: [{ name: u.company_name, externalId: String(u.company_id) }],
  }));
}

/** Pousse les utilisateurs vers l'API Saasy par batches. */
export async function syncUsers(opts: SyncUsersOptions): Promise<SyncResult> {
  const baseUrl = (process.env.SAASY_API_URL || 'https://api.saasy.fr').replace(/\/$/, '');
  const batchSize = opts.batchSize || 200;

  const { users, dbName } = fetchOdooUsers(opts);
  console.log(`[Users] ${users.length} utilisateur(s) Odoo trouve(s) dans "${dbName}"` +
    (opts.includePortal ? ' (internes + portail)' : ' (internes uniquement)'));

  const result: SyncResult = { total: users.length, created: 0, updated: 0, skipped: 0 };
  if (users.length === 0) return result;

  if (opts.dryRun) {
    for (const u of users) {
      console.log(`  - #${u.id} ${u.name || u.login} <${u.email || u.login}> (${u.company_name})`);
    }
    console.log('[Users] --dry-run : aucun envoi.');
    return result;
  }

  const payload = toBulkPayload(users);
  for (let i = 0; i < payload.length; i += batchSize) {
    const batch = payload.slice(i, i + batchSize);
    const res = await fetch(`${baseUrl}/api/v1/tracked-users/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': opts.apiKey },
      body: JSON.stringify({ users: batch }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status} sur le batch ${i / batchSize + 1} : ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: { created?: number; updated?: number; skipped?: number } };
    result.created += json.data?.created || 0;
    result.updated += json.data?.updated || 0;
    result.skipped += json.data?.skipped || 0;
    console.log(`[Users] Batch ${i / batchSize + 1} : ${batch.length} envoye(s)`);
  }

  console.log(`[Users] OK — ${result.created} cree(s), ${result.updated} mis a jour, ${result.skipped} ignore(s)`);
  return result;
}
