import { existsSync, readFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import type { ProjectRecord } from '../types/project.js';
import { atomicWriteFileSync, isRecord, isString } from './persistence-utils.js';

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!isRecord(value)) return false;
  return isString(value.id) && isString(value.name) && isString(value.canonicalPath);
}

export function saveProjectRecords(projects: ProjectRecord[], projectsFile?: string): void {
  if (!projectsFile) return;
  try {
    atomicWriteFileSync(projectsFile, JSON.stringify({ version: 1, projects }, null, 2));
  } catch (err) {
    logger.error(`Failed to save projects: ${err}`);
  }
}

export function loadProjectRecords(projectsFile?: string): ProjectRecord[] {
  if (!projectsFile) return [];
  try {
    if (!existsSync(projectsFile)) return [];
    const raw = JSON.parse(readFileSync(projectsFile, 'utf8')) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.projects)) return [];
    return raw.projects.filter(isProjectRecord);
  } catch (err) {
    logger.error(`Failed to load projects: ${err}`);
    return [];
  }
}
