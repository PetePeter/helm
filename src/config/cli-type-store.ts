/**
 * CliTypeStore — manages CLI type configs persisted to config/cli-types.yaml.
 * Each key maps to a CliTypeConfig (name, prompts, commands, patterns, etc.).
 */
import * as path from 'path';
import { normalizeToolConfig } from './loader-helpers.js';
import { loadYaml, saveYaml } from './yaml-store.js';
import { inferCliProvider } from '../session/hooks/hook-providers.js';
import type { CliTypeConfig } from './loader.js';

/**
 * Guarantee every entry carries its identity fields, so callers can rely on
 * `displayName` regardless of how old the YAML on disk is.
 *
 * `mintId` is deliberately off for load/importBulk: a missing `id` is the signal
 * cli-type-migration uses to detect a pre-UUID file, and stamping the slug key in
 * as an id here would make that migration think it had already run.
 * Returns true when anything was filled in, so the caller can persist once.
 */
function normalizeIdentity(key: string, config: CliTypeConfig | undefined, mintId: boolean): boolean {
  if (!config) return false;
  let changed = false;
  if (!config.id && mintId) { config.id = key; changed = true; }
  if (!config.displayName) { config.displayName = config.name || key; changed = true; }
  // Keep the deprecated alias in sync — legacy readers still use it.
  if (config.name !== config.displayName) { config.name = config.displayName; changed = true; }
  return changed;
}

/** A CLI type paired with its canonical map key (the UUID identity). */
export interface ResolvedCliType {
  id: string;
  config: CliTypeConfig;
}

/**
 * Raised when a reference matches several CLI types by display name. Two types
 * may legitimately share a label, so guessing one would silently spawn the wrong
 * CLI — the caller has to disambiguate with an id.
 */
export class AmbiguousCliTypeError extends Error {
  constructor(readonly ref: string, readonly ids: string[]) {
    super(`Ambiguous CLI type "${ref}" — matches ${ids.length} types by display name: ${ids.join(', ')}. Use the CLI type id instead.`);
    this.name = 'AmbiguousCliTypeError';
  }
}

export class CliTypeStore {
  private data: { [key: string]: CliTypeConfig } = {};

  constructor(private readonly configDir: string) {}

  get filePath(): string {
    return path.join(this.configDir, 'cli-types.yaml');
  }

  load(): void {
    this.data = loadYaml<{ [key: string]: CliTypeConfig }>(this.filePath, {});
    // Normalize each entry (migrate legacy command/args/initialPrompt formats).
    // Save back to disk if anything changed so the file reflects current schema.
    let anyChanged = false;
    for (const key of Object.keys(this.data)) {
      if (normalizeToolConfig(this.data[key])) anyChanged = true;
      if (normalizeIdentity(key, this.data[key], false)) anyChanged = true;
      // Provider auto-migration: stamp which CLI family a type speaks, once,
      // inferred from its own fields. Only `undefined` is fillable — `null`
      // is the user's explicit "Not mapped" and must never be re-inferred.
      const config = this.data[key];
      if (config.provider === undefined) {
        const inferred = inferCliProvider(config);
        if (inferred) { config.provider = inferred; anyChanged = true; }
      }
    }
    if (anyChanged) this.save();
  }

  /**
   * THE resolution choke point. Every human- or agent-supplied CLI type
   * reference in the app funnels through here, so there is exactly one answer to
   * "which CLI type is this string?".
   *
   * Resolution order, most to least authoritative:
   *   1. the UUID identity (the map key) — never changes, never ambiguous
   *   2. `legacyKey`, the pre-UUID slug — keeps persisted references working
   *   3. `displayName`, trimmed and case-insensitive — the human-friendly handle
   *
   * A display name shared by two types throws rather than picking one; an
   * unknown reference returns null rather than falling back to anything.
   */
  resolve(ref: string): ResolvedCliType | null {
    if (typeof ref !== 'string') return null;
    const trimmed = ref.trim();
    if (!trimmed) return null;

    const byId = this.data[trimmed];
    if (byId) return { id: trimmed, config: byId };

    for (const [id, config] of Object.entries(this.data)) {
      if (config?.legacyKey === trimmed) return { id, config };
    }

    const wanted = trimmed.toLowerCase();
    const byName = Object.entries(this.data).filter(
      ([, config]) => (config?.displayName ?? config?.name ?? '').trim().toLowerCase() === wanted,
    );
    if (byName.length > 1) throw new AmbiguousCliTypeError(trimmed, byName.map(([id]) => id));
    if (byName.length === 1) return { id: byName[0][0], config: byName[0][1] };

    return null;
  }

  /**
   * Canonical map key for a reference. Delegates to `resolve` — no second
   * implementation. Unknown refs come back unchanged so callers keep producing
   * their own "not found" errors against the string the user actually typed.
   */
  resolveKey(key: string): string {
    return this.resolve(key)?.id ?? key;
  }

  get(key: string): CliTypeConfig | undefined {
    return this.resolve(key)?.config;
  }

  getAll(): { [key: string]: CliTypeConfig } {
    return { ...this.data };
  }

  list(): string[] {
    return Object.keys(this.data);
  }

  add(key: string, config: CliTypeConfig): void {
    if (this.data[key]) throw new Error(`CLI type already exists: ${key}`);
    normalizeIdentity(key, config, true);
    this.data[key] = config;
    this.save();
  }

  /** Update in place. Never re-keys — identity is the map key and is immutable. */
  set(key: string, config: CliTypeConfig): void {
    key = this.resolveKey(key);
    normalizeIdentity(key, config, true);
    this.data[key] = config;
    this.save();
  }

  remove(key: string): void {
    key = this.resolveKey(key);
    if (!this.data[key]) throw new Error(`CLI type not found: ${key}`);
    delete this.data[key];
    this.save();
  }

  /**
   * Set (or clear) which CLI family a type speaks — the Tool mapping
   * dropdown's write path. null persists an EXPLICIT "Not mapped" (not an
   * absent field): the user answered the question, and load()'s migration
   * must never second-guess them by re-inferring.
   */
  setCliTypeProvider(key: string, provider: 'claude' | 'codex' | 'copilot' | null): void {
    key = this.resolveKey(key);
    const config = this.data[key];
    if (!config) throw new Error(`CLI type not found: ${key}`);
    config.provider = provider;
    this.save();
  }

  reorder(index: number, direction: 'up' | 'down'): void {
    const entries = Object.entries(this.data);
    // Guard the source index — out-of-bounds would silently corrupt the map
    // (entries[index] = undefined → "undefined" key after Object.fromEntries).
    if (index < 0 || index >= entries.length) return;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= entries.length) return;
    [entries[index], entries[target]] = [entries[target], entries[index]];
    this.data = Object.fromEntries(entries);
    this.save();
  }

  /**
   * Bulk import — replaces existing entries for the given keys and saves once.
   * Used by profile migration to avoid one write per CLI type.
   */
  importBulk(data: { [key: string]: CliTypeConfig }): void {
    for (const [key, config] of Object.entries(data)) {
      normalizeIdentity(key, config, false);
      this.data[key] = config;
    }
    this.save();
  }

  save(): void {
    saveYaml(this.filePath, this.data);
  }
}
