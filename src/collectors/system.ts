import fs from 'fs';
import os from 'os';

// ── CPU Usage ───────────────────────────────────────────────────────────────

interface CpuTimes {
  idle: number;
  total: number;
}

let prevCpu: CpuTimes | null = null;

function readCpuTimes(): CpuTimes {
  try {
    const stat = fs.readFileSync('/host/proc/stat', 'utf-8');
    const line = stat.split('\n')[0]; // "cpu  user nice system idle iowait irq softirq steal"
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    // Fallback: use Node.js os module (works on macOS/dev)
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }
    return { idle, total };
  }
}

export function getCpuUsage(): number {
  const current = readCpuTimes();
  if (!prevCpu) {
    prevCpu = current;
    return 0;
  }

  const idleDiff = current.idle - prevCpu.idle;
  const totalDiff = current.total - prevCpu.total;
  prevCpu = current;

  if (totalDiff === 0) return 0;
  return Math.round((1 - idleDiff / totalDiff) * 10000) / 100; // 2 decimals
}

// ── RAM Usage ───────────────────────────────────────────────────────────────

export function getRamUsage(): number {
  try {
    const meminfo = fs.readFileSync('/host/proc/meminfo', 'utf-8');
    const lines = meminfo.split('\n');
    const getValue = (key: string): number => {
      const line = lines.find((l) => l.startsWith(key));
      return line ? parseInt(line.split(/\s+/)[1], 10) : 0;
    };

    const total = getValue('MemTotal:');
    const available = getValue('MemAvailable:');
    if (total === 0) return 0;
    return Math.round(((total - available) / total) * 10000) / 100;
  } catch {
    // Fallback
    const total = os.totalmem();
    const free = os.freemem();
    return Math.round(((total - free) / total) * 10000) / 100;
  }
}

// ── Disk Usage ──────────────────────────────────────────────────────────────

export function getDiskUsage(): number {
  try {
    const statvfs = fs.statfsSync('/host/sys/../');
    const total = statvfs.blocks * statvfs.bsize;
    const free = statvfs.bfree * statvfs.bsize;
    if (total === 0) return 0;
    return Math.round(((total - free) / total) * 10000) / 100;
  } catch (err) {
    console.warn('[System] Lecture disque impossible:', (err as Error).message);
    return 0;
  }
}

// ── Network ─────────────────────────────────────────────────────────────────

interface NetStats {
  rxBytes: number;
  txBytes: number;
}

let prevNet: NetStats | null = null;
let prevNetTime: number | null = null;

function readNetStats(): NetStats {
  try {
    const content = fs.readFileSync('/host/proc/net/dev', 'utf-8');
    const lines = content.split('\n').slice(2); // Skip headers
    let rxBytes = 0;
    let txBytes = 0;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (!parts[0]) continue;
      const iface = parts[0].replace(':', '');
      if (iface === 'lo') continue; // Skip loopback

      rxBytes += parseInt(parts[1], 10) || 0;
      txBytes += parseInt(parts[9], 10) || 0;
    }
    return { rxBytes, txBytes };
  } catch {
    return { rxBytes: 0, txBytes: 0 };
  }
}

export function getNetworkUsage(): { netIn: number; netOut: number } {
  const current = readNetStats();
  const now = Date.now();

  if (!prevNet || !prevNetTime) {
    prevNet = current;
    prevNetTime = now;
    return { netIn: 0, netOut: 0 };
  }

  const elapsed = (now - prevNetTime) / 1000; // seconds
  if (elapsed === 0) return { netIn: 0, netOut: 0 };

  const netIn = Math.round((current.rxBytes - prevNet.rxBytes) / elapsed);
  const netOut = Math.round((current.txBytes - prevNet.txBytes) / elapsed);

  prevNet = current;
  prevNetTime = now;

  return { netIn: Math.max(0, netIn), netOut: Math.max(0, netOut) };
}

// ── Combined ────────────────────────────────────────────────────────────────

export interface SystemMetrics {
  cpu: number;
  ram: number;
  disk: number;
  netIn: number;
  netOut: number;
}

export function collectSystemMetrics(): SystemMetrics {
  const cpu = getCpuUsage();
  const ram = getRamUsage();
  const disk = getDiskUsage();
  const { netIn, netOut } = getNetworkUsage();
  return { cpu, ram, disk, netIn, netOut };
}
