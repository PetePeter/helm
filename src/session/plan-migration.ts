/**
 * Plan storage migration — monolithic plans.yaml → individual JSON files.
 *
 * Called once on startup when config/plans.yaml is still present.
 * After migration the original is backed up to plans.yaml.bak and deleted.
 */

import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlans, savePlanFile, saveDependencies } from './persistence.js';
import { logger } from '../utils/logger.js';

const __migration_dirname = dirname(fileURLToPath(import.meta.url));

export interface MigrationResult {
  migratedPlans: number;
  migratedDeps: number;
}

/**
 * Migrate config/plans.yaml to individual config/plans/*.json files.
 * No-op when plans.yaml does not exist.
 *
 * @param configDir - Override config directory (defaults to production path; injectable for tests)
 */
export function migrateOldPlans(configDir: string): MigrationResult {
  const resolvedConfigDir = configDir;
  const plansYaml = join(resolvedConfigDir, 'plans.yaml');
  const plansBak = join(resolvedConfigDir, 'plans.yaml.bak');
  const plansDir = join(resolvedConfigDir, 'plans');
  const depsFile = join(resolvedConfigDir, 'plan-dependencies.json');

  if (!existsSync(plansYaml)) {
    return { migratedPlans: 0, migratedDeps: 0 };
  }

  logger.info('[Migration] Migrating plans.yaml to individual plan files…');

  const allDirPlans = loadPlans(plansYaml);
  let migratedPlans = 0;
  const allDeps: Array<{ fromId: string; toId: string }> = [];

  for (const dirPlan of Object.values(allDirPlans)) {
    for (const item of dirPlan.items) {
      savePlanFile(item, plansDir);
      migratedPlans++;
    }
    allDeps.push(...dirPlan.dependencies);
  }

  saveDependencies(allDeps, depsFile);

  // Backup then remove original
  if (existsSync(plansBak)) unlinkSync(plansBak);
  renameSync(plansYaml, plansBak);

  logger.info(`[Migration] Migrated ${migratedPlans} plan(s), ${allDeps.length} dep(s). Backup: plans.yaml.bak`);
  return { migratedPlans, migratedDeps: allDeps.length };
}
