/**
 * profile-migrator — one-time migration from profiles/default.yaml to the three
 * dedicated stores. Idempotent: only populates empty stores, then renames the
 * source file so the migration never runs again.
 *
 * The source rename happens BEFORE any store writes so a partial failure in
 * one store cannot leave migration in a state where it re-runs on next boot
 * and clobbers user changes made between attempts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import logger from '../utils/logger.js';
import type { CliTypeStore } from './cli-type-store.js';
import type { BindingStore } from './binding-store.js';
import type { InputConfigStore } from './input-config-store.js';

export function migrateFromProfile(
  configDir: string,
  cliTypeStore: CliTypeStore,
  bindingStore: BindingStore,
  inputConfigStore: InputConfigStore,
): boolean {
  const profilePath = path.join(configDir, 'profiles', 'default.yaml');
  if (!fs.existsSync(profilePath)) return false;

  let raw: any;
  try {
    raw = YAML.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch {
    logger.warn('[Config] Profile migration: could not parse profiles/default.yaml, skipping');
    return false;
  }
  if (!raw) return false;

  // Rename FIRST so a partial failure on subsequent writes doesn't re-run
  // migration on next boot (which would overwrite any post-migration edits).
  const migratedPath = profilePath + '.migrated';
  fs.renameSync(profilePath, migratedPath);
  logger.info('[Config] Profile migration started — source renamed to .migrated');

  try {
    // Migrate CLI types only if the store is currently empty (avoids overwriting user data).
    if (raw.tools && typeof raw.tools === 'object' && cliTypeStore.list().length === 0) {
      cliTypeStore.importBulk(raw.tools);
      logger.info('[Config] Migrated CLI types from profile');
    }

    // Stage legacy per-CLI bindings; ConfigLoader folds them into a profile.
    // importLegacy is a no-op when the store already holds data.
    if (raw.bindings && typeof raw.bindings === 'object') {
      bindingStore.importLegacy(raw.bindings);
      logger.info('[Config] Staged bindings from profile for migration');
    }

    // Migrate input config only on first migration (file absence is our flag).
    // Once the file exists, subsequent runs must not re-import or they would
    // clobber edits the user has made through the Settings UI.
    if (!fs.existsSync(inputConfigStore.filePath)) {
      inputConfigStore.importFrom({
        sticks: raw.sticks,
        dpad: raw.dpad,
        activity: raw.activity,
        chipActions: raw.chipActions,
      });
      inputConfigStore.save();
      logger.info('[Config] Migrated input config from profile');
    }
  } catch (err) {
    // Source file already renamed — won't re-run. Partial state is acceptable;
    // the user can inspect profiles/default.yaml.migrated if needed.
    logger.error(`[Config] Profile migration error: ${err}`);
  }

  logger.info('[Config] Profile migration complete');
  return true;
}
