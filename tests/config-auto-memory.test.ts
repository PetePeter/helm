/**
 * ConfigLoader autoMemory section: one global recording model plus the
 * auto-save / auto-recall switches. Absent or malformed means the defaults,
 * a model that cannot run silently is refused rather than stored, and the
 * section round-trips through settings.yaml.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { makeTempRoot } from './helpers/temp-root.js';

let root: string | undefined;

function writeYaml(relativePath: string, data: unknown): void {
  const fullPath = path.join(root!, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, YAML.stringify(data), 'utf8');
}

// CLI types are keyed by UUID; an entry without its `id` is re-keyed on load.
const API_ID = '11111111-1111-4111-8111-111111111111';
const CLI_ID = '22222222-2222-4222-8222-222222222222';
const COMFY_ID = '33333333-3333-4333-8333-333333333333';

const BROKEN_ID = '44444444-4444-4444-8444-444444444444';

const CLI_TYPES = {
  [API_ID]: { id: API_ID, name: 'Local model', api: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen', allowedTools: [] } },
  [CLI_ID]: { id: CLI_ID, name: 'Claude Code', command: 'claude' },
  [BROKEN_ID]: { id: BROKEN_ID, name: 'Half-edited', api: { baseUrl: '', allowedTools: [] } },
  [COMFY_ID]: { id: COMFY_ID, name: 'Comfy', comfyUi: { baseUrl: 'http://127.0.0.1:8188', profiles: [] } },
};

function makeLoader(settings: Record<string, unknown> = {}): ConfigLoader {
  root ??= makeTempRoot('helm-auto-memory-');
  writeYaml('cli-types.yaml', CLI_TYPES);
  writeYaml('bindings.yaml', {});
  writeYaml('settings.yaml', { hapticFeedback: true, notifications: true, escProtectionEnabled: true, ...settings });
  writeYaml('input-config.yaml', {});
  const loader = new ConfigLoader(root);
  loader.load();
  return loader;
}

function reload(): ConfigLoader {
  const loader = new ConfigLoader(root!);
  loader.load();
  return loader;
}

describe('autoMemory settings', () => {
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('defaults to no recording model with both switches on', () => {
    expect(makeLoader().getAutoMemoryConfig()).toEqual({ recordingModel: '', autoSave: true, autoRecall: true });
  });

  it('degrades a malformed section to the defaults', () => {
    const loader = makeLoader({ autoMemory: { recordingModel: 7, autoSave: 'yes', autoRecall: null } });
    expect(loader.getAutoMemoryConfig()).toEqual({ recordingModel: '', autoSave: true, autoRecall: true });
  });

  it('persists the picked model and both switches across a reload', () => {
    const loader = makeLoader();
    loader.setAutoMemoryConfig({ recordingModel: API_ID, autoSave: false });
    loader.setAutoMemoryConfig({ autoRecall: false });

    expect(reload().getAutoMemoryConfig()).toEqual({ recordingModel: API_ID, autoSave: false, autoRecall: false });
  });

  it('stores the id when the model is picked by its display name', () => {
    const loader = makeLoader();
    loader.setAutoMemoryConfig({ recordingModel: 'Local model' });
    expect(loader.getAutoMemoryConfig().recordingModel).toBe(API_ID);
  });

  it('refuses a real CLI type until the headless runner exists, keeping the old pick', () => {
    const loader = makeLoader();
    loader.setAutoMemoryConfig({ recordingModel: API_ID });

    expect(() => loader.setAutoMemoryConfig({ recordingModel: CLI_ID })).toThrow(/headless runner/);
    expect(() => loader.setAutoMemoryConfig({ recordingModel: COMFY_ID })).toThrow(/cannot record/i);
    expect(() => loader.setAutoMemoryConfig({ recordingModel: BROKEN_ID })).toThrow(/API settings are incomplete/);
    expect(() => loader.setAutoMemoryConfig({ recordingModel: 'no-such-type' })).toThrow(/Unknown CLI type/);
    expect(reload().getAutoMemoryConfig().recordingModel).toBe(API_ID);
  });

  it('clears the model with an empty pick', () => {
    const loader = makeLoader({ autoMemory: { recordingModel: API_ID } });
    loader.setAutoMemoryConfig({ recordingModel: '' });
    expect(reload().getAutoMemoryConfig().recordingModel).toBe('');
  });

  it('lists API tools as pickable and real CLI types as waiting for the headless runner', () => {
    expect(makeLoader().getRecordingModelOptions()).toEqual([
      { id: API_ID, name: 'Local model', kind: 'api', available: true },
      { id: CLI_ID, name: 'Claude Code', kind: 'cli', available: false, note: 'needs headless runner' },
      { id: BROKEN_ID, name: 'Half-edited', kind: 'api', available: false, note: 'API settings are incomplete' },
    ]);
  });
});
