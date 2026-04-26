import os from 'os';
import { config } from './config';
import { collectSystemMetrics } from './collectors/system';
import { collectContainerStats, startLogStreaming, flushLogBuffer, getRunningContainerNames, stopLogStreaming } from './collectors/docker';
import { sendMetrics, sendLogs, sendHeartbeat } from './transport/api';
import * as jupyter from './jupyter';
import { startWebhookServer } from './webhook/server';

console.log('┌──────────────────────────────────────────┐');
console.log('│         Saasy Infrastructure Agent        │');
console.log('│              v' + config.version.padEnd(27) + '│');
console.log('└──────────────────────────────────────────┘');
console.log(`  API URL     : ${config.apiUrl}`);
console.log(`  Server ID   : ${config.serverId}`);
console.log(`  Hostname    : ${config.hostname}`);
console.log(`  Metrics     : every ${config.collectInterval / 1000}s`);
console.log(`  Log flush   : every ${config.logFlushInterval / 1000}s`);
console.log(`  Heartbeat   : every ${config.heartbeatInterval / 1000}s`);
console.log(`  Docker      : ${config.dockerSocket}`);
if (config.logContainers.length > 0) {
  console.log(`  Containers  : ${config.logContainers.join(', ')}`);
}

// Webhook server pour declencher des backups via Saasy dashboard (optionnel)
startWebhookServer();

console.log('');

// ── Metrics collection loop ─────────────────────────────────────────────────

async function collectAndSendMetrics() {
  try {
    const system = collectSystemMetrics();
    const containers = await collectContainerStats();

    const payload = {
      serverId: config.serverId,
      timestamp: new Date().toISOString(),
      ...system,
      containers: containers.map((c) => ({
        name: c.name,
        image: c.image,
        state: c.state,
        cpu: c.cpu,
        ram: c.ram,
        ramLimit: c.ramLimit,
        netIn: c.netIn,
        netOut: c.netOut,
      })),
    };

    const ok = await sendMetrics(payload);
    if (ok) {
      console.log(`[Metrics] CPU=${system.cpu}% RAM=${system.ram}% Disk=${system.disk}% Containers=${containers.length}`);
    }
  } catch (err) {
    console.error('[Metrics] Erreur:', (err as Error).message);
  }
}

// ── Log flush loop ──────────────────────────────────────────────────────────

async function flushAndSendLogs() {
  try {
    const entries = flushLogBuffer();
    if (entries.length === 0) return;

    const ok = await sendLogs(config.serverId, entries);
    if (ok) {
      console.log(`[Logs] ${entries.length} entrées envoyées`);
    }
  } catch (err) {
    console.error('[Logs] Erreur:', (err as Error).message);
  }
}

// ── Jupyter status reporting loop ───────────────────────────────────────────

/**
 * Auto-detect saasy-jupyter-* containers and report their status.
 * Each container's name encodes the environmentId (last 12 chars).
 */
async function reportJupyterStatuses() {
  try {
    const allContainers = await getRunningContainerNames();
    const jupyterContainers = allContainers.filter((n) => n.startsWith('saasy-jupyter-'));
    for (const cName of jupyterContainers) {
      const envIdSuffix = cName.replace('saasy-jupyter-', '');
      // The full envId is stored on the Saasy backend; the suffix is enough
      // to match thanks to the unique index. We pass the suffix as
      // environmentId placeholder — backend resolves by name pattern.
      await jupyter.reportStatus({ environmentId: envIdSuffix, containerName: cName });
    }
  } catch (err) {
    console.error('[Jupyter] Status report error:', (err as Error).message);
  }
}

// ── Heartbeat loop ──────────────────────────────────────────────────────────

async function sendHeartbeatLoop() {
  try {
    const containers = await getRunningContainerNames();

    const ok = await sendHeartbeat({
      serverId: config.serverId,
      version: config.version,
      hostname: config.hostname,
      uptime: os.uptime(),
      containers,
    });

    if (ok) {
      console.log(`[Heartbeat] OK — ${containers.length} containers actifs`);
    }
  } catch (err) {
    console.error('[Heartbeat] Erreur:', (err as Error).message);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Initial heartbeat
  await sendHeartbeatLoop();

  // Start log streaming from Docker
  await startLogStreaming();

  // Periodically re-check for new containers to stream
  setInterval(async () => {
    await startLogStreaming();
  }, 30000);

  // Schedule loops
  setInterval(collectAndSendMetrics, config.collectInterval);
  setInterval(flushAndSendLogs, config.logFlushInterval);
  setInterval(sendHeartbeatLoop, config.heartbeatInterval);
  // Jupyter status: every 60s, piggy-backed on heartbeat cadence
  setInterval(reportJupyterStatuses, Math.max(config.heartbeatInterval, 60_000));

  // Initial metrics after 2s (let CPU baseline settle)
  setTimeout(collectAndSendMetrics, 2000);

  console.log('[Agent] Démarré — Ctrl+C pour arrêter');
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown() {
  console.log('\n[Agent] Arrêt en cours...');
  stopLogStreaming();
  // Flush remaining logs
  flushAndSendLogs().then(() => {
    console.log('[Agent] Arrêté');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('[Agent] Erreur fatale:', err);
  process.exit(1);
});
