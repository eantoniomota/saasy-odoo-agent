/**
 * Deploy Odoo (V1) — flow type Odoo.sh sans auto-update :
 *   - Auto-clone le repo client si premier deploy
 *   - git fetch + reset --hard + checkout du SHA cible
 *   - docker restart <odooContainer> (reload du code Python)
 *
 * **L'update des modules (odoo -u <name>) est MANUEL** : c'est a l'utilisateur
 * de declencher l'update depuis le menu Odoo Admin de JupyterLab apres un
 * deploy qui a modifie des fichiers XML/data/views/etc.
 *
 * Override via commit message :
 *   [odoo:skip] → skip le deploy entierement (utile pour commits doc)
 *
 * Conventions :
 *   - repoPath = <DEPLOY_BASE_PATH>/<envSlug>/<repo-name>
 *   - odooContainer = "odoo" pour production, "odoo-<envSlug>" sinon
 *   - dbName = "odoo" pour production, "odoo_<envSlug>" sinon
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { config } from '../config';
import * as git from './git';

export interface DeployOdooOptions {
  envSlug: string;        // ex: "production", "staging"
  branch: string;         // ex: "main"
  sha?: string;           // optionnel : si fourni, checkout ce SHA precis apres pull
  message?: string;       // commit message — utilise pour les overrides
}

export interface DeployResult {
  success: boolean;
  envSlug: string;
  branch: string;
  oldSha: string;
  newSha: string;
  filesChanged: number;
  skipped: boolean;
  durationMs: number;
}

interface ResolvedDeployConfig {
  envSlug: string;
  repoPath: string;
  repoUrl: string;
  repoToken: string;
  odooContainer: string;
  dbName: string;
}

function resolveDeployConfig(envSlug: string): ResolvedDeployConfig {
  if (!config.deployGithubRepo) {
    throw new Error(
      'DEPLOY_GITHUB_REPO non configure cote agent. ' +
      'Format attendu : "owner/repo" (ex: "acme/odoo-stack").',
    );
  }

  const repoName = config.deployGithubRepo.split('/').pop() || 'repo';
  const isProd = envSlug === 'production';

  return {
    envSlug,
    repoPath: join(config.deployBasePath, envSlug, repoName),
    repoUrl: git.repoUrlFromSlug(config.deployGithubRepo),
    repoToken: config.deployGithubToken,
    odooContainer: isProd ? 'odoo' : `odoo-${envSlug}`,
    dbName: isProd ? 'odoo' : `odoo_${envSlug}`,
  };
}

function runDockerExec(cmd: string): void {
  console.log(`[Deploy] $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

export async function deployOdoo(opts: DeployOdooOptions): Promise<DeployResult> {
  const start = Date.now();
  const cfg = resolveDeployConfig(opts.envSlug);

  console.log('');
  console.log(`[Deploy] ─── env=${opts.envSlug} branch=${opts.branch} sha=${(opts.sha || '?').slice(0, 7)} ───`);
  console.log(`[Deploy] repoPath       : ${cfg.repoPath}`);
  console.log(`[Deploy] odooContainer  : ${cfg.odooContainer}`);
  if (opts.message) console.log(`[Deploy] message        : ${opts.message.split('\n')[0]}`);

  // Auto-clone si le repo n'existe pas (premier deploy)
  if (!git.repoExists(cfg.repoPath)) {
    console.log(`[Deploy] Premier deploy — clone du repo`);
    git.clone(cfg.repoUrl, cfg.repoPath, cfg.repoToken);
  }

  // Override [odoo:skip] → on skip avant meme le pull
  if (opts.message?.includes('[odoo:skip]')) {
    console.log('[Deploy] [odoo:skip] detecte dans le message — skip du deploy');
    return {
      success: true,
      envSlug: opts.envSlug,
      branch: opts.branch,
      oldSha: git.getCurrentSha(cfg.repoPath),
      newSha: git.getCurrentSha(cfg.repoPath),
      filesChanged: 0,
      skipped: true,
      durationMs: Date.now() - start,
    };
  }

  // 1. Git checkout target
  const oldSha = git.getCurrentSha(cfg.repoPath);
  console.log(`[Deploy] HEAD actuel : ${oldSha.slice(0, 7)}`);

  console.log(`[Deploy] git fetch + checkout ${opts.branch} + pull`);
  git.fetch(cfg.repoPath, opts.branch);
  git.checkout(cfg.repoPath, opts.branch);
  git.pull(cfg.repoPath, opts.branch);

  // Si SHA cible specifie et different, on s'y deplace (deploy d'un commit precis)
  if (opts.sha && opts.sha !== git.getCurrentSha(cfg.repoPath)) {
    console.log(`[Deploy] checkout SHA cible ${opts.sha.slice(0, 7)}`);
    git.checkout(cfg.repoPath, opts.sha);
  }

  const newSha = git.getCurrentSha(cfg.repoPath);
  console.log(`[Deploy] HEAD nouveau: ${newSha.slice(0, 7)}`);

  // 2. Liste les fichiers changes pour info (pas d'action automatique dessus)
  const changes = git.diffNames(cfg.repoPath, oldSha, newSha);
  console.log(`[Deploy] ${changes.length} fichier(s) change(s) :`);
  changes.slice(0, 20).forEach((f) => console.log(`         ${f}`));
  if (changes.length > 20) console.log(`         ... et ${changes.length - 20} autres`);

  // 3. Restart Odoo pour reload le code Python.
  // L'update des modules (odoo -u) reste MANUEL — a faire depuis le menu
  // Odoo Admin de JupyterLab si des fichiers XML/data ont change.
  console.log('[Deploy] Restart Odoo pour reload du code...');
  runDockerExec(`docker restart ${cfg.odooContainer}`);

  const durationMs = Date.now() - start;
  console.log(`[Deploy] OK — ${oldSha.slice(0, 7)} → ${newSha.slice(0, 7)} en ${(durationMs / 1000).toFixed(1)}s`);

  return {
    success: true,
    envSlug: opts.envSlug,
    branch: opts.branch,
    oldSha,
    newSha,
    filesChanged: changes.length,
    skipped: false,
    durationMs,
  };
}
