import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { listPlanFiles, loadPlanFile, loadPlanSequences, savePlanFile, savePlanSequences, saveSessions, loadSessions } from './persistence.js';
import { ProjectStore } from './project-store.js';

const __migration_dirname = dirname(fileURLToPath(import.meta.url));

export interface ProjectMigrationResult {
  migratedProjects: number;
  updatedPlans: number;
  updatedSequences: number;
  updatedSessions: number;
}

interface ProjectMigrationMarker {
  version: number;
  status: 'running' | 'completed';
  startedAt: number;
  completedAt?: number;
  backupDir: string;
}

const PROJECT_MIGRATION_VERSION = 1;

function readMarker(markerFile: string): ProjectMigrationMarker | null {
  if (!existsSync(markerFile)) return null;
  try {
    return JSON.parse(readFileSync(markerFile, 'utf8')) as ProjectMigrationMarker;
  } catch {
    return null;
  }
}

function writeMarker(markerFile: string, marker: ProjectMigrationMarker): void {
  mkdirSync(dirname(markerFile), { recursive: true });
  writeFileSync(markerFile, JSON.stringify(marker, null, 2), 'utf8');
}

function ensureBackupCopy(sourcePath: string, backupPath: string): void {
  if (!existsSync(sourcePath) || existsSync(backupPath)) return;
  mkdirSync(dirname(backupPath), { recursive: true });
  cpSync(sourcePath, backupPath, { recursive: true });
}

/**
 * First-run project migration:
 * - creates stable Project records from existing plans/sequences/sessions
 * - annotates those records with projectId
 *
 * The migration is idempotent: re-running only re-saves when project linkage changed.
 */
export function migrateProjects(configDir: string): ProjectMigrationResult {
  const resolvedConfigDir = configDir;
  const plansDir = join(resolvedConfigDir, 'plans');
  const sequencesFile = join(resolvedConfigDir, 'plan-sequences.json');
  const sessionsFile = join(resolvedConfigDir, 'sessions.yaml');
  const projectsFile = join(resolvedConfigDir, 'projects.json');
  const markerFile = join(resolvedConfigDir, 'project-migration-state.json');
  const backupDir = join(resolvedConfigDir, 'project-migration-backup');

  const store = new ProjectStore(projectsFile);
  const existingMarker = readMarker(markerFile);
  const marker: ProjectMigrationMarker = existingMarker ?? {
    version: PROJECT_MIGRATION_VERSION,
    status: 'running',
    startedAt: Date.now(),
    backupDir,
  };
  writeMarker(markerFile, { ...marker, status: 'running', completedAt: undefined });
  const beforeCount = store.list().length;
  let updatedPlans = 0;
  let updatedSequences = 0;
  let updatedSessions = 0;

  ensureBackupCopy(plansDir, join(backupDir, 'plans'));
  ensureBackupCopy(sequencesFile, join(backupDir, 'plan-sequences.json'));
  ensureBackupCopy(sessionsFile, join(backupDir, 'sessions.yaml'));
  ensureBackupCopy(projectsFile, join(backupDir, 'projects.json'));

  if (existsSync(plansDir)) {
    for (const filename of listPlanFiles(plansDir)) {
      const item = loadPlanFile(filename, plansDir);
      if (!item) continue;
      const project = store.resolveForPath(item.dirPath);
      if (item.projectId !== project.id) {
        item.projectId = project.id;
        savePlanFile(item, plansDir);
        updatedPlans++;
      }
    }
  }

  if (existsSync(sequencesFile)) {
    const sequences = loadPlanSequences(sequencesFile);
    let changed = false;
    for (const sequence of sequences) {
      const project = store.resolveForPath(sequence.dirPath);
      if (sequence.projectId !== project.id) {
        sequence.projectId = project.id;
        sequence.updatedAt = Date.now();
        updatedSequences++;
        changed = true;
      }
    }
    if (changed) {
      savePlanSequences(sequences, sequencesFile);
    }
  }

  if (existsSync(sessionsFile)) {
    const sessions = loadSessions(sessionsFile);
    let changed = false;
    for (const session of sessions) {
      if (!session.workingDir) continue;
      const project = store.resolveForPath(session.workingDir);
      if (session.projectId !== project.id) {
        session.projectId = project.id;
        updatedSessions++;
        changed = true;
      }
    }
    if (changed) {
      saveSessions(sessions, sessionsFile);
    }
  }

  const afterCount = store.list().length;
  if (store.isDirty() || updatedPlans > 0 || updatedSequences > 0 || updatedSessions > 0) {
    store.save();
    logger.info(`[ProjectMigration] Projects=${afterCount} plans=${updatedPlans} sequences=${updatedSequences} sessions=${updatedSessions}`);
  }

  writeMarker(markerFile, {
    ...marker,
    status: 'completed',
    completedAt: Date.now(),
  });

  return {
    migratedProjects: Math.max(0, afterCount - beforeCount),
    updatedPlans,
    updatedSequences,
    updatedSessions,
  };
}
