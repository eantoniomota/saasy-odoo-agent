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

export function fetch(repoPath: string, _branch?: string): void {
  // fetch --all + --prune : recupere TOUS les refs (pas juste une branche)
  // pour que le checkout d'un SHA arbitraire fonctionne ensuite.
  execSync(`git -C ${repoPath} fetch --all --prune --tags`, { stdio: 'inherit' });
}

export function checkout(repoPath: string, ref: string): void {
  execSync(`git -C ${repoPath} checkout ${ref}`, { stdio: 'inherit' });
}

/**
 * Aligne la branche locale sur origin/<branch> de force.
 * Plus robuste que `git pull --ff-only` qui peut silencieusement no-op
 * dans certains cas (HEAD detache, rebase en cours, etc.).
 */
export function pull(repoPath: string, branch: string): void {
  execSync(`git -C ${repoPath} reset --hard origin/${branch}`, { stdio: 'inherit' });
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

/**
 * Clone un repo GitHub. Si token fourni, l'inclut dans l'URL pour
 * l'authentification (utile pour les repos privés client).
 *
 * SECURITE : on capture stdout/stderr de git clone (pas stdio:'inherit')
 * pour pouvoir filtrer le token avant de logger. Sinon git ecrit l'URL
 * complete avec le token dans les messages d'erreur, qui se retrouvent
 * dans `docker logs` puis dans les rapports utilisateurs.
 */
export function clone(repoUrl: string, repoPath: string, token?: string): void {
  const sanitized = repoUrl.replace(/\/\/[^@]+@/, '//');
  console.log(`[Git] Cloning ${sanitized} → ${repoPath}`);

  const urlWithToken = token
    ? repoUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`)
    : repoUrl;

  execSync(`mkdir -p "$(dirname ${repoPath})"`, { stdio: 'ignore' });

  try {
    const out = execSync(`git clone ${urlWithToken} ${repoPath}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (out) console.log(redactToken(out, token));
  } catch (err) {
    // err.stdout / err.stderr / err.message contiennent potentiellement le token
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const stdout = redactToken(e.stdout?.toString() || '', token);
    const stderr = redactToken(e.stderr?.toString() || '', token);
    const message = redactToken(e.message || '', token);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    throw new Error(`git clone failed: ${stderr.trim() || message}`);
  }
}

function redactToken(text: string, token?: string): string {
  if (!token || !text) return text;
  return text.split(token).join('<TOKEN>');
}

/** Convertit "owner/repo" en URL HTTPS GitHub. */
export function repoUrlFromSlug(ownerSlashRepo: string): string {
  return `https://github.com/${ownerSlashRepo}.git`;
}
