/**
 * Upload streame d'un fichier local vers une URL S3 presignee (PUT).
 *
 * Le Content-Type doit matcher exactement celui passe a la generation
 * de la presigned URL (cote API Saasy : input.mimeType || 'application/octet-stream').
 */
import { createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export interface UploadResult {
  sizeBytes: number;
  checksum: string;
}

/**
 * Calcule le SHA256 du fichier en streaming (pas de buffer complet en RAM).
 */
async function computeChecksum(filepath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filepath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function uploadFileToS3(
  filepath: string,
  uploadUrl: string,
  contentType: string,
): Promise<UploadResult> {
  const sizeBytes = statSync(filepath).size;
  const checksum = await computeChecksum(filepath);

  // duplex: 'half' est requis par undici (Node fetch) pour les bodies streames.
  // Cast en any : tsconfig n'inclut pas DOM lib, donc BodyInit n'est pas typed,
  // et duplex n'est pas non plus dans les types Node.
  const body = Readable.toWeb(createReadStream(filepath));
  const init: Record<string, unknown> = {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(sizeBytes),
    },
    body,
    duplex: 'half',
  };

  const res = await fetch(uploadUrl, init as Parameters<typeof fetch>[1]);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload S3 echoue: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }

  return { sizeBytes, checksum };
}
