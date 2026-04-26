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

interface WebhookBody {
  appId?: string;
  action?: string;
  name?: string;
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
    if (provided !== config.deploySecret) {
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
    if (config.webhookSecret) enabled.push(`/trigger-backup (env=${config.webhookEnvId || '?'})`);
    if (config.deploySecret) enabled.push(`/trigger-deploy`);
    console.log(`  Webhook    : http://0.0.0.0:${config.webhookPort} → ${enabled.join(', ') || '(aucun)'}`);
  });

  server.on('error', (err) => {
    console.error('[Webhook] Erreur server :', err);
  });

  return server;
}
