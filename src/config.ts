import os from 'os';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[FATAL] Variable d'environnement manquante : ${name}`);
    process.exit(1);
  }
  return value;
}

function parseInterval(envVar: string, defaultSec: number, minSec: number): number {
  const raw = parseInt(process.env[envVar] || String(defaultSec), 10);
  const seconds = Number.isFinite(raw) && raw >= minSec ? raw : defaultSec;
  return seconds * 1000;
}

const apiUrl = requireEnv('SAASY_API_URL').replace(/\/$/, '');

// Allow http only for localhost/127.0.0.1 (dev), require https otherwise
const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl);
if (!isLocalDev && !apiUrl.startsWith('https://')) {
  console.error('[FATAL] SAASY_API_URL doit utiliser HTTPS (sauf localhost pour le dev)');
  process.exit(1);
}

export const config = Object.freeze({
  // Required
  apiUrl,
  apiKey: requireEnv('SAASY_AGENT_KEY'),
  serverId: requireEnv('SAASY_SERVER_ID'),

  // Collection — enforce minimum intervals to prevent CPU spin
  collectInterval: parseInterval('COLLECT_INTERVAL', 30, 5),
  logFlushInterval: parseInterval('LOG_FLUSH_INTERVAL', 10, 3),
  heartbeatInterval: parseInterval('HEARTBEAT_INTERVAL', 60, 10),

  // Docker
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  logContainers: process.env.LOG_CONTAINERS
    ? process.env.LOG_CONTAINERS.split(',').map((c) => c.trim()).filter(Boolean)
    : [] as string[],

  // Agent
  hostname: process.env.AGENT_HOSTNAME || os.hostname(),
  version: '1.0.0',

  // Webhook server (optionnel, pour declenchement de backup a distance via Saasy dashboard)
  // Active uniquement si WEBHOOK_SECRET est defini.
  // Le port est bind sur 127.0.0.1 — l'access se fait via Nginx (proxy HTTPS).
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  webhookEnvId: process.env.WEBHOOK_ENV_ID || '',
  webhookPort: parseInt(process.env.WEBHOOK_PORT || '9090', 10),
  webhookOdooContainer: process.env.WEBHOOK_ODOO_CONTAINER || 'odoo',

  // Deploy (declenchement Saasy → agent → git pull + odoo update + restart)
  //
  // L'agent clone et tient a jour un repo Git du client (ses addons custom
  // Odoo). DEPLOY_GITHUB_REPO definit ce repo (format "owner/repo").
  // Si le repo est prive, fournir DEPLOY_GITHUB_TOKEN (PAT GitHub).
  //
  // Le repo est clone dans :
  //   <DEPLOY_BASE_PATH>/<env-slug>/<repo-name>
  // ou repo-name est le dernier segment de DEPLOY_GITHUB_REPO.
  // Ex: DEPLOY_GITHUB_REPO=acme/odoo-stack → /host/deployments/production/odoo-stack
  deployBasePath: process.env.DEPLOY_BASE_PATH || '/host/deployments',
  deployGithubRepo: process.env.DEPLOY_GITHUB_REPO || '',  // owner/repo
  deployGithubToken: process.env.DEPLOY_GITHUB_TOKEN || '', // PAT pour repos prives
  // Secret pour authentifier le webhook deploy. Saasy l'envoie dans
  // le header X-Deploy-Secret (auto-genere par env cote Saasy).
  deploySecret: process.env.DEPLOY_SECRET || '',
});
