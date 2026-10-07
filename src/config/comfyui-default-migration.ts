import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import * as YAML from 'yaml';
import logger from '../utils/logger.js';

const MIGRATION_ID = 'comfyui-tool-profiles-v1';
const PROFILE_SIZE_FIELDS = ['width', 'height', 'fps'] as const;
const PREVIOUS_DEFAULT_PROFILE_NAMES: Record<string, string> = {
  video: '1080p Landscape',
  'video-1080p-portrait': '1080p Portrait',
};

export interface ComfyUiDefaultMigrationFiles {
  cliTypesFile: string;
  migrationStateFile: string;
  shippedCliTypesFile: string;
}

interface ReadResult {
  ok: boolean;
  value?: unknown;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readYaml(filePath: string): ReadResult {
  if (!fs.existsSync(filePath)) return { ok: true, value: undefined };
  try {
    return { ok: true, value: YAML.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    logger.warn(`[Config] ComfyUI defaults migration: could not parse ${filePath}: ${error}`);
    return { ok: false };
  }
}

function writeYamlAtomically(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.migrating`;
  try {
    fs.writeFileSync(tempPath, YAML.stringify(value), 'utf8');
    YAML.parse(fs.readFileSync(tempPath, 'utf8'));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function findTargetId(
  cliTypes: Record<string, any>,
  defaultId: string,
  defaultType: Record<string, any>,
): string | null {
  if (Object.hasOwn(cliTypes, defaultId)) {
    const current = cliTypes[defaultId];
    if (isRecord(current) && (isRecord(current.comfyUi)
      || String(current.displayName ?? current.name ?? '').trim().toLowerCase()
        === String(defaultType.displayName ?? defaultType.name ?? '').trim().toLowerCase())) return defaultId;
    return null;
  }

  const name = String(defaultType.displayName ?? defaultType.name ?? '').trim().toLowerCase();
  const matches = Object.entries(cliTypes)
    .filter(([, current]) => isRecord(current)
      && isRecord(current.comfyUi)
      && String(current.displayName ?? current.name ?? '').trim().toLowerCase() === name)
    .map(([id]) => id);
  return matches.length === 1 ? matches[0] : null;
}

function mergeProfile(existing: Record<string, any>, defaults: Record<string, any>): Record<string, any> {
  const merged = { ...existing };
  const legacyName = defaults.id === 'image' ? 'Image' : defaults.id === 'video' ? 'Video' : undefined;
  if (!existing.name || existing.name === legacyName || existing.name === defaults.name
    || existing.name === PREVIOUS_DEFAULT_PROFILE_NAMES[defaults.id]) {
    merged.name = defaults.name;
  }

  // A profile id names a shipped preset. Keep its graph and user tuning, while
  // moving only mapped size/fps inputs to the new preset values.
  const mappings = isRecord(existing.mappings) ? existing.mappings : {};
  const nextDefaults = { ...(isRecord(existing.defaults) ? existing.defaults : {}) };
  let defaultsChanged = false;
  for (const field of PROFILE_SIZE_FIELDS) {
    const value = defaults.defaults?.[field];
    if (typeof value !== 'number' || !isRecord(defaults.mappings?.[field]) || !isRecord(mappings[field])) continue;
    if (nextDefaults[field] !== value) {
      nextDefaults[field] = value;
      defaultsChanged = true;
    }
  }
  if (defaultsChanged) merged.defaults = nextDefaults;
  return merged;
}

function mergeComfyUiConfig(current: unknown, defaults: Record<string, any>): { value: unknown; changed: boolean } {
  if (!isRecord(current)) return { value: structuredClone(defaults), changed: true };

  const merged = { ...current };
  let changed = false;
  if (typeof merged.endpoint !== 'string' || !merged.endpoint.trim()) {
    merged.endpoint = defaults.endpoint;
    changed = true;
  }

  const profiles: unknown[] = Array.isArray(merged.profiles) ? [...merged.profiles] : [];
  if (!Array.isArray(merged.profiles)) changed = true;
  for (const defaultProfile of defaults.profiles as Record<string, any>[]) {
    const index = profiles.findIndex(profile => isRecord(profile) && profile.id === defaultProfile.id);
    if (index < 0) {
      profiles.push(structuredClone(defaultProfile));
      changed = true;
      continue;
    }
    const existingProfile = profiles[index];
    if (!isRecord(existingProfile)) continue;
    const nextProfile = mergeProfile(existingProfile, defaultProfile);
    if (JSON.stringify(nextProfile) !== JSON.stringify(existingProfile)) {
      profiles[index] = nextProfile;
      changed = true;
    }
  }
  if (changed) merged.profiles = profiles;
  return { value: merged, changed };
}

/** Add the shipped Image/Video tools to an existing install once, preserving custom config. */
export function migrateComfyUiToolDefaults(files: ComfyUiDefaultMigrationFiles): boolean {
  const stateResult = readYaml(files.migrationStateFile);
  if (!stateResult.ok) return false;
  const state = isRecord(stateResult.value) ? stateResult.value : {};
  const applied = Array.isArray(state.applied) ? state.applied.filter((item: unknown) => typeof item === 'string') : [];
  if (applied.includes(MIGRATION_ID)) return false;

  const shippedResult = readYaml(files.shippedCliTypesFile);
  const currentResult = readYaml(files.cliTypesFile);
  if (!shippedResult.ok || !currentResult.ok || !isRecord(shippedResult.value)) return false;

  const shippedTypes = shippedResult.value;
  const defaults = Object.entries(shippedTypes)
    .filter(([, config]) => isRecord(config) && isRecord(config.comfyUi) && Array.isArray(config.comfyUi.profiles))
    .map(([id, config]) => ({ id, config: config as Record<string, any> }));
  if (defaults.length !== 2) {
    logger.warn(`[Config] ComfyUI defaults migration: expected two shipped ComfyUI tools, found ${defaults.length}`);
    return false;
  }

  const currentTypes = isRecord(currentResult.value) ? currentResult.value : {};
  const nextTypes = { ...currentTypes };
  let cliTypesChanged = false;
  for (const { id, config: defaultType } of defaults) {
    const targetId = findTargetId(nextTypes, id, defaultType);
    if (!targetId) {
      // A shipped UUID may already belong to an unrelated CLI entry. Preserve
      // it and allocate one stable replacement; name matching finds this entry
      // on later starts if migration state could not be written.
      const newId = Object.hasOwn(nextTypes, id) ? randomUUID() : id;
      nextTypes[newId] = { ...structuredClone(defaultType), id: newId };
      cliTypesChanged = true;
      continue;
    }

    const currentType = nextTypes[targetId];
    if (!isRecord(currentType)) continue;
    const comfyUi = mergeComfyUiConfig(currentType.comfyUi, defaultType.comfyUi);
    if (!comfyUi.changed) continue;
    nextTypes[targetId] = { ...currentType, comfyUi: comfyUi.value };
    cliTypesChanged = true;
  }

  try {
    if (cliTypesChanged) writeYamlAtomically(files.cliTypesFile, nextTypes);
  } catch (error) {
    logger.error(`[Config] ComfyUI defaults migration failed: ${error}`);
    return false;
  }

  const nextApplied = [...new Set([...applied, MIGRATION_ID])];
  try {
    writeYamlAtomically(files.migrationStateFile, { ...state, applied: nextApplied });
  } catch (error) {
    // The CLI types may already be on disk. Return that fact so ConfigLoader
    // reloads the store now; the idempotent migration can retry its marker next launch.
    logger.error(`[Config] ComfyUI migration marker write failed: ${error}`);
  }
  return cliTypesChanged;
}

export function defaultComfyUiMigrationFiles(configDir: string, shippedCliTypesFile: string): ComfyUiDefaultMigrationFiles {
  return {
    cliTypesFile: path.join(configDir, 'cli-types.yaml'),
    migrationStateFile: path.join(configDir, 'config-migrations.yaml'),
    shippedCliTypesFile,
  };
}
