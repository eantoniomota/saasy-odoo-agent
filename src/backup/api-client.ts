/**
 * Client HTTP pour l'API publique des backups Saasy.
 * Auth: header X-API-Key (scope: infrastructure).
 *
 * Endpoints utilises (hors transport metrics/logs):
 *   POST /api/infra/v1/backups/request-upload
 *   POST /api/infra/v1/backups/:id/confirm
 *   DELETE /api/infra/v1/backups/:id
 */
import { config } from '../config';

const BASE_URL = `${config.apiUrl}/api/infra/v1`;

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-API-Key': config.apiKey,
};

const FETCH_TIMEOUT_MS = 30_000;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: HEADERS,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string };

  if (!res.ok || data.success === false) {
    const msg = data.error || `${res.status} ${res.statusText}`;
    throw new Error(`Saasy API ${method} ${path} a echoue: ${msg}`);
  }

  return data.data as T;
}

export interface RequestUploadInput {
  filename: string;
  name?: string;
  serverId?: string;
  serverName?: string;
  description?: string;
  tags?: string[];
  mimeType?: string;
}

export interface BackupRecord {
  id: string;
  appId: string;
  name?: string;
  filename: string;
  s3Key: string;
  s3Bucket: string;
  status: 'pending' | 'completed' | 'failed' | 'expired';
  tags: string[];
  createdAt: string;
}

export interface RequestUploadResponse {
  backup: BackupRecord;
  uploadUrl: string;
  expiresAt: string;
}

export function requestUpload(input: RequestUploadInput): Promise<RequestUploadResponse> {
  return request<RequestUploadResponse>('POST', '/backups/request-upload', input);
}

export function confirmUpload(backupId: string, checksum?: string): Promise<BackupRecord> {
  return request<BackupRecord>('POST', `/backups/${backupId}/confirm`, { checksum });
}

export function deleteBackup(backupId: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>('DELETE', `/backups/${backupId}`);
}
