/**
 * Profile migration tests — verifies one-time migration from profiles/default.yaml
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CliTypeStore } from '../src/config/cli-type-store.js';
import { BindingStore } from '../src/config/binding-store.js';
import { InputConfigStore } from '../src/config/input-config-store.js';
import { migrateFromProfile } from '../src/config/profile-migrator.js';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

const TEST_DIR = path.join(process.cwd(), '.test-migration-' + Date.now());

function writeYaml(rel: string, data: unknown) {
  const p = path.join(TEST_DIR, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, YAML.stringify(data), 'utf8');
}

beforeEach(() => fs.mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

function makeStores() {
  const ct = new CliTypeStore(TEST_DIR);
  const b = new BindingStore(TEST_DIR);
  const ic = new InputConfigStore(TEST_DIR);
  ct.load(); b.load(); ic.load();
  return { ct, b, ic };
}

const PROFILE = {
  name: 'Default',
  version: 1,
  tools: { cc: { name: 'Claude', initialPrompt: [] } },
  bindings: { cc: { A: { action: 'keyboard', sequence: '{Enter}' } } },
  workingDirectories: [{ name: 'Projects', path: 'X:\\coding' }],
};

describe('migrateFromProfile', () => {
  it('returns false and is a no-op when no profile file exists', () => {
    const { ct, b, ic } = makeStores();
    expect(migrateFromProfile(TEST_DIR, ct, b, ic)).toBe(false);
    expect(ct.list()).toEqual([]);
  });

  it('migrates tools, bindings, and input config from profile YAML', () => {
    writeYaml('profiles/default.yaml', PROFILE);
    const { ct, b, ic } = makeStores();
    migrateFromProfile(TEST_DIR, ct, b, ic);
    expect(ct.get('cc')?.name).toBe('Claude');
    // Bindings are staged as legacy maps; ConfigLoader folds them into a profile.
    expect(b.takeLegacy()?.cc.A).toEqual({ action: 'keyboard', sequence: '{Enter}' });
  });

  it('renames profiles/default.yaml to .migrated', () => {
    writeYaml('profiles/default.yaml', PROFILE);
    const { ct, b, ic } = makeStores();
    migrateFromProfile(TEST_DIR, ct, b, ic);
    expect(fs.existsSync(path.join(TEST_DIR, 'profiles', 'default.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_DIR, 'profiles', 'default.yaml.migrated'))).toBe(true);
  });

  it('does not overwrite existing CLI types (idempotent for tools)', () => {
    writeYaml('profiles/default.yaml', PROFILE);
    const { ct, b, ic } = makeStores();
    ct.add('cc', { name: 'Existing', initialPrompt: [] });
    migrateFromProfile(TEST_DIR, ct, b, ic);
    expect(ct.get('cc')?.name).toBe('Existing');
  });

  it('second call is a no-op (profile renamed after first run)', () => {
    writeYaml('profiles/default.yaml', PROFILE);
    const { ct, b, ic } = makeStores();
    migrateFromProfile(TEST_DIR, ct, b, ic);
    ct.remove('cc');
    // Second call — source file gone, should not re-add
    expect(migrateFromProfile(TEST_DIR, ct, b, ic)).toBe(false);
    expect(ct.list()).toEqual([]);
  });
});
