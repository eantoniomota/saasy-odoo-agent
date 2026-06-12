/**
 * HTTP server pour declencher des backups a distance via Saasy dashboard.
 *
 * Saasy fait : POST <webhookUrl>
 *   Headers: X-Backup-Secret: whsec_...
 *   Body:    {"appId":"...","action":"trigger-backup","timestamp":"...","name":"..."}
 *
 * On valide le secret, on lance backupOdoo() en arriere-plan, on repond 202.
 *
 * Le port est bind sur 127.0.0.1 (loopback uniquement) — l'expose se fait via
 * Nginx (proxy_pass) sur l'hote.
 */
import http from 'node:http';
import { config } from '../config';
import { backupOdoo } from '../backup/odoo';
import type { BackupRecord } from '../backup/api-client';
import { deployOdoo, type DeployResult } from '../deploy/odoo';
import { restoreOdoo, notifyRestoreStatus } from '../restore/odoo';

interface WebhookBody {
  appId?: string;
  action?: string;
  name?: string;
  timestamp?: string;
}

interface RestoreBody {
  action?: 'restore-backup' | string;
  restoreId?: string;
  appId?: string;
  branch?: string;
  backup?: {
    id?: string;
    filename?: string;
    downloadUrl?: string;
    sizeBytes?: number;
    checksum?: string;
    description?: string;
    serverName?: string;
  };
  timestamp?: string;
}

interface DeployBody {
  action?: 'deploy' | string;
  environment?: { id?: string; slug?: string; name?: string; branch?: string };
  branch?: string;
  sha?: string;
  message?: string;
  timestamp?: string;
}

function readBody(req: http.IncomingMessage): Promise<WebhookBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function handleTriggerBackup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Auth
  const providedSecret = req.headers['x-backup-secret'];
  if (!providedSecret || providedSecret !== config.webhookSecret) {
    send(res, 403, { error: 'Forbidden' });
    return;
  }

  // Config check
  if (!config.webhookEnvId) {
    send(res, 503, { error: 'WEBHOOK_ENV_ID non configure cote agent' });
    return;
  }

  // Body
  let body: WebhookBody = {};
  try {
    body = await readBody(req);
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
    return;
  }

  const name = body.name || `webhook-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;

  // Repond immediatement, lance le backup en arriere-plan
  send(res, 202, { ok: true, message: 'Backup started', name });

  console.log(`[Webhook] Backup declenche par Saasy : env=${config.webhookEnvId}, name="${name}"`);
  backupOdoo({
    environmentId: config.webhookEnvId,
    odooContainer: config.webhookOdooContainer,
    name,
  })
    .then((result: BackupRecord) => {
      console.log(`[Webhook] Backup termine : id=${result.id}, status=${result.status}`);
    })
    .catch((err: Error) => {
      console.error('[Webhook] Backup echoue :', err.message);
    });
}

/**
 * POST /trigger-deploy
 *
 * Recoit le webhook de Saasy quand l'utilisateur clique "Deployer ce commit"
 * (ou quand un push GitHub matche la branche de l'env). Body envoye par
 * Saasy (cf. GitHubDeploymentService.triggerDeployment) :
 *
 *   {
 *     "action": "deploy",
 *     "environment": {"id":"...","name":"production","slug":"production","branch":"main"},
 *     "branch": "main",
 *     "sha": "abcdef0...",
 *     "message": "feat: ...",
 *     "timestamp": "2026-..."
 *   }
 *
 * Auth : si DEPLOY_SECRET defini cote agent, requiert soit :
 *   - header X-Deploy-Secret: <secret>
 *   - query param ?secret=<secret>
 */
async function handleTriggerDeploy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (config.deploySecret) {
    const headerSecret = req.headers['x-deploy-secret'];
    let querySecret: string | null = null;
    try {
      const u = new URL(req.url || '', 'http://localhost');
      querySecret = u.searchParams.get('secret');
    } catch { /* ignore parsing error */ }
    const provided = headerSecret || querySecret;
    // DEPLOY_SECRET accepte une liste separee par virgules (un secret par env Saasy)
    const validSecrets = config.deploySecret.split(',').map((s) => s.trim()).filter(Boolean);
    if (!provided || !validSecrets.includes(provided as string)) {
      send(res, 403, { error: 'Forbidden' });
      return;
    }
  }

  let body: DeployBody = {};
  try {
    body = (await readBody(req)) as DeployBody;
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
    return;
  }

  const envSlug = body.environment?.slug;
  const branch = body.branch || body.environment?.branch || 'main';
  const sha = body.sha;
  const message = body.message;

  if (!envSlug) {
    send(res, 400, { error: 'environment.slug required' });
    return;
  }

  // Repond 202 immediatement, le deploy tourne en arriere-plan
  send(res, 202, {
    ok: true,
    message: 'Deploy started',
    envSlug,
    branch,
    sha: sha?.slice(0, 7),
  });

  console.log(`[Webhook] Deploy declenche par Saasy : env=${envSlug}, branch=${branch}, sha=${sha?.slice(0, 7) || '?'}`);

  deployOdoo({ envSlug, branch, sha, message })
    .then((result: DeployResult) => {
      console.log(
        `[Webhook] Deploy termine : ${result.oldSha.slice(0, 7)} → ${result.newSha.slice(0, 7)}, ` +
        `${result.filesChanged} files changed, skipped=${result.skipped}`,
      );
    })
    .catch((err: Error) => {
      console.error('[Webhook] Deploy echoue :', err.message);
    });
}

/**
 * POST /restore-backup
 *
 * Recoit le webhook de Saasy quand l'utilisateur clique "Restaurer". Body envoye
 * par Saasy (cf. InfraBackupService.restoreBackup) :
 *
 *   {
 *     "action": "restore-backup",
 *     "restoreId": "...",
 *     "appId": "...",
 *     "branch": "<cible>",
 *     "backup": {
 *       "id": "...",
 *       "filename": "odoo-...tar.gz",
 *       "downloadUrl": "https://s3...",
 *       "sizeBytes": 12345,
 *       "checksum": "..."
 *     },
 *     "timestamp": "..."
 *   }
 *
 * Auth via X-Backup-Secret (meme secret que /trigger-backup). On repond 202
 * immediatement et on lance la restauration en arriere-plan, puis on notifie
 * le statut via l'API publique Saasy (X-API-Key).
 */
async function handleRestoreBackup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const providedSecret = req.headers['x-backup-secret'];
  if (!providedSecret || providedSecret !== config.webhookSecret) {
    send(res, 403, { error: 'Forbidden' });
    return;
  }

  let body: RestoreBody = {};
  try {
    body = (await readBody(req)) as RestoreBody;
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
    return;
  }

  if (!body.restoreId || !body.appId || !body.backup?.downloadUrl) {
    send(res, 400, { error: 'Champs requis manquants : restoreId, appId, backup.downloadUrl' });
    return;
  }

  const restoreId = body.restoreId;
  const branch = body.branch || 'unknown';
  const filename = body.backup.filename || 'archive.tar.gz';
  const downloadUrl = body.backup.downloadUrl;

  // Repond 202 immediatement, la restauration tourne en arriere-plan
  send(res, 202, { ok: true, message: 'Restore started', restoreId, branch });

  console.log(`[Webhook] Restore declenche par Saasy : id=${restoreId}, branch=${branch}, file=${filename}`);

  restoreOdoo({
    restoreId,
    appId: body.appId,
    branch,
    odooContainer: config.webhookOdooContainer,
    downloadUrl,
    filename,
    expectedChecksum: body.backup.checksum,
  })
    .then(async (result) => {
      if (result.success) {
        console.log(`[Webhook] Restore termine OK en ${(result.durationMs / 1000).toFixed(1)}s`);
        await notifyRestoreStatus(restoreId, 'success');
      } else {
        console.error(`[Webhook] Restore echoue : ${result.error}`);
        await notifyRestoreStatus(restoreId, 'failed', result.error);
      }
    })
    .catch(async (err: Error) => {
      console.error('[Webhook] Restore echoue (exception) :', err.message);
      await notifyRestoreStatus(restoreId, 'failed', err.message);
    });
}

export function startWebhookServer(): http.Server | null {
  // Le server demarre si AU MOINS un des secrets est configure
  if (!config.webhookSecret && !config.deploySecret) {
    return null;
  }

  const server = http.createServer((req, res) => {
    // Routes (avec gestion query string pour /trigger-deploy?secret=...)
    const path = (req.url || '').split('?')[0];

    if (req.method === 'POST' && path === '/trigger-backup') {
      if (!config.webhookSecret) {
        send(res, 404, { error: 'Backup webhook desactive (WEBHOOK_SECRET non configure)' });
        return;
      }
      handleTriggerBackup(req, res).catch((err) => {
        console.error('[Webhook] Erreur handler backup :', err);
        send(res, 500, { error: 'Internal error' });
      });
      return;
    }
    if (req.method === 'POST' && path === '/trigger-deploy') {
      handleTriggerDeploy(req, res).catch((err) => {
        console.error('[Webhook] Erreur handler deploy :', err);
        send(res, 500, { error: 'Internal error' });
      });
      return;
    }
    if (req.method === 'POST' && path === '/restore-backup') {
      if (!config.webhookSecret) {
        send(res, 404, { error: 'Restore webhook desactive (WEBHOOK_SECRET non configure)' });
        return;
      }
      handleRestoreBackup(req, res).catch((err) => {
        console.error('[Webhook] Erreur handler restore :', err);
        send(res, 500, { error: 'Internal error' });
      });
      return;
    }
    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: 'Not Found' });
  });

  // Bind sur 0.0.0.0 cote container — l'isolation est garantie par
  // le -p 127.0.0.1:9090:9090 cote docker run (seul loopback hote y accede).
  // Bind sur 127.0.0.1 dans le container ne marche pas avec docker -p :
  // le port mapping route via 0.0.0.0 du container, pas son loopback interne.
  server.listen(config.webhookPort, '0.0.0.0', () => {
    const enabled: string[] = [];
    if (config.webhookSecret) {
      enabled.push(`/trigger-backup (env=${config.webhookEnvId || '?'})`);
      enabled.push(`/restore-backup`);
    }
    if (config.deploySecret) enabled.push(`/trigger-deploy`);
    console.log(`  Webhook    : http://0.0.0.0:${config.webhookPort} → ${enabled.join(', ') || '(aucun)'}`);
  });

  server.on('error', (err) => {
    console.error('[Webhook] Erreur server :', err);
  });

  return server;
}
