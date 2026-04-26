/**
 * Backup Odoo (V1, scenario Docker) :
 *   - PostgreSQL dans un container Docker (auto-detecte depuis odoo.conf).
 *   - Filestore dans le container Odoo (auto-detecte depuis odoo.conf, defaut /var/lib/odoo/filestore).
 *
 * Produit une seule archive .tar.gz contenant :
 *   - manifest.json (metadonnees)
 *   - dump.dump    (pg_dump format custom -Fc)
 *   - filestore.tar (contenu du filestore de la DB)
 *
 * Limites V1 :
 *   - PostgreSQL doit tourner dans un container Docker accessible localement.
 *   - Le container Odoo doit tourner pour lire odoo.conf et tar le filestore.
 */
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, statSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../config';
import * as api from './api-client';
import { uploadFileToS3 } from './s3-upload';

export interface BackupOdooOptions {
  environmentId: string;
  odooContainer: string;     // defaut: "odoo"
  dbContainer?: string;       // defaut: auto-detecte depuis odoo.conf (db_host)
  dbName?: string;            // defaut: auto-detecte depuis odoo.conf, sinon "odoo"
  dbUser?: string;            // defaut: auto-detecte depuis odoo.conf, sinon "odoo"
  filestorePath?: string;     // defaut: auto-detecte, sinon /var/lib/odoo/filestore
  name?: string;              // label affiche dans le dashboard Saasy
}

interface ResolvedConfig {
  odooContainer: string;
  dbContainer: string;
  dbName: string;
  dbUser: string;
  filestorePath: string;
  odooVersion: string;
}

function dockerExec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function containerRunning(name: string): boolean {
  try {
    const out = dockerExec(`docker ps --filter name=^${name}$ --format "{{.Names}}"`);
    return out === name;
  } catch {
    return false;
  }
}

/**
 * Lit /etc/odoo/odoo.conf depuis le container Odoo et extrait db_host, db_user, db_name.
 * Retourne {} si la lecture echoue (Odoo non lance, pas de fichier, etc.).
 */
function readOdooConf(odooContainer: string): Partial<Record<'db_host' | 'db_user' | 'db_name' | 'data_dir', string>> {
  try {
    const conf = dockerExec(`docker exec ${odooContainer} cat /etc/odoo/odoo.conf`);
    const result: Record<string, string> = {};
    for (const line of conf.split('\n')) {
      const m = line.match(/^\s*(db_host|db_user|db_name|data_dir)\s*=\s*(.+?)\s*$/);
      if (m) result[m[1]] = m[2];
    }
    return result;
  } catch {
    return {};
  }
}

function detectOdooVersion(odooContainer: string): string {
  try {
    return dockerExec(`docker inspect ${odooContainer} --format '{{.Config.Image}}'`).split(':')[1] || 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveConfig(opts: BackupOdooOptions): ResolvedConfig {
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
    throw new Error(
      `Le container PostgreSQL "${dbContainer}" n'est pas en cours d'execution. ` +
      `Lance-le, ou passe --db-container <nom> avec le bon nom.`,
    );
  }

  const dbName = opts.dbName || conf.db_name || 'odoo';
  const dbUser = opts.dbUser || conf.db_user || 'odoo';
  // data_dir d'Odoo contient filestore/<dbname> ; on conserve le parent pour tar -C.
  const filestoreParent = opts.filestorePath
    || (conf.data_dir ? `${conf.data_dir}/filestore` : '/var/lib/odoo/filestore');

  return {
    odooContainer: opts.odooContainer,
    dbContainer,
    dbName,
    dbUser,
    filestorePath: filestoreParent,
    odooVersion: detectOdooVersion(opts.odooContainer),
  };
}

/**
 * Execute `docker exec` en redirigeant stdout vers un fichier local.
 * Utilise spawnSync pour eviter de buffer plusieurs Go en RAM (cas filestore).
 */
function dockerExecToFile(args: string[], outFile: string): void {
  const fd = openSync(outFile, 'w');
  try {
    const res = spawnSync('docker', args, { stdio: ['ignore', fd, 'pipe'] });
    if (res.status !== 0) {
      const stderr = res.stderr?.toString() || '';
      throw new Error(`docker ${args.join(' ')} a echoue (code ${res.status}): ${stderr.slice(0, 500)}`);
    }
  } finally {
    closeSync(fd);
  }
}

function dumpDatabase(cfg: ResolvedConfig, outFile: string): void {
  console.log(`[Backup] pg_dump ${cfg.dbName} (user ${cfg.dbUser}) depuis ${cfg.dbContainer}...`);
  dockerExecToFile(
    ['exec', cfg.dbContainer, 'pg_dump', '-U', cfg.dbUser, '-Fc', cfg.dbName],
    outFile,
  );
  const size = statSync(outFile).size;
  console.log(`[Backup] dump.dump : ${(size / 1024 / 1024).toFixed(1)} MB`);
}

function tarFilestore(cfg: ResolvedConfig, outFile: string): void {
  console.log(`[Backup] tar filestore ${cfg.filestorePath}/${cfg.dbName} depuis ${cfg.odooContainer}...`);
  // Le sous-dossier <dbname> peut ne pas exister si la DB est vierge : on tar
  // depuis le parent et on ignore l'erreur "file not found" en testant avant.
  const exists = (() => {
    try {
      execSync(
        `docker exec ${cfg.odooContainer} test -d ${cfg.filestorePath}/${cfg.dbName}`,
        { stdio: 'ignore' },
      );
      return true;
    } catch {
      return false;
    }
  })();

  if (!exists) {
    console.warn(`[Backup] Filestore ${cfg.filestorePath}/${cfg.dbName} absent — archive vide.`);
    // Tar vide pour preserver la structure attendue
    execSync(`tar cf ${outFile} -T /dev/null`);
    return;
  }

  dockerExecToFile(
    ['exec', cfg.odooContainer, 'tar', 'cf', '-', '-C', cfg.filestorePath, cfg.dbName],
    outFile,
  );
  const size = statSync(outFile).size;
  console.log(`[Backup] filestore.tar : ${(size / 1024 / 1024).toFixed(1)} MB`);
}

function writeManifest(workDir: string, cfg: ResolvedConfig): void {
  const manifest = {
    saasy_backup_version: '1',
    kind: 'odoo',
    scope: 'db-filestore',
    created_at: new Date().toISOString(),
    odoo: {
      version: cfg.odooVersion,
      container: cfg.odooContainer,
      db_container: cfg.dbContainer,
      db_name: cfg.dbName,
      db_user: cfg.dbUser,
      filestore_path: cfg.filestorePath,
    },
    files: {
      dump: 'dump.dump',
      filestore: 'filestore.tar',
    },
  };
  writeFileSync(join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

export async function backupOdoo(opts: BackupOdooOptions): Promise<api.BackupRecord> {
  const cfg = resolveConfig(opts);

  console.log(`[Backup] Odoo ${cfg.odooVersion} | DB ${cfg.dbName} | container ${cfg.odooContainer}`);

  const workDir = mkdtempSync(join(tmpdir(), 'saasy-odoo-backup-'));

  try {
    // 1. Generation des fichiers a archiver
    dumpDatabase(cfg, join(workDir, 'dump.dump'));
    tarFilestore(cfg, join(workDir, 'filestore.tar'));
    writeManifest(workDir, cfg);

    // 2. Archive finale
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `odoo-${cfg.dbName}-${ts}.tar.gz`;
    const archivePath = join(workDir, archiveName);
    console.log(`[Backup] Compression ${archiveName}...`);
    execSync(
      `tar czf ${archivePath} -C ${workDir} manifest.json dump.dump filestore.tar`,
      { stdio: 'ignore' },
    );
    const archiveSize = statSync(archivePath).size;
    console.log(`[Backup] Archive : ${(archiveSize / 1024 / 1024).toFixed(1)} MB`);

    // 3. Demande d'upload a Saasy
    console.log('[Backup] Demande d\'URL d\'upload a Saasy...');
    const { backup, uploadUrl } = await api.requestUpload({
      filename: archiveName,
      name: opts.name,
      serverId: config.serverId,
      serverName: cfg.odooContainer,
      description: `Backup Odoo ${cfg.odooVersion} (DB: ${cfg.dbName}, scope: db-filestore)`,
      tags: ['odoo', `v${cfg.odooVersion}`, 'db-filestore', `env:${opts.environmentId}`],
      mimeType: 'application/gzip',
    });

    // 4. Upload streame vers S3
    console.log(`[Backup] Upload vers S3 (backup id: ${backup.id})...`);
    const { sizeBytes, checksum } = await uploadFileToS3(archivePath, uploadUrl, 'application/gzip');

    // 5. Confirmation cote Saasy (declenche la verification HEAD S3 + retention)
    console.log(`[Backup] Confirmation (sha256: ${checksum.slice(0, 12)}..., ${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
    const confirmed = await api.confirmUpload(backup.id, checksum);

    console.log(`[Backup] OK — backup ${confirmed.id} en statut "${confirmed.status}"`);
    return confirmed;
  } catch (err) {
    console.error('[Backup] Echec :', (err as Error).message);
    throw err;
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn('[Backup] Cleanup tmp echoue (non critique):', (cleanupErr as Error).message);
    }
  }
}
