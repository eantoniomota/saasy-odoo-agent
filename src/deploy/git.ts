/**
 * Helpers git pour le module deploy.
 *
 * Toutes les fonctions delegent a `git -C <repoPath>` via execSync.
 * Le repoPath doit etre un clone existant accessible au container agent
 * (typiquement via un mount -v /opt/saasy-deployments:/host/deployments).
 */
import { execSync } from 'node:child_process';

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function getCurrentSha(repoPath: string): string {
  return exec(`git -C ${repoPath} rev-parse HEAD`);
}

export function getCurrentBranch(repoPath: string): string {
  return exec(`git -C ${repoPath} rev-parse --abbrev-ref HEAD`);
}

export function fetch(repoPath: string, branch: string): void {
  execSync(`git -C ${repoPath} fetch origin ${branch}`, { stdio: 'inherit' });
}

export function checkout(repoPath: string, ref: string): void {
  execSync(`git -C ${repoPath} checkout ${ref}`, { stdio: 'inherit' });
}

export function pull(repoPath: string, branch: string): void {
  execSync(`git -C ${repoPath} pull --ff-only origin ${branch}`, { stdio: 'inherit' });
}

/** Liste les fichiers changes entre deux commits (relatifs a la racine du repo). */
export function diffNames(repoPath: string, fromSha: string, toSha: string): string[] {
  if (fromSha === toSha) return [];
  try {
    const out = exec(`git -C ${repoPath} diff ${fromSha}..${toSha} --name-only`);
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function repoExists(repoPath: string): boolean {
  try {
    execSync(`git -C ${repoPath} rev-parse --git-dir`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
