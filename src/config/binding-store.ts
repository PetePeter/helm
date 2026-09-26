/**
 * BindingStore — named gamepad binding profiles persisted to config/bindings.yaml.
 *
 * Why profiles: bindings used to be keyed per CLI type, so every tool carried a
 * near-identical copy of the same button map. A profile is shared; each CLI type
 * points at one via `bindingProfileId` (or none). Profile ids are opaque and
 * stable so a rename touches only `name`.
 *
 * On-disk shape: `{ profiles: { <id>: { name, bindings } } }`. The pre-profile
 * shape (`{ <cliType>: ButtonBindings }`) is recognised on load and held as
 * `legacy` for ConfigLoader to fold into a profile — the store has no view of
 * CLI types, so it cannot decide which tools the result belongs to.
 */
import * as path from 'path';
import { randomUUID } from 'crypto';
import { loadYaml, saveYaml } from './yaml-store.js';
import type { Binding, ButtonBindings } from './loader.js';

export interface BindingProfile {
  name: string;
  bindings: ButtonBindings;
}

export interface BindingProfileSummary extends BindingProfile {
  id: string;
}

type LegacyBindings = { [cliType: string]: ButtonBindings };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** PT-7: 'sequence-list' was renamed to 'prompt-tree'. Returns true if anything changed. */
function migrateLegacyActions(maps: Iterable<ButtonBindings>): boolean {
  let changed = false;
  for (const bindings of maps) {
    for (const binding of Object.values(bindings ?? {})) {
      if ((binding as { action?: string }).action === 'sequence-list') {
        (binding as { action: string }).action = 'prompt-tree';
        changed = true;
      }
    }
  }
  return changed;
}

export class BindingStore {
  private profiles: { [id: string]: BindingProfile } = {};
  private legacy: LegacyBindings | null = null;

  constructor(private readonly configDir: string) {}

  get filePath(): string {
    return path.join(this.configDir, 'bindings.yaml');
  }

  load(): void {
    const raw = loadYaml<unknown>(this.filePath, {});
    this.profiles = {};
    this.legacy = null;
    if (isRecord(raw) && isRecord(raw.profiles)) {
      this.profiles = raw.profiles as { [id: string]: BindingProfile };
      for (const profile of Object.values(this.profiles)) profile.bindings ??= {};
      if (migrateLegacyActions(Object.values(this.profiles).map(p => p.bindings))) this.save();
    } else if (isRecord(raw) && Object.keys(raw).length > 0) {
      this.importLegacy(raw as LegacyBindings);
    }
  }

  /** Stage a pre-profile `{ cliType: ButtonBindings }` map for ConfigLoader to migrate. */
  importLegacy(data: LegacyBindings): void {
    // Never clobber real data: profiles on disk, or legacy maps already staged.
    if (Object.keys(this.profiles).length > 0 || this.legacy) return;
    const maps: LegacyBindings = {};
    for (const [key, value] of Object.entries(data)) {
      if (isRecord(value)) maps[key] = value as ButtonBindings;
    }
    migrateLegacyActions(Object.values(maps));
    this.legacy = Object.keys(maps).length > 0 ? maps : null;
  }

  /** Hand the staged legacy maps to the caller exactly once. */
  takeLegacy(): LegacyBindings | null {
    const legacy = this.legacy;
    this.legacy = null;
    return legacy;
  }

  has(id: string): boolean {
    return id in this.profiles;
  }

  get(id: string): ButtonBindings | null {
    return this.profiles[id]?.bindings ?? null;
  }

  list(): BindingProfileSummary[] {
    return Object.entries(this.profiles).map(([id, p]) => ({ id, name: p.name, bindings: p.bindings }));
  }

  /** Create a profile; `id` is only supplied by migration, which needs a well-known one. */
  create(name: string, bindings: ButtonBindings = {}, id: string = randomUUID()): string {
    if (this.profiles[id]) throw new Error(`Binding profile already exists: ${id}`);
    this.profiles[id] = { name, bindings: structuredClone(bindings) };
    this.save();
    return id;
  }

  rename(id: string, name: string): void {
    this.mustGet(id).name = name;
    this.save();
  }

  delete(id: string): void {
    this.mustGet(id);
    delete this.profiles[id];
    this.save();
  }

  setButton(id: string, button: string, binding: Binding): void {
    this.mustGet(id).bindings[button] = binding;
    this.save();
  }

  removeButton(id: string, button: string): void {
    // Skip the disk write when there is nothing to delete — avoids needless mtime churn.
    if (!this.profiles[id]?.bindings[button]) return;
    delete this.profiles[id].bindings[button];
    this.save();
  }

  save(): void {
    saveYaml(this.filePath, { profiles: this.profiles });
  }

  private mustGet(id: string): BindingProfile {
    const profile = this.profiles[id];
    if (!profile) throw new Error(`Unknown binding profile: ${id}`);
    return profile;
  }
}
