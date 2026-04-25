import Docker from 'dockerode';
import { config } from '../config';
import type { LogEntry } from '../transport/api';

let docker: Docker | null = null;

function getDocker(): Docker {
  if (!docker) {
    docker = new Docker({ socketPath: config.dockerSocket });
  }
  return docker;
}

// ── Container Stats ─────────────────────────────────────────────────────────

export interface ContainerStats {
  name: string;
  image: string;
  state: string;
  cpu: number;
  ram: number;
  ramLimit: number;
  netIn: number;
  netOut: number;
}

function calculateCpuPercent(stats: Docker.ContainerStats): number {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats?.system_cpu_usage || 0);
  const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;

  if (systemDelta <= 0 || cpuDelta < 0) return 0;
  return Math.round((cpuDelta / systemDelta) * numCpus * 10000) / 100;
}

export async function collectContainerStats(): Promise<ContainerStats[]> {
  try {
    const d = getDocker();
    const containers = await d.listContainers({ all: false });

    const results: ContainerStats[] = [];

    for (const containerInfo of containers) {
      const name = (containerInfo.Names[0] || '').replace(/^\//, '');

      // Filter by container names if specified
      if (config.logContainers.length > 0 && !config.logContainers.includes(name)) {
        continue;
      }

      try {
        const container = d.getContainer(containerInfo.Id);
        const stats = await container.stats({ stream: false }) as Docker.ContainerStats;

        const memUsage = stats.memory_stats?.usage || 0;
        const memLimit = stats.memory_stats?.limit || 0;
        const ramPercent = memLimit > 0 ? Math.round((memUsage / memLimit) * 10000) / 100 : 0;

        let netIn = 0;
        let netOut = 0;
        if (stats.networks) {
          for (const iface of Object.values(stats.networks) as Array<{ rx_bytes?: number; tx_bytes?: number }>) {
            netIn += iface.rx_bytes || 0;
            netOut += iface.tx_bytes || 0;
          }
        }

        results.push({
          name,
          image: containerInfo.Image,
          state: containerInfo.State,
          cpu: calculateCpuPercent(stats),
          ram: ramPercent,
          ramLimit: Math.round(memLimit / 1024 / 1024), // MB
          netIn,
          netOut,
        });
      } catch (err) {
        console.warn(`[Docker] Stats impossible pour ${name}:`, (err as Error).message);
      }
    }

    return results;
  } catch (err) {
    console.error('[Docker] Impossible de lister les containers:', (err as Error).message);
    return [];
  }
}

// ── Container Logs ──────────────────────────────────────────────────────────

const MAX_LOG_BUFFER_SIZE = 10_000;
const logBuffer: LogEntry[] = [];
const activeStreams = new Map<string, NodeJS.ReadableStream>();
const lastTimestamps = new Map<string, string>();

function parseLogLevel(message: string): 'info' | 'warn' | 'error' | 'debug' {
  const lower = message.toLowerCase();
  if (lower.includes('error') || lower.includes('err]') || lower.includes('fatal')) return 'error';
  if (lower.includes('warn') || lower.includes('warning')) return 'warn';
  if (lower.includes('debug') || lower.includes('dbg]')) return 'debug';
  return 'info';
}

function parseDockerLogLine(raw: Buffer): { timestamp: string; message: string } | null {
  // Docker log format: 8-byte header + message
  // Or with timestamps: 2024-01-01T00:00:00.000000000Z message
  const str = raw.toString('utf-8').trim();
  if (!str) return null;

  // Try to parse Docker timestamp prefix
  const tsMatch = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)/s);
  if (tsMatch) {
    return { timestamp: new Date(tsMatch[1]).toISOString(), message: tsMatch[2] };
  }

  return { timestamp: new Date().toISOString(), message: str };
}

export async function startLogStreaming(): Promise<void> {
  try {
    const d = getDocker();
    const containers = await d.listContainers({ all: false });

    for (const containerInfo of containers) {
      const name = (containerInfo.Names[0] || '').replace(/^\//, '');

      if (config.logContainers.length > 0 && !config.logContainers.includes(name)) {
        continue;
      }

      if (activeStreams.has(name)) continue;

      try {
        const container = d.getContainer(containerInfo.Id);
        const stream = await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          timestamps: true,
          since: Math.floor(Date.now() / 1000) - 60, // Last minute on start
          tail: 50,
        });

        activeStreams.set(name, stream as unknown as NodeJS.ReadableStream);

        (stream as unknown as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
          // Docker multiplexed stream: first 8 bytes are header
          let payload = chunk;
          if (chunk.length > 8 && (chunk[0] === 1 || chunk[0] === 2)) {
            payload = chunk.subarray(8);
          }

          const lines = payload.toString('utf-8').split('\n').filter(Boolean);

          for (const line of lines) {
            const parsed = parseDockerLogLine(Buffer.from(line));
            if (!parsed) continue;

            // Deduplicate
            const lastTs = lastTimestamps.get(name);
            if (lastTs === parsed.timestamp + parsed.message) continue;
            lastTimestamps.set(name, parsed.timestamp + parsed.message);

            // Drop oldest entries if buffer is full to prevent OOM
            if (logBuffer.length >= MAX_LOG_BUFFER_SIZE) {
              logBuffer.splice(0, logBuffer.length - MAX_LOG_BUFFER_SIZE + 1);
            }

            logBuffer.push({
              container: name,
              timestamp: parsed.timestamp,
              level: parseLogLevel(parsed.message),
              message: parsed.message.substring(0, 10000),
            });
          }
        });

        (stream as unknown as NodeJS.ReadableStream).on('end', () => {
          activeStreams.delete(name);
        });

        (stream as unknown as NodeJS.ReadableStream).on('error', (err: Error) => {
          console.warn(`[Docker] Erreur streaming logs ${name}:`, err.message);
          activeStreams.delete(name);
        });

        console.log(`[Docker] Streaming logs : ${name}`);
      } catch (err) {
        console.warn(`[Docker] Impossible de streamer les logs de ${name}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error('[Docker] Erreur démarrage streaming:', (err as Error).message);
  }
}

export function flushLogBuffer(): LogEntry[] {
  const entries = logBuffer.splice(0, 500); // Max 500 per flush
  return entries;
}

export async function getRunningContainerNames(): Promise<string[]> {
  try {
    const d = getDocker();
    const containers = await d.listContainers({ all: false });
    return containers.map((c: Docker.ContainerInfo) => (c.Names[0] || '').replace(/^\//, ''));
  } catch {
    return [];
  }
}

export function stopLogStreaming(): void {
  for (const [name, stream] of activeStreams) {
    try {
      (stream as unknown as { destroy(): void }).destroy();
    } catch {
      // ignore
    }
    activeStreams.delete(name);
  }
}
