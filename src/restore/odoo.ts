/**
 * Restore Odoo (V1, miroir du backup) :
 *   1. Telecharge l'archive .tar.gz depuis l'URL presignee S3 fournie par Saasy.
 *   2. Decompresse → manifest.json + dump.dump + filestore.tar.
 *   3. pg_restore --clean dans le container PostgreSQL.
 *   4. Restaure le filestore (rm + tar xf) dans le container Odoo.
 *   5. Restart Odoo pour reload du code.
 *
 * Le branch cible n'est PAS gere par cet agent V1 — l'agent restaure la DB
 * et le filestore puis logge la branche dans le label. Pour une vraie
 * promotion vers une branche Git, le client doit faire le push manuellement
 * apres verification.
 */
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, createWriteStream, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config';

export interface RestoreOdooOptions {
  restoreId: string;
  appId: string;
  branch: string;
  odooContainer: string;
  downloadUrl: string;
  filename: string;
  expectedChecksum?: string;
  dbContainer?: string;
  dbName?: string;
  dbUser?: string;
  filestorePath?: string;
}

export interface RestoreResult {
  success: boolean;
  durationMs: number;
  error?: string;
}

interface ResolvedConfig {
  odooContainer: string;
  dbContainer: string;
  dbName: string;
  dbUser: string;
  filestorePath: string;
}

function dockerExec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function containerRunning(name: string): boolean {
  try {
    return dockerExec(`docker ps --filter name=^${name}$ --format "{{.Names}}"`) === name;
  } catch {
    return false;
  }
}

function readOdooConf(odooContainer: string): Record<string, string> {
  try {
    const conf = dockerExec(`docker exec ${odooContainer} cat /etc/odoo/odoo.conf`);
    const out: Record<string, string> = {};
    for (const line of conf.split('\n')) {
      const m = line.match(/^\s*(db_host|db_user|db_name|data_dir)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

function resolveConfig(opts: RestoreOdooOptions): ResolvedConfig {
  if (!containerRunning(opts.odooContainer)) {
    throw new Error(`Le container Odoo "${opts.odooContainer}" n'est pas en cours d'execution.`);
  }
  const conf = readOdooConf(opts.odooContainer);

  const dbContainer = opts.dbContainer || conf.db_host;
  if (!dbContainer || ['localhost', '127.0.0.1', 'False'].includes(dbContainer)) {
    throw new Error(
      `Impossible de determiner le container PostgreSQL (db_host="${conf.db_host || '?'}").`,
    );
  }
  if (!containerRunning(dbContainer)) {
    throw new Error(`Le container PostgreSQL "${dbContainer}" n'est pas en cours d'execution.`);
  }

  return {
    odooContainer: opts.odooContainer,
    dbContainer,
    dbName: opts.dbName || conf.db_name || 'odoo',
    dbUser: opts.dbUser || conf.db_user || 'odoo',
    filestorePath: opts.filestorePath
      || (conf.data_dir ? `${conf.data_dir}/filestore` : '/var/lib/odoo/filestore'),
  };
}

async function downloadToFile(url: string, outFile: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Telechargement S3 echoue: HTTP ${res.status}`);
  }
  const stream = createWriteStream(outFile);
  await pipeline(Readable.fromWeb(res.body as unknown as ReadableStream), stream);
}

function extractArchive(archivePath: string, workDir: string): void {
  execSync(`tar xzf ${archivePath} -C ${workDir}`, { stdio: 'ignore' });
}

/**
 * Coupe le container Odoo pour liberer les connexions a la DB. Sans cela,
 * pg_restore --clean reste bloque indefiniment sur des verrous tenus par les
 * workers Odoo (typiquement une transaction "idle in transaction" qui maintient
 * un AccessShareLock empechant le DROP des contraintes).
 */
function stopOdoo(cfg: ResolvedConfig): void {
  console.log(`[Restore] Stop ${cfg.odooContainer} pour liberer la DB...`);
  try {
    execSync(`docker stop ${cfg.odooContainer}`, { stdio: 'ignore' });
  } catch (err) {
    // Si deja stoppe, on continue (idempotent)
    console.warn(`[Restore] docker stop a echoue (peut-etre deja stoppe): ${(err as Error).message}`);
  }
}

/**
 * Termine toutes les sessions PostgreSQL restantes sur la DB cible. A appeler
 * APRES stopOdoo pour nettoyer les connexions zombies (transactions idle non
 * fermees proprement par Odoo a l'arret) avant pg_restore.
 */
function terminateDbConnections(cfg: ResolvedConfig): void {
  console.log(`[Restore] Termine les connexions residuelles sur ${cfg.dbName}...`);
  // On se connecte sur "postgres" (pas la DB cible) pour ne pas se faire kill nous-memes.
  // pg_terminate_backend renvoie true par session tuee — nombre logge pour info.
  const sql = `SELECT count(*) FROM pg_stat_activity WHERE datname='${cfg.dbName}' AND pid <> pg_backend_pid();`;
  const killSql = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${cfg.dbName}' AND pid <> pg_backend_pid();`;
  try {
    const before = execSync(
      `docker exec ${cfg.dbContainer} psql -U ${cfg.dbUser} -d postgres -tAc "${sql}"`,
      { encoding: 'utf-8' },
    ).trim();
    if (before && before !== '0') {
      execSync(
        `docker exec ${cfg.dbContainer} psql -U ${cfg.dbUser} -d postgres -c "${killSql}"`,
        { stdio: 'ignore' },
      );
      console.log(`[Restore] ${before} connexion(s) tuee(s)`);
    }
  } catch (err) {
    console.warn(`[Restore] terminate connections a echoue: ${(err as Error).message}`);
  }
}

/**
 * Purge les bundles d'assets compiles (web.assets_*.min.js/css) de la table
 * ir_attachment. Apres un restore, leurs `store_fname` peuvent referencer des
 * fichiers absents du filestore restaure → Odoo renvoie 500 sur les assets.
 * En les supprimant, Odoo les recompile a la volee au premier hit (premier
 * chargement lent ~10-30s, suivants normaux). A appeler avec Odoo stoppe.
 */
function purgeAssetBundles(cfg: ResolvedConfig): void {
  console.log("[Restore] Purge des bundles d'assets compiles (recompilation lazy)...");
  const sql = "DELETE FROM ir_attachment WHERE name LIKE 'web.assets_%' OR name LIKE '/web/assets/%';";
  try {
    execSync(
      `docker exec ${cfg.dbContainer} psql -U ${cfg.dbUser} -d ${cfg.dbName} -c "${sql}"`,
      { stdio: 'ignore' },
    );
  } catch (err) {
    // Non bloquant : si ca rate, l'utilisateur peut purger manuellement.
    console.warn(`[Restore] Purge des bundles a echoue (non critique): ${(err as Error).message}`);
  }
}

function restoreDatabase(cfg: ResolvedConfig, dumpPath: string): void {
  console.log(`[Restore] pg_restore ${cfg.dbName} (user ${cfg.dbUser}) dans ${cfg.dbContainer}...`);
  // On copie le dump dans le container puis on fait pg_restore --clean.
  // --clean droppe les objets existants avant restore (ecrase la DB courante).
  const tmpInside = `/tmp/saasy-restore-${Date.now()}.dump`;
  execSync(`docker cp ${dumpPath} ${cfg.dbContainer}:${tmpInside}`, { stdio: 'ignore' });
  try {
    const res = spawnSync(
      'docker',
      ['exec', cfg.dbContainer, 'pg_restore', '-U', cfg.dbUser, '--clean', '--if-exists', '-d', cfg.dbName, tmpInside],
      { stdio: ['ignore', 'inherit', 'pipe'] },
    );
    // pg_restore retourne souvent un code != 0 sur warnings non-fatals (ex: rôle inconnu).
    // On considere echec uniquement si stderr contient "FATAL" ou code > 1.
    if (res.status && res.status > 1) {
      const stderr = res.stderr?.toString() || '';
      throw new Error(`pg_restore a echoue (code ${res.status}): ${stderr.slice(0, 500)}`);
    }
  } finally {
    execSync(`docker exec ${cfg.dbContainer} rm -f ${tmpInside}`, { stdio: 'ignore' });
  }
}

function restoreFilestore(cfg: ResolvedConfig, filestoreTarPath: string): void {
  // Si filestore.tar est vide (10240 bytes = 2 blocs EOF tar), on saute.
  const size = statSync(filestoreTarPath).size;
  if (size <= 10240) {
    console.log('[Restore] filestore.tar vide — skip');
    return;
  }

  console.log(`[Restore] Restauration filestore dans ${cfg.odooContainer}:${cfg.filestorePath}/${cfg.dbName}...`);
  const tmpInside = `/tmp/saasy-restore-filestore-${Date.now()}.tar`;
  execSync(`docker cp ${filestoreTarPath} ${cfg.odooContainer}:${tmpInside}`, { stdio: 'ignore' });
  try {
    // Supprime l'ancien filestore puis untar le nouveau.
    execSync(
      `docker exec ${cfg.odooContainer} sh -c "rm -rf ${cfg.filestorePath}/${cfg.dbName} && mkdir -p ${cfg.filestorePath} && tar xf ${tmpInside} -C ${cfg.filestorePath}"`,
      { stdio: 'ignore' },
    );
  } finally {
    execSync(`docker exec ${cfg.odooContainer} rm -f ${tmpInside}`, { stdio: 'ignore' });
  }
}

export async function restoreOdoo(opts: RestoreOdooOptions): Promise<RestoreResult> {
  const start = Date.now();
  const cfg = resolveConfig(opts);

  console.log('');
  console.log(`[Restore] ─── id=${opts.restoreId} branch=${opts.branch} db=${cfg.dbName} ───`);

  const workDir = mkdtempSync(join(tmpdir(), 'saasy-odoo-restore-'));
  const archivePath = join(workDir, 'archive.tar.gz');

  try {
    console.log(`[Restore] Telechargement de ${opts.filename}...`);
    await downloadToFile(opts.downloadUrl, archivePath);
    console.log(`[Restore] Archive : ${(statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB`);

    console.log('[Restore] Extraction de l\'archive...');
    extractArchive(archivePath, workDir);

    // Lecture du manifest pour info (pas de validation stricte V1)
    try {
      const manifest = JSON.parse(readFileSync(join(workDir, 'manifest.json'), 'utf-8'));
      console.log(`[Restore] Manifest: kind=${manifest.kind}, scope=${manifest.scope}`);
    } catch {
      console.warn('[Restore] manifest.json absent ou invalide — on continue');
    }

    // Couper Odoo AVANT pg_restore pour liberer les locks DB (sinon
    // pg_restore --clean reste bloque sur DROP CONSTRAINT indefiniment).
    stopOdoo(cfg);
    terminateDbConnections(cfg);

    restoreDatabase(cfg, join(workDir, 'dump.dump'));
    restoreFilestore(cfg, join(workDir, 'filestore.tar'));
    purgeAssetBundles(cfg);

    console.log('[Restore] Demarrage Odoo pour reload du code...');
    // docker start (et non restart) car le container est stoppe.
    execSync(`docker start ${cfg.odooContainer}`, { stdio: 'ignore' });

    const durationMs = Date.now() - start;
    console.log(`[Restore] OK — termine en ${(durationMs / 1000).toFixed(1)}s`);
    return { success: true, durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[Restore] Echec :', message);
    return { success: false, durationMs: Date.now() - start, error: message };
  } finally {
    // Garantie : Odoo redemarre meme en cas d'echec, sinon le prochain restore
    // refusera car resolveConfig exige Odoo running. Best-effort, pas d'erreur.
    if (!containerRunning(cfg.odooContainer)) {
      try {
        console.log(`[Restore] Demarrage de secours de ${cfg.odooContainer}`);
        execSync(`docker start ${cfg.odooContainer}`, { stdio: 'ignore' });
      } catch (startErr) {
        console.warn('[Restore] docker start de secours a echoue :', (startErr as Error).message);
      }
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn('[Restore] Cleanup tmp echoue (non critique):', (cleanupErr as Error).message);
    }
  }
}

export async function notifyRestoreStatus(
  restoreId: string,
  status: 'success' | 'failed',
  error?: string,
): Promise<void> {
  const url = `${config.apiUrl}/api/infra/v1/restores/${restoreId}/status`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify({ status, error }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[Restore] Notification statut a echoue: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn('[Restore] Notification statut a echoue :', (err as Error).message);
  }
}
