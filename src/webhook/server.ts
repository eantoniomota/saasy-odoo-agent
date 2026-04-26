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

interface WebhookBody {
  appId?: string;
  action?: string;
  name?: string;
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

export function startWebhookServer(): http.Server | null {
  if (!config.webhookSecret) {
    return null;
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/trigger-backup') {
      handleTriggerBackup(req, res).catch((err) => {
        console.error('[Webhook] Erreur handler :', err);
        send(res, 500, { error: 'Internal error' });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: 'Not Found' });
  });

  // Bind sur 127.0.0.1 uniquement — l'acces externe passe par Nginx
  server.listen(config.webhookPort, '127.0.0.1', () => {
    console.log(`  Webhook    : http://127.0.0.1:${config.webhookPort}/trigger-backup (env=${config.webhookEnvId || '(non configure)'})`);
  });

  server.on('error', (err) => {
    console.error('[Webhook] Erreur server :', err);
  });

  return server;
}
