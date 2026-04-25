import { gzipSync } from 'node:zlib';
import { config } from '../config';

const BASE_URL = `${config.apiUrl}/api/infra/v1/agent`;
const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Content-Encoding': 'gzip',
  'X-API-Key': config.apiKey,
};

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithRetry(url: string, body: unknown, retries = MAX_RETRIES): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const jsonBody = JSON.stringify(body);
      const compressedBody = gzipSync(jsonBody);

      const res = await fetch(url, {
        method: 'POST',
        headers: HEADERS,
        body: compressedBody,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) return true;

      // Don't retry client errors (4xx) except 429
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const data = await res.json().catch(() => ({}));
        console.error(`[API] ${res.status} ${url}: ${JSON.stringify(data)}`);
        return false;
      }

      // Rate limited or server error — retry with backoff
      if (attempt < retries) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`[API] ${res.status} — retry ${attempt + 1}/${retries} dans ${backoff}ms`);
        await sleep(backoff);
      }
    } catch (err) {
      if (attempt < retries) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`[API] Erreur réseau — retry ${attempt + 1}/${retries} dans ${backoff}ms`);
        await sleep(backoff);
      } else {
        console.error(`[API] Echec après ${retries} tentatives:`, (err as Error).message);
      }
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface MetricsPayload {
  serverId: string;
  timestamp: string;
  cpu: number;
  ram: number;
  disk?: number;
  netIn?: number;
  netOut?: number;
  containers?: Array<{
    name: string;
    image?: string;
    state?: string;
    cpu: number;
    ram: number;
    ramLimit?: number;
    netIn?: number;
    netOut?: number;
  }>;
}

export async function sendMetrics(payload: MetricsPayload): Promise<boolean> {
  return fetchWithRetry(`${BASE_URL}/metrics`, payload);
}

export interface LogEntry {
  container: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

export async function sendLogs(serverId: string, entries: LogEntry[]): Promise<boolean> {
  if (entries.length === 0) return true;
  return fetchWithRetry(`${BASE_URL}/logs`, { serverId, entries });
}

export interface HeartbeatPayload {
  serverId: string;
  version: string;
  hostname: string;
  uptime: number;
  containers?: string[];
}

export async function sendHeartbeat(payload: HeartbeatPayload): Promise<boolean> {
  return fetchWithRetry(`${BASE_URL}/heartbeat`, payload);
}

export interface JupyterStatusPayload {
  environmentId: string;
  status: 'not_installed' | 'installing' | 'running' | 'stopped' | 'error';
  version?: string;
  kernels?: string[];
  adminToken?: string;
  error?: string;
}

export async function sendJupyterStatus(payload: JupyterStatusPayload): Promise<boolean> {
  return fetchWithRetry(`${BASE_URL}/jupyter/status`, payload);
}
