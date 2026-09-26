import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BindingStore } from '../src/config/binding-store.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let TEST_DIR: string;

beforeEach(() => { TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-binding-store-')); });
afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

function fresh(): BindingStore {
  const store = new BindingStore(TEST_DIR);
  store.load();
  return store;
}

describe('BindingStore', () => {
  it('returns null for an unknown profile', () => {
    expect(fresh().get('unknown')).toBeNull();
  });

  it('create + setButton round-trip through disk, keyed by a stable id', () => {
    const store = fresh();
    const id = store.create('Main');
    store.setButton(id, 'A', { action: 'keyboard', sequence: '{Enter}' });
    const reloaded = fresh();
    expect(reloaded.get(id)?.A).toEqual({ action: 'keyboard', sequence: '{Enter}' });
    expect(reloaded.list().map(p => p.name)).toEqual(['Main']);
  });

  it('create seeds from bindings without sharing references', () => {
    const store = fresh();
    const seed = { A: { action: 'keyboard' as const, sequence: 'x' } };
    const id = store.create('Copy', seed);
    store.setButton(id, 'A', { action: 'keyboard', sequence: 'changed' });
    expect(seed.A.sequence).toBe('x');
  });

  it('rename changes the name only; delete removes the profile', () => {
    const store = fresh();
    const id = store.create('Old', { A: { action: 'context-menu' } });
    store.rename(id, 'New');
    expect(fresh().list()).toEqual([{ id, name: 'New', bindings: { A: { action: 'context-menu' } } }]);
    store.delete(id);
    expect(fresh().list()).toEqual([]);
  });

  it('setButton on an unknown profile throws', () => {
    expect(() => fresh().setButton('nope', 'A', { action: 'context-menu' })).toThrow('Unknown binding profile');
  });

  it('removeButton deletes just that button', () => {
    const store = fresh();
    const id = store.create('P');
    store.setButton(id, 'A', { action: 'keyboard', sequence: '{Enter}' });
    store.setButton(id, 'B', { action: 'voice', key: 'Space', mode: 'hold' });
    store.removeButton(id, 'A');
    expect(fresh().get(id)).toEqual({ B: { action: 'voice', key: 'Space', mode: 'hold' } });
  });

  it('removeButton does not save when the button does not exist', () => {
    const store = fresh();
    const id = store.create('P', { A: { action: 'context-menu' } });
    const before = fs.readFileSync(store.filePath, 'utf8');
    fs.writeFileSync(store.filePath, before + '\n# marker\n');
    store.removeButton(id, 'Nonexistent');
    expect(fs.readFileSync(store.filePath, 'utf8')).toContain('# marker');
  });

  it('stages a legacy per-CLI file for migration instead of treating it as profiles', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'bindings.yaml'), 'cc:\n  A:\n    action: context-menu\n');
    const store = fresh();
    expect(store.list()).toEqual([]);
    expect(store.takeLegacy()).toEqual({ cc: { A: { action: 'context-menu' } } });
    expect(store.takeLegacy()).toBeNull();
  });

  it('rewrites sequence-list to prompt-tree in legacy maps (PT-7)', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'bindings.yaml'),
      'cc:\n  Y:\n    action: sequence-list\n    sequenceGroup: quick-actions\n',
    );
    expect(fresh().takeLegacy()?.cc.Y.action).toBe('prompt-tree');
  });

  it('rewrites sequence-list to prompt-tree inside profiles and persists it (PT-7)', () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'bindings.yaml'),
      'profiles:\n  p1:\n    name: P\n    bindings:\n      Y:\n        action: sequence-list\n',
    );
    expect(fresh().get('p1')?.Y.action).toBe('prompt-tree');
    expect(fs.readFileSync(path.join(TEST_DIR, 'bindings.yaml'), 'utf8')).toContain('prompt-tree');
  });

  it('importLegacy is ignored once profiles exist', () => {
    const store = fresh();
    store.create('P');
    store.importLegacy({ cc: { A: { action: 'context-menu' } } });
    expect(store.takeLegacy()).toBeNull();
  });
});
