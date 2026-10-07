import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { cloneDefaultComfyUiConfigForKind } from '../session/comfyui/comfyui-config.js';
import logger from '../utils/logger.js';

const MIGRATION_ID = 'comfyui-tool-profiles-v6';
const DEFAULT_COMFYUI_TYPES = [
  {
    id: '3cef90de-c638-49b5-942c-aa7c198fc294',
    name: 'ComfyUI Image',
    displayName: 'ComfyUI Image',
    comfyUi: cloneDefaultComfyUiConfigForKind('image'),
  },
  {
    id: '36ccf04a-e326-4f05-b525-3d1150fa8497',
    name: 'ComfyUI Video',
    displayName: 'ComfyUI Video',
    comfyUi: cloneDefaultComfyUiConfigForKind('video'),
  },
];
const PREVIOUS_DEFAULT_CHECKPOINTS: Record<string, string> = {
  'image-lustify-v8-apex': 'lustifySDXLNSFW_apexV8.safetensors',
};
// Presets that shipped once and were withdrawn: FLUX FP8 decodes to NaN noise
// on ROCm, so the migration takes it back out of tools that received it.
const RETIRED_PROFILE_IDS = new Set(['image-flux-dev-fp8']);
const PREVIOUS_DEFAULT_PROFILE_NAMES: Record<string, string> = {
  image: '512x512',
  video: '1080p Landscape',
  'video-1080p-portrait': '1080p Portrait',
};

export interface ComfyUiDefaultMigrationFiles {
  cliTypesFile: string;
  migrationStateFile: string;
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
    if (isRecord(current) && isRecord(current.comfyUi)) return defaultId;
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

  // Fill missing size/fps defaults without replacing user values, then correct
  // the previous LUSTIFY filename only when it is still unchanged.
  const mappings = isRecord(existing.mappings) ? existing.mappings : {};
  const nextDefaults = { ...(isRecord(existing.defaults) ? existing.defaults : {}) };
  let defaultsChanged = false;
  for (const field of ['width', 'height', 'fps'] as const) {
    const value = defaults.defaults?.[field];
    if (nextDefaults[field] !== undefined || typeof value !== 'number'
      || !isRecord(defaults.mappings?.[field]) || !isRecord(mappings[field])) continue;
    nextDefaults[field] = value;
    defaultsChanged = true;
  }
  if (defaultsChanged) merged.defaults = nextDefaults;

  const previousCheckpoint = PREVIOUS_DEFAULT_CHECKPOINTS[defaults.id];
  const existingWorkflow = isRecord(existing.workflow) ? existing.workflow : undefined;
  const existingLoader = existingWorkflow && isRecord(existingWorkflow['1']) ? existingWorkflow['1'] : undefined;
  const existingLoaderInputs = existingLoader && isRecord(existingLoader.inputs) ? existingLoader.inputs : undefined;
  const defaultWorkflow = isRecord(defaults.workflow) ? defaults.workflow : undefined;
  const defaultLoader = defaultWorkflow && isRecord(defaultWorkflow['1']) ? defaultWorkflow['1'] : undefined;
  const defaultLoaderInputs = defaultLoader && isRecord(defaultLoader.inputs) ? defaultLoader.inputs : undefined;
  if (previousCheckpoint
    && existingLoader?.class_type === 'CheckpointLoaderSimple'
    && defaultLoader?.class_type === 'CheckpointLoaderSimple'
    && existingLoaderInputs?.ckpt_name === previousCheckpoint
    && typeof defaultLoaderInputs?.ckpt_name === 'string') {
    merged.workflow = structuredClone(existing.workflow);
    merged.workflow['1'].inputs.ckpt_name = defaultLoaderInputs.ckpt_name;
  }

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
  // Absent only: a tool saved with the command cleared has opted out of auto-start.
  if (merged.startCommand === undefined && typeof defaults.startCommand === 'string') {
    merged.startCommand = defaults.startCommand;
    changed = true;
  }

  const currentProfiles: unknown[] = Array.isArray(merged.profiles) ? merged.profiles : [];
  const profiles = currentProfiles.filter(profile => !isRecord(profile) || !RETIRED_PROFILE_IDS.has(profile.id));
  if (!Array.isArray(merged.profiles) || profiles.length !== currentProfiles.length) changed = true;
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

/** Add shipped presets only to ComfyUI tools a user already configured. */
export function migrateComfyUiToolDefaults(files: ComfyUiDefaultMigrationFiles): boolean {
  const stateResult = readYaml(files.migrationStateFile);
  if (!stateResult.ok) return false;
  const state = isRecord(stateResult.value) ? stateResult.value : {};
  const applied = Array.isArray(state.applied) ? state.applied.filter((item: unknown) => typeof item === 'string') : [];
  if (applied.includes(MIGRATION_ID)) return false;

  const currentResult = readYaml(files.cliTypesFile);
  if (!currentResult.ok) return false;

  const currentTypes = isRecord(currentResult.value) ? currentResult.value : {};
  const nextTypes = { ...currentTypes };
  let cliTypesChanged = false;
  let foundConfiguredTool = false;
  for (const [id, currentType] of Object.entries(nextTypes)) {
    if (!isRecord(currentType) || !isRecord(currentType.comfyUi)) continue;
    foundConfiguredTool = true;
    if (currentType.noPromptCache === undefined) {
      nextTypes[id] = { ...currentType, noPromptCache: true };
      cliTypesChanged = true;
    }
  }

  for (const defaultType of DEFAULT_COMFYUI_TYPES) {
    const targetId = findTargetId(nextTypes, defaultType.id, defaultType);
    if (!targetId) continue;

    const currentType = nextTypes[targetId];
    if (!isRecord(currentType)) continue;
    const comfyUi = mergeComfyUiConfig(currentType.comfyUi, defaultType.comfyUi);
    const nextType = { ...currentType };
    let typeChanged = false;
    if (comfyUi.changed) {
      nextType.comfyUi = comfyUi.value;
      typeChanged = true;
    }
    if (!typeChanged) continue;
    nextTypes[targetId] = nextType;
    cliTypesChanged = true;
  }

  // Clean installs do not opt into ComfyUI. Leave migration unapplied so a
  // later locally configured ComfyUI tool can still receive these presets.
  if (!foundConfiguredTool) return false;

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

export function defaultComfyUiMigrationFiles(configDir: string): ComfyUiDefaultMigrationFiles {
  return {
    cliTypesFile: path.join(configDir, 'cli-types.yaml'),
    migrationStateFile: path.join(configDir, 'config-migrations.yaml'),
  };
}
