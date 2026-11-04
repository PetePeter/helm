import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as YAML from 'yaml';
import { logger } from '../utils/logger.js';
import type { DirectoryPlan, PlanDependency, PlanItem, PlanSequence } from '../types/plan.js';
import {
  DEFAULT_PLAN_DEPS_FILE,
  DEFAULT_PLAN_SEQUENCES_FILE,
  DEFAULT_PLANS_DIR,
  PLANS_FILE,
} from './persistence-paths.js';
import { atomicWriteFileSync, isAnyString, isNumber, isRecord, isString } from './persistence-utils.js';

const FILE_VERSION = 1;

function isPlanItem(value: unknown): value is PlanItem {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.dirPath)
    && isString(value.title)
    && isAnyString(value.description)
    && isString(value.status)
    && (value.sourceIdeaId === undefined || isString(value.sourceIdeaId))
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt);
}

function isPlanDependency(value: unknown): value is PlanDependency {
  return isRecord(value) && isString(value.fromId) && isString(value.toId);
}

function isPlanSequence(value: unknown): value is PlanSequence {
  return isRecord(value)
    && isString(value.id)
    && isString(value.dirPath)
    && isString(value.title)
    && isNumber(value.order)
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt);
}

function isDirectoryPlan(value: unknown): value is DirectoryPlan {
  if (!isRecord(value)) return false;
  return isString(value.dirPath) && Array.isArray(value.items) && Array.isArray(value.dependencies);
}

export function savePlans(plans: Record<string, DirectoryPlan>): void {
  try {
    atomicWriteFileSync(PLANS_FILE, YAML.stringify({ plans }));
  } catch (err) {
    logger.error(`Failed to save plans: ${err}`);
  }
}

export function loadPlans(plansFile?: string): Record<string, DirectoryPlan> {
  const file = plansFile ?? PLANS_FILE;
  try {
    if (!existsSync(file)) return {};
    const parsed = YAML.parse(readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.plans)) return {};
    const result: Record<string, DirectoryPlan> = {};
    for (const [dirPath, plan] of Object.entries(parsed.plans)) {
      if (!isDirectoryPlan(plan)) continue;
      const items = plan.items.filter(isPlanItem);
      const dependencies = plan.dependencies.filter(isPlanDependency);
      const sequences = Array.isArray(plan.sequences) ? plan.sequences.filter(isPlanSequence) : undefined;
      result[dirPath] = { ...plan, items, dependencies, ...(sequences ? { sequences } : {}) };
    }
    return result;
  } catch (err) {
    logger.error(`Failed to load plans: ${err}`);
    return {};
  }
}

export function encodeFilename(dirPath: string, planId: string): string {
  return `${encodeURIComponent(dirPath)}@${planId}.json`;
}

export function decodeFilename(filename: string): { dirPath: string; planId: string } {
  const name = basename(filename, '.json');
  const atIdx = name.lastIndexOf('@');
  return {
    dirPath: decodeURIComponent(name.slice(0, atIdx)),
    planId: name.slice(atIdx + 1),
  };
}

export function savePlanFile(item: PlanItem, plansDir = DEFAULT_PLANS_DIR): void {
  try {
    const filename = encodeFilename(item.dirPath, item.id);
    atomicWriteFileSync(join(plansDir, filename), JSON.stringify({ ...item, _fileVersion: FILE_VERSION }, null, 2));
  } catch (err) {
    logger.error(`Failed to save plan file ${item.id}: ${err}`);
  }
}

export function loadPlanFile(filename: string, plansDir = DEFAULT_PLANS_DIR): PlanItem | null {
  try {
    const filePath = join(plansDir, filename);
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(raw)) return null;
    const { _fileVersion: _v, ...item } = raw;
    return isPlanItem(item) ? item : null;
  } catch (err) {
    logger.error(`Failed to load plan file ${filename}: ${err}`);
    return null;
  }
}

export function deletePlanFile(planId: string, plansDir = DEFAULT_PLANS_DIR): boolean {
  try {
    if (!existsSync(plansDir)) return false;
    const files = readdirSync(plansDir, { withFileTypes: true });
    let deleted = false;
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      const filePath = join(plansDir, f.name);
      const { planId: decodedId } = decodeFilename(f.name);
      const matchesFilename = planId === decodedId;

      let matchesContent = false;
      if (!matchesFilename) {
        try {
          const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { id?: string };
          matchesContent = raw?.id === planId;
        } catch (err) {
          logger.warn(`Failed to inspect plan file ${f.name} while deleting ${planId}: ${err}`);
        }
      }

      if (matchesFilename || matchesContent) {
        unlinkSync(filePath);
        deleted = true;
      }
    }
    return deleted;
  } catch (err) {
    logger.error(`Failed to delete plan file for ${planId}: ${err}`);
    return false;
  }
}

export function listPlanFiles(plansDir = DEFAULT_PLANS_DIR): string[] {
  try {
    if (!existsSync(plansDir)) return [];
    return readdirSync(plansDir, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.json'))
      .map(f => f.name);
  } catch (err) {
    logger.error(`Failed to list plan files: ${err}`);
    return [];
  }
}

export function saveDependencies(deps: PlanDependency[], depsFile = DEFAULT_PLAN_DEPS_FILE): void {
  try {
    atomicWriteFileSync(depsFile, JSON.stringify({ version: 1, dependencies: deps }, null, 2));
  } catch (err) {
    logger.error(`Failed to save plan dependencies: ${err}`);
  }
}

export function loadDependencies(depsFile = DEFAULT_PLAN_DEPS_FILE): PlanDependency[] {
  try {
    if (!existsSync(depsFile)) return [];
    const raw = JSON.parse(readFileSync(depsFile, 'utf8')) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.dependencies)) return [];
    return raw.dependencies.filter(isPlanDependency);
  } catch (err) {
    logger.error(`Failed to load plan dependencies: ${err}`);
    return [];
  }
}

export function cleanupOrphanDependencies(
  validPlanIds: Set<string>,
  depsFile = DEFAULT_PLAN_DEPS_FILE,
): { removed: number; deps: PlanDependency[] } {
  const deps = loadDependencies(depsFile);
  const cleaned = deps.filter(d => validPlanIds.has(d.fromId) && validPlanIds.has(d.toId));
  const removed = deps.length - cleaned.length;
  if (removed > 0) {
    saveDependencies(cleaned, depsFile);
    logger.info(`[Persistence] Cleaned up ${removed} orphan dependency edge(s)`);
  }
  return { removed, deps: cleaned };
}

export function savePlanSequences(sequences: PlanSequence[], sequencesFile = DEFAULT_PLAN_SEQUENCES_FILE): void {
  try {
    atomicWriteFileSync(sequencesFile, JSON.stringify({ version: 1, sequences }, null, 2));
  } catch (err) {
    logger.error(`Failed to save plan sequences: ${err}`);
  }
}

export function loadPlanSequences(sequencesFile = DEFAULT_PLAN_SEQUENCES_FILE): PlanSequence[] {
  try {
    if (!existsSync(sequencesFile)) return [];
    const raw = JSON.parse(readFileSync(sequencesFile, 'utf8')) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.sequences)) return [];
    return raw.sequences.filter(isPlanSequence);
  } catch (err) {
    logger.error(`Failed to load plan sequences: ${err}`);
    return [];
  }
}
