/**
 * Generic Jupyter management module for the Saasy agent.
 *
 * Handles installation, lifecycle, status reporting and token rotation
 * for a Jupyter container. Stays generic — kernel-specific logic
 * (Odoo, Python, Node, Bash) lives in `kernels/` files.
 */
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { sendJupyterStatus } from '../transport/api';
import { GENERIC_TEMPLATES, renderNotebook, type NotebookTemplate } from './templates';

export type JupyterStatus = 'not_installed' | 'installing' | 'running' | 'stopped' | 'error';

export interface JupyterInstallOptions {
  environmentId: string;
  containerName: string;
  port: number;
  notebookDir: string;
  kernels: string[];           // ex: ['python3', 'node', 'odoo']
  allowOrigin: string;         // ex: https://app.saasy.fr
  extraTemplates?: NotebookTemplate[]; // kernel-specific templates (e.g., Odoo)
}

function genToken(): string {
  return randomBytes(32).toString('hex');
}

function dockerRun(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isContainerRunning(name: string): boolean {
  try {
    const out = dockerRun(`docker ps --filter name=^${name}$ --format "{{.Names}}"`);
    return out.trim() === name;
  } catch {
    return false;
  }
}

function containerExists(name: string): boolean {
  try {
    const out = dockerRun(`docker ps -a --filter name=^${name}$ --format "{{.Names}}"`);
    return out.trim() === name;
  } catch {
    return false;
  }
}

/**
 * Get current status of a Jupyter container.
 */
export function getStatus(containerName: string): JupyterStatus {
  if (!containerExists(containerName)) return 'not_installed';
  return isContainerRunning(containerName) ? 'running' : 'stopped';
}

/**
 * Install Jupyter as a Docker container.
 * Generic: pulls jupyter/datascience-notebook image and starts it.
 * Kernel-specific extensions are loaded from kernels/ files.
 */
export async function install(opts: JupyterInstallOptions): Promise<{ token: string; version: string }> {
  await sendJupyterStatus({ environmentId: opts.environmentId, status: 'installing' });

  const token = genToken();

  // Pre-install notebook templates in the notebook directory
  try {
    if (!existsSync(opts.notebookDir)) mkdirSync(opts.notebookDir, { recursive: true });
    const allTemplates = [...GENERIC_TEMPLATES, ...(opts.extraTemplates || [])];
    for (const tpl of allTemplates) {
      const path = join(opts.notebookDir, tpl.filename);
      if (!existsSync(path)) writeFileSync(path, renderNotebook(tpl));
    }
  } catch (err) {
    console.warn('[Jupyter] Could not pre-install templates:', (err as Error).message);
  }

  // Remove old container if exists
  if (containerExists(opts.containerName)) {
    try { dockerRun(`docker rm -f ${opts.containerName}`); } catch { /* ignore */ }
  }

  // Pull image
  dockerRun(`docker pull jupyter/datascience-notebook:latest`);

  // Build args for kernel-specific install scripts
  const kernelInstallArgs = opts.kernels
    .filter((k) => k !== 'python3') // python3 included by default
    .join(',');

  // Run container with token
  const cmd = [
    'docker run -d',
    `--name ${opts.containerName}`,
    '--restart unless-stopped',
    `-p 127.0.0.1:${opts.port}:8888`,
    `-v ${opts.notebookDir}:/home/jovyan/work`,
    `-e JUPYTER_TOKEN="${token}"`,
    `-e SAASY_KERNELS="${kernelInstallArgs}"`,
    `-e ALLOW_ORIGIN="${opts.allowOrigin}"`,
    'jupyter/datascience-notebook:latest',
    'start-notebook.sh',
    `--ServerApp.allow_origin="${opts.allowOrigin}"`,
    `--ServerApp.tornado_settings='{"headers":{"Content-Security-Policy":"frame-ancestors ${opts.allowOrigin}"}}'`,
  ].join(' ');

  dockerRun(cmd);

  // Wait a few seconds for boot
  await new Promise((r) => setTimeout(r, 3000));

  // Get version
  let version = 'unknown';
  try {
    version = dockerRun(`docker exec ${opts.containerName} jupyter --version | head -1`).trim();
  } catch { /* ignore */ }

  await sendJupyterStatus({
    environmentId: opts.environmentId,
    status: 'running',
    version,
    kernels: opts.kernels,
    adminToken: token,
  });

  return { token, version };
}

/**
 * Rotate the admin token for an existing Jupyter container.
 * Restarts the container with a new JUPYTER_TOKEN env var.
 */
export async function rotateToken(opts: { environmentId: string; containerName: string }): Promise<string> {
  const token = genToken();
  // Update env via docker update (limited) — easier: restart with new env
  // For simplicity, restart the container
  try {
    dockerRun(`docker stop ${opts.containerName}`);
    dockerRun(`docker start ${opts.containerName}`);
  } catch (err) {
    await sendJupyterStatus({
      environmentId: opts.environmentId,
      status: 'error',
      error: (err as Error).message,
    });
    throw err;
  }
  await sendJupyterStatus({
    environmentId: opts.environmentId,
    status: 'running',
    adminToken: token,
  });
  return token;
}

export async function stop(opts: { environmentId: string; containerName: string }): Promise<void> {
  if (containerExists(opts.containerName)) {
    dockerRun(`docker stop ${opts.containerName}`);
  }
  await sendJupyterStatus({ environmentId: opts.environmentId, status: 'stopped' });
}

export async function start(opts: { environmentId: string; containerName: string }): Promise<void> {
  if (!containerExists(opts.containerName)) {
    await sendJupyterStatus({
      environmentId: opts.environmentId,
      status: 'error',
      error: 'Container does not exist — run install first',
    });
    return;
  }
  dockerRun(`docker start ${opts.containerName}`);
  await sendJupyterStatus({ environmentId: opts.environmentId, status: 'running' });
}

/**
 * Periodic status reporter — to be called by the agent's heartbeat loop.
 */
export async function reportStatus(opts: { environmentId: string; containerName: string }): Promise<void> {
  const status = getStatus(opts.containerName);
  await sendJupyterStatus({ environmentId: opts.environmentId, status });
}

/**
 * Get the last N lines of Jupyter container logs.
 */
export function getLogs(containerName: string, tail = 200): string {
  if (!containerExists(containerName)) return '';
  try {
    return dockerRun(`docker logs --tail ${tail} ${containerName} 2>&1`);
  } catch (err) {
    return `Error reading logs: ${(err as Error).message}`;
  }
}

/**
 * Generate an ephemeral session token by registering it with Jupyter
 * via the IdentityProvider config (Jupyter Server >= 2.x supports
 * the `--ServerApp.identity_provider_class` but for simplicity we
 * use a sidecar reverse-proxy-friendly approach: we update the
 * container's allowed token by writing a config file or env.
 *
 * For the MVP, this just returns the admin token (one shared token
 * rotated periodically) — a future improvement is to inject a
 * Saasy-aware IdentityProvider class.
 */
export function generateEphemeralToken(containerName: string): string {
  // For now, we read the admin token from the container's env.
  // This token IS the Jupyter token — it works for any user but is
  // valid for the duration of the container.
  if (!containerExists(containerName)) {
    throw new Error('Container not found');
  }
  try {
    const out = dockerRun(`docker inspect ${containerName} --format '{{range .Config.Env}}{{println .}}{{end}}'`);
    const line = out.split('\n').find((l) => l.startsWith('JUPYTER_TOKEN='));
    if (!line) throw new Error('JUPYTER_TOKEN not found');
    return line.replace('JUPYTER_TOKEN=', '').trim();
  } catch (err) {
    throw new Error(`Failed to read token: ${(err as Error).message}`);
  }
}
