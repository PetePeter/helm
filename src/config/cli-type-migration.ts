/**
 * cli-type-migration — one-time re-key of CLI types from human-authored slugs
 * ('claude-code') to stable UUID v4 ids.
 *
 * Why: the slug doubled as both identity and label, so renaming a CLI type meant
 * rewriting its key everywhere it was referenced (sessions, recycle
 * bin, scheduled tasks). With a UUID key, `displayName` is free text and a
 * rename touches exactly one field.
 *
 * Follows the profile-migrator precedent: invoked from ConfigLoader.load(), and
 * idempotent — once every entry carries an `id`, the migration short-circuits
 * without touching a single file, so a second run leaves bytes identical.
 *
 * Failure policy: all rewrites are staged to sibling .migrating temp files,
 * re-parsed to verify, and only then swapped into place. If anything fails
 * before the swap phase the originals are left exactly as they were and the
 * error is logged loudly — a half-migrated config is far worse than none.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as YAML from 'yaml';
import logger from '../utils/logger.js';

/** Every file that stores a CLI type key and therefore has to be re-keyed together. */
export interface CliTypeMigrationFiles {
  cliTypesFile: string;
  sessionsFile: string;
  recycleBinFile: string;
  scheduledTasksFile: string;
  scheduledTaskHistoryFile: string;
}

/**
 * Default file set — every path derived from the caller's `configDir`.
 *
 * These deliberately do NOT come from session/persistence-paths.js. Those are
 * process-wide constants resolved from the real per-user app-data dir at import
 * time, so a ConfigLoader pointed at a temp dir (every test that builds one)
 * would re-key the developer's live sessions.yaml / recycle-bin.yaml against a
 * throwaway slug→uuid map, orphaning them against ids that exist nowhere. In
 * production ConfigLoader's configDir *is* that same dir, so deriving from it is
 * identical where it matters and sandboxed where it must be.
 */
export function defaultCliTypeMigrationFiles(configDir: string): CliTypeMigrationFiles {
  return {
    cliTypesFile: path.join(configDir, 'cli-types.yaml'),
    sessionsFile: path.join(configDir, 'sessions.yaml'),
    recycleBinFile: path.join(configDir, 'recycle-bin.yaml'),
    scheduledTasksFile: path.join(configDir, 'scheduled-tasks.yaml'),
    scheduledTaskHistoryFile: path.join(configDir, 'scheduled-task-history.yaml'),
  };
}

/** A pending write: YAML text staged for `filePath` and verified before the swap. */
interface StagedWrite {
  filePath: string;
  text: string;
}

function readYamlFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return YAML.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.warn(`[Config] CLI type migration: could not parse ${filePath}: ${err}`);
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Re-key CLI types by UUID and rewrite every reference to the old slugs.
 * Returns true when a migration was performed, false when it was unnecessary
 * (already migrated, no config) or aborted (nothing was written).
 */
export function migrateCliTypeIds(files: CliTypeMigrationFiles): boolean {
  const rawTypes = readYamlFile(files.cliTypesFile);
  if (!isRecord(rawTypes)) return false;

  const entries = Object.entries(rawTypes).filter(([, cfg]) => isRecord(cfg)) as [string, Record<string, unknown>][];
  if (entries.length === 0) return false;

  // cli-types.yaml is swapped first, so a crash (or a failed rename) between
  // that swap and the downstream ones leaves the types re-keyed while sessions
  // still point at slugs. An `id` on every entry therefore cannot
  // be the whole idempotence story — it would strand those references forever.
  // Instead, rebuild the slug map from the recorded legacyKeys and re-run the
  // downstream rewrite; it stages nothing when there is nothing left to fix,
  // which is the normal case on every subsequent launch.
  if (entries.every(([, cfg]) => typeof cfg.id === 'string' && cfg.id.length > 0)) {
    return repairDanglingSlugReferences(files, entries);
  }

  const slugToId = new Map<string, string>();
  const migrated: Record<string, Record<string, unknown>> = {};
  for (const [slug, cfg] of entries) {
    const id = typeof cfg.id === 'string' && cfg.id ? cfg.id : randomUUID();
    const displayName = (typeof cfg.displayName === 'string' && cfg.displayName)
      || (typeof cfg.name === 'string' && cfg.name)
      || slug;
    slugToId.set(slug, id);
    // Order of insertion is the order of `entries`, so list order survives.
    migrated[id] = { ...cfg, id, displayName, name: displayName, legacyKey: slug };
  }

  const staged: StagedWrite[] = [{ filePath: files.cliTypesFile, text: YAML.stringify(migrated) }];
  collectRekeyedList(files.sessionsFile, 'sessions', slugToId, staged);
  collectRekeyedList(files.recycleBinFile, 'entries', slugToId, staged);
  collectRekeyedList(files.scheduledTasksFile, 'tasks', slugToId, staged);
  collectRekeyedList(files.scheduledTaskHistoryFile, 'entries', slugToId, staged);

  return commit(staged);
}

/**
 * Post-migration sweep for references the swap phase never reached. Uses the
 * `legacyKey` each migrated entry carries, so it needs no state of its own.
 */
function repairDanglingSlugReferences(
  files: CliTypeMigrationFiles,
  entries: [string, Record<string, unknown>][],
): boolean {
  const slugToId = new Map<string, string>();
  for (const [id, cfg] of entries) {
    if (typeof cfg.legacyKey === 'string' && cfg.legacyKey && cfg.legacyKey !== id) {
      slugToId.set(cfg.legacyKey, id);
    }
  }
  if (slugToId.size === 0) return false;

  const staged: StagedWrite[] = [];
  collectRekeyedList(files.sessionsFile, 'sessions', slugToId, staged);
  collectRekeyedList(files.recycleBinFile, 'entries', slugToId, staged);
  collectRekeyedList(files.scheduledTasksFile, 'tasks', slugToId, staged);
  collectRekeyedList(files.scheduledTaskHistoryFile, 'entries', slugToId, staged);
  if (staged.length === 0) return false;

  logger.warn(`[Config] CLI type migration: repairing ${staged.length} file(s) still holding pre-UUID slugs`);
  return commit(staged);
}

/**
 * Stage a `{ <listKey>: [ { cliType, ... } ] }` file with each entry's cliType
 * remapped. Unknown cliType values are left alone — they may reference a CLI
 * type the user deleted, and inventing an id for them would be worse.
 */
function collectRekeyedList(
  filePath: string,
  listKey: string,
  slugToId: Map<string, string>,
  staged: StagedWrite[],
): void {
  const parsed = readYamlFile(filePath);
  if (!isRecord(parsed) || !Array.isArray(parsed[listKey])) return;

  let changed = false;
  const list = (parsed[listKey] as unknown[]).map(item => {
    if (!isRecord(item) || typeof item.cliType !== 'string') return item;
    const id = slugToId.get(item.cliType);
    if (!id || id === item.cliType) return item;
    changed = true;
    return { ...item, cliType: id };
  });
  if (!changed) return;
  staged.push({ filePath, text: YAML.stringify({ ...parsed, [listKey]: list }) });
}

/**
 * Write-then-verify-then-swap. Every staged file is written to `<path>.migrating`
 * and re-parsed; only once all of them succeed are they renamed into place. Any
 * earlier failure aborts with the originals untouched.
 */
function commit(staged: StagedWrite[]): boolean {
  const temps: StagedWrite[] = [];
  try {
    for (const { filePath, text } of staged) {
      const tempPath = filePath + '.migrating';
      fs.writeFileSync(tempPath, text, 'utf8');
      temps.push({ filePath, text: tempPath });
      // Verify the staged bytes parse back before we commit to swapping them in.
      YAML.parse(fs.readFileSync(tempPath, 'utf8'));
    }
  } catch (err) {
    logger.error(`[Config] CLI type migration ABORTED (staging failed, originals untouched): ${err}`);
    cleanup(temps);
    return false;
  }

  for (const { filePath, text: tempPath } of temps) {
    try {
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      // Swap phase: a failure here can leave a partial migration, so shout.
      logger.error(`[Config] CLI type migration: failed to swap ${filePath}: ${err}`);
    }
  }
  logger.info(`[Config] CLI type migration complete — ${staged.length} file(s) re-keyed to UUIDs`);
  return true;
}

function cleanup(temps: StagedWrite[]): void {
  for (const { text: tempPath } of temps) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
  }
}
