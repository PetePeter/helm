import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as YAML from 'yaml';
import { atomicWriteFileSync } from '../session/persistence-utils.js';
import { getGlobalPersistencePaths, type GlobalPersistencePaths } from '../session/persistence-paths.js';
import { UserProfileStore } from './user-profile-store.js';

const loadModule = createRequire(import.meta.url);
const lockfile = loadModule('proper-lockfile') as {
  lock(path: string, options: { retries: number; stale: number; update: number }): Promise<() => Promise<void>>;
};

const MIGRATION_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const TEXT_FILE_EXTENSIONS = new Set([
  '.csv', '.html', '.htm', '.ini', '.json', '.jsonl', '.log', '.markdown', '.md',
  '.py', '.toml', '.txt', '.xml', '.yaml', '.yml',
]);

interface MigrationJournal {
  version: 1;
  status: 'in-progress' | 'complete';
  startedAt: number;
  updatedAt: number;
}

export interface ProfileConfigMigrationOptions {
  globalConfigDir: string;
  profileConfigDir: string;
}

/** Move the legacy global config tree into profile 1 before any store seeds defaults. */
export async function migrateProfileConfig(options: ProfileConfigMigrationOptions): Promise<void> {
  const globalConfigDir = resolve(options.globalConfigDir);
  const profileConfigDir = resolve(options.profileConfigDir);
  assertSeparateDirectories(globalConfigDir, profileConfigDir);
  mkdirSync(globalConfigDir, { recursive: true });

  const globalPaths = getGlobalPersistencePaths(globalConfigDir);
  const globalEntryNames = getGlobalEntryNames(globalPaths);
  const journalPath = globalPaths.migrationJournalFile;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(globalConfigDir, {
      retries: 0,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
    });
  } catch (error) {
    // Do not touch the journal without owning the lock; the owner may be
    // completing the migration and writing its final status.
    throw new Error(`Could not acquire the profile config migration lock: ${String(error)}`);
  }

  try {
    const journal = readJournal(journalPath);
    if (journal?.status === 'complete') {
      new UserProfileStore(globalConfigDir).ensureDefaultProfile();
      migrateMobileDeviceOwnership(globalConfigDir);
      return;
    }

    writeJournal(journalPath, 'in-progress', journal?.startedAt);
    mkdirSync(profileConfigDir, { recursive: true });

    const rootNames = existsSync(globalConfigDir) ? readdirSync(globalConfigDir) : [];
    const sourceNames = getSourceNames(rootNames, globalEntryNames);
    const preservedNames = rootNames.filter(name => !sourceNames.includes(name));
    preflightMoves(globalConfigDir, profileConfigDir, sourceNames);

    // Rewrite persisted references in both source files and any entries moved
    // by a prior attempt before making another directory rename. Global text
    // stores also contain paths into config directories that are moving.
    for (const name of sourceNames) {
      rewriteTree(join(globalConfigDir, name), globalConfigDir, profileConfigDir, globalEntryNames);
    }
    const restorePointsName = basename(globalPaths.restorePointsDir).toLowerCase();
    for (const name of preservedNames) {
      if (name.toLowerCase() !== restorePointsName) {
        rewriteTree(join(globalConfigDir, name), globalConfigDir, profileConfigDir, globalEntryNames);
      }
    }
    for (const name of readdirSync(profileConfigDir).filter(name => !globalEntryNames.has(name.toLowerCase()))) {
      rewriteTree(join(profileConfigDir, name), globalConfigDir, profileConfigDir, globalEntryNames);
    }

    for (const name of sourceNames) {
      const sourcePath = join(globalConfigDir, name);
      if (!entryExists(sourcePath)) continue;
      const destinationPath = join(profileConfigDir, name);
      if (entryExists(destinationPath)) {
        throw new Error(`Profile config migration collision at ${destinationPath}`);
      }
      renameSync(sourcePath, destinationPath);
    }

    migrateMobileDeviceOwnership(globalConfigDir);
    new UserProfileStore(globalConfigDir).ensureDefaultProfile();
    writeJournal(journalPath, 'complete', journal?.startedAt);
  } finally {
    await release();
  }
}

function getGlobalEntryNames(paths: GlobalPersistencePaths): Set<string> {
  return new Set(Object.values(paths).map(filePath => basename(filePath).toLowerCase()));
}

function getSourceNames(rootNames: string[], globalEntryNames: ReadonlySet<string>): string[] {
  const insensitive = process.platform === 'win32';
  const normalize = (name: string) => insensitive ? name.toLowerCase() : name;
  const globalNames = new Set([...globalEntryNames].map(normalize));
  const seenGlobalNames = new Map<string, string>();

  for (const name of rootNames) {
    const caseFoldedName = name.toLowerCase();
    if (!globalEntryNames.has(caseFoldedName)) continue;
    const previous = seenGlobalNames.get(caseFoldedName);
    if (previous !== undefined && previous !== name) {
      throw new Error(`Profile config migration found case-colliding global entries: ${previous} and ${name}`);
    }
    seenGlobalNames.set(caseFoldedName, name);
  }

  return rootNames.filter(name => !globalNames.has(normalize(name)));
}

function assertSeparateDirectories(globalConfigDir: string, profileConfigDir: string): void {
  const isInside = (parent: string, child: string) => {
    const childFromParent = relative(parent, child);
    return childFromParent === ''
      || (!isAbsolute(childFromParent) && childFromParent !== '..' && !childFromParent.startsWith(`..${sep}`));
  };
  if (isInside(globalConfigDir, profileConfigDir) || isInside(profileConfigDir, globalConfigDir)) {
    throw new Error('Global and profile config directories must be separate');
  }
}

function preflightMoves(globalConfigDir: string, profileConfigDir: string, names: string[]): void {
  for (const name of names) {
    const sourcePath = join(globalConfigDir, name);
    const destinationPath = join(profileConfigDir, name);
    if (entryExists(sourcePath) && entryExists(destinationPath)) {
      throw new Error(`Profile config migration collision at ${destinationPath}`);
    }
  }
}

function entryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function rewriteTree(
  entryPath: string,
  oldRoot: string,
  newRoot: string,
  globalEntryNames: ReadonlySet<string>,
): void {
  const entry = lstatSync(entryPath);
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    for (const name of readdirSync(entryPath)) {
      rewriteTree(join(entryPath, name), oldRoot, newRoot, globalEntryNames);
    }
    return;
  }
  if (!entry.isFile()) return;
  if (!TEXT_FILE_EXTENSIONS.has(extname(entryPath).toLowerCase())) return;

  const content = readFileSync(entryPath);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return; // Binary attachments are moved byte-for-byte.
  }
  const rewritten = rewriteConfigRootReferences(text, oldRoot, newRoot, globalEntryNames);
  if (rewritten !== text) {
    atomicWriteFileSync(entryPath, rewritten, { mode: statSync(entryPath).mode & 0o777 });
  }
}

function rewriteConfigRootReferences(
  content: string,
  oldRoot: string,
  newRoot: string,
  globalEntryNames: ReadonlySet<string>,
): string {
  const oldVariants = pathVariants(oldRoot);
  const newVariants = pathVariants(newRoot);
  let result = content;
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  for (let index = 0; index < oldVariants.length; index++) {
    const oldVariant = oldVariants[index];
    const newVariant = newVariants[index];
    const expression = new RegExp(`${escapeRegExp(oldVariant)}(?=$|[\\\\/])`, flags);
    result = result.replace(expression, (match, offset: number, source: string) => {
      const suffix = source.slice(offset + match.length).replace(/^[\\/]+/, '');
      const firstEntry = suffix
        .split(/[\\/]+/, 1)[0]
        ?.split(/[\s"'`),;\]}]+/, 1)[0]
        ?.toLowerCase();
      if (!firstEntry || globalEntryNames.has(firstEntry)) return match;
      return newVariant;
    });
  }
  return result;
}

function pathVariants(value: string): string[] {
  const forward = value.replace(/\\/g, '/');
  const escapedBackslashes = value.replace(/\\/g, '\\\\');
  return [value, forward, escapedBackslashes];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function migrateMobileDeviceOwnership(globalConfigDir: string): void {
  const filePath = getGlobalPersistencePaths(globalConfigDir).mobileDevicesFile;
  if (!existsSync(filePath)) return;
  const parsed = YAML.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.devices)) {
    throw new Error(`Invalid mobile device registry: ${filePath}`);
  }
  let changed = false;
  const devices = parsed.devices.map(device => {
    if (!isRecord(device) || typeof device.userProfileId === 'string') return device;
    changed = true;
    return { ...device, userProfileId: '1' };
  });
  if (!changed) return;
  atomicWriteFileSync(filePath, YAML.stringify({ ...parsed, devices }));
}

function readJournal(filePath: string): MigrationJournal | null {
  if (!existsSync(filePath)) return null;
  const parsed = YAML.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!isRecord(parsed)
    || parsed.version !== MIGRATION_VERSION
    || (parsed.status !== 'in-progress' && parsed.status !== 'complete')
    || typeof parsed.startedAt !== 'number'
    || typeof parsed.updatedAt !== 'number') {
    throw new Error(`Invalid profile config migration journal: ${filePath}`);
  }
  return {
    version: MIGRATION_VERSION,
    status: parsed.status,
    startedAt: parsed.startedAt,
    updatedAt: parsed.updatedAt,
  };
}

function writeJournal(filePath: string, status: MigrationJournal['status'], startedAt = Date.now()): void {
  const now = Date.now();
  const journal: MigrationJournal = {
    version: MIGRATION_VERSION,
    status,
    startedAt,
    updatedAt: now,
  };
  atomicWriteFileSync(filePath, YAML.stringify(journal));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
