/**
 * Deploy Odoo (V1) :
 *   - git fetch + checkout + pull sur le repo addon clone localement
 *   - Smart update detection : si fichiers .xml/data/views/security/i18n/manifest
 *     ont change → odoo -u <module>, sinon docker restart seulement
 *   - Override via commit message :
 *     [odoo:update]   → force odoo -u
 *     [odoo:skip]     → skip le deploy entierement
 *
 * Conventions :
 *   - repoPath = <DEPLOY_BASE_PATH>/<envSlug>/<DEPLOY_REPO_NAME>
 *     Ex: /host/deployments/production/saasy-odoo-addon
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
  moduleUpdated: boolean;
  skipped: boolean;
  durationMs: number;
}

interface ResolvedDeployConfig {
  envSlug: string;
  repoPath: string;
  odooContainer: string;
  dbName: string;
  module: string;
}

function resolveDeployConfig(envSlug: string): ResolvedDeployConfig {
  const isProd = envSlug === 'production';
  return {
    envSlug,
    repoPath: join(config.deployBasePath, envSlug, config.deployRepoName),
    odooContainer: isProd ? 'odoo' : `odoo-${envSlug}`,
    dbName: isProd ? 'odoo' : `odoo_${envSlug}`,
    module: config.deployModule,
  };
}

/** Determine si un fichier modifie necessite un odoo -u <module>. */
function needsModuleUpdate(filePath: string): boolean {
  // __manifest__.py n'importe ou
  if (filePath.endsWith('__manifest__.py')) return true;
  // Extensions de donnees Odoo
  if (/\.(xml|csv|po|pot)$/.test(filePath)) return true;
  // Dossiers de donnees / vues / acces / traductions
  if (/(^|\/)(data|views|security|i18n|wizards|reports)\//.test(filePath)) return true;
  return false;
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
  console.log(`[Deploy] dbName         : ${cfg.dbName}`);
  console.log(`[Deploy] module         : ${cfg.module}`);
  if (opts.message) console.log(`[Deploy] message        : ${opts.message.split('\n')[0]}`);

  // Verifier que le repo existe
  if (!git.repoExists(cfg.repoPath)) {
    throw new Error(
      `Le repo "${cfg.repoPath}" n'existe pas ou n'est pas un git repo. ` +
      `Clone-le manuellement avant le premier deploy : ` +
      `git clone <url> ${cfg.repoPath}`,
    );
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
      moduleUpdated: false,
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

  // 2. Smart update detection
  const changes = git.diffNames(cfg.repoPath, oldSha, newSha);
  console.log(`[Deploy] ${changes.length} fichier(s) change(s) :`);
  changes.slice(0, 20).forEach((f) => console.log(`         ${f}`));
  if (changes.length > 20) console.log(`         ... et ${changes.length - 20} autres`);

  let moduleUpdated = changes.some(needsModuleUpdate);

  // Override via commit message
  if (opts.message?.includes('[odoo:update]')) {
    console.log('[Deploy] [odoo:update] detecte — force odoo -u');
    moduleUpdated = true;
  }

  if (oldSha === newSha && !moduleUpdated) {
    console.log('[Deploy] Aucun changement — restart de courtoisie');
  }

  // 3. Apply
  if (moduleUpdated) {
    console.log(`[Deploy] Update module ${cfg.module} (peut prendre 30-60s)...`);
    runDockerExec(
      `docker exec ${cfg.odooContainer} odoo -c /etc/odoo/odoo.conf ` +
      `-d ${cfg.dbName} -u ${cfg.module} --stop-after-init --no-http`,
    );
  } else {
    console.log('[Deploy] Code Python pur — restart suffit');
  }

  // Restart toujours pour reload le code
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
    moduleUpdated,
    skipped: false,
    durationMs,
  };
}
