/**
 * ConfigLoader autoMemory section: one global recording model plus the
 * auto-save / auto-recall switches. Absent or malformed means the defaults,
 * a model that cannot run silently is refused rather than stored, and the
 * section round-trips through settings.yaml.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { DEFAULT_JUDGE_PROMPT } from '../src/types/auto-memory.js';
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
const SHELL_ID = '55555555-5555-4555-8555-555555555555';
const OWN_ID = '66666666-6666-4666-8666-666666666666';
const HALF_ID = '77777777-7777-4777-8777-777777777777';

const CLI_TYPES = {
  [API_ID]: { id: API_ID, name: 'Local model', api: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen', allowedTools: [] } },
  [CLI_ID]: { id: CLI_ID, name: 'Claude Code', command: 'claude' },
  [BROKEN_ID]: { id: BROKEN_ID, name: 'Half-edited', api: { baseUrl: '', allowedTools: [] } },
  [COMFY_ID]: { id: COMFY_ID, name: 'Comfy', comfyUi: { baseUrl: 'http://127.0.0.1:8188', profiles: [] } },
  [SHELL_ID]: { id: SHELL_ID, name: 'cmd', spawnCommand: 'cmd.exe' },
  [OWN_ID]: { id: OWN_ID, name: 'Aider', spawnCommand: 'aider', headlessCommand: 'aider --message-file "{promptFile}" > "{outputFile}"' },
  [HALF_ID]: { id: HALF_ID, name: 'Half a command', spawnCommand: 'tool', headlessCommand: 'tool --print' },
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

  it('defaults to no recording model with both switches on and the default judge prompt', () => {
    expect(makeLoader().getAutoMemoryConfig()).toEqual({ recordingModel: '', autoSave: true, autoRecall: true, judgePrompt: '' });
  });

  it('degrades a malformed section to the defaults', () => {
    const loader = makeLoader({ autoMemory: { recordingModel: 7, autoSave: 'yes', autoRecall: null, judgePrompt: 3 } });
    expect(loader.getAutoMemoryConfig()).toEqual({ recordingModel: '', autoSave: true, autoRecall: true, judgePrompt: '' });
  });

  it('persists the picked model and both switches across a reload', () => {
    const loader = makeLoader();
    loader.setAutoMemoryConfig({ recordingModel: API_ID, autoSave: false });
    loader.setAutoMemoryConfig({ autoRecall: false });

    expect(reload().getAutoMemoryConfig()).toEqual({ recordingModel: API_ID, autoSave: false, autoRecall: false, judgePrompt: '' });
  });

  it('persists an edited judge prompt, and a blank or default one clears it back to the default', () => {
    const loader = makeLoader();
    loader.setAutoMemoryConfig({ recordingModel: API_ID, judgePrompt: 'Only save ports.' });
    expect(reload().getAutoMemoryConfig()).toMatchObject({ recordingModel: API_ID, judgePrompt: 'Only save ports.' });

    loader.setAutoMemoryConfig({ judgePrompt: `  ${DEFAULT_JUDGE_PROMPT}  ` });
    expect(reload().getAutoMemoryConfig().judgePrompt).toBe('');

    loader.setAutoMemoryConfig({ judgePrompt: 'Only save ports.' });
    loader.setAutoMemoryConfig({ judgePrompt: '   ' });
    expect(reload().getAutoMemoryConfig().judgePrompt).toBe('');
  });

  it('stores the id when the model is picked by its display name', () => {
    const loader = makeLoader();
    loader.setAutoMemoryConfig({ recordingModel: 'Local model' });
    expect(loader.getAutoMemoryConfig().recordingModel).toBe(API_ID);
  });

  it('accepts a real CLI type only with a headless command saved on it, whatever its family', () => {
    const loader = makeLoader();

    loader.setAutoMemoryConfig({ recordingModel: OWN_ID });
    expect(reload().getAutoMemoryConfig().recordingModel).toBe(OWN_ID);
    // Claude Code is a known family, but nothing is assumed for it.
    expect(() => loader.setAutoMemoryConfig({ recordingModel: 'Claude Code' })).toThrow(/Claude Code cannot record: no headless command/);
    expect(reload().getAutoMemoryConfig().recordingModel).toBe(OWN_ID);
  });

  it('keeps a headless command typed in the tool editor, and drops it when cleared', () => {
    const loader = makeLoader();
    loader.updateCliType(SHELL_ID, 'cmd', [], 0, { headlessCommand: 'ask < "{promptFile}" > "{outputFile}"' });
    expect(reload().getRecordingModelOptions().find((model) => model.id === SHELL_ID)?.available).toBe(true);

    reload().updateCliType(SHELL_ID, 'cmd', [], 0, { headlessCommand: '' });
    expect(reload().getRecordingModelOptions().find((model) => model.id === SHELL_ID)?.available).toBe(false);
  });

  it('refuses a model that cannot run silently, keeping the old pick', () => {
    const loader = makeLoader();
    loader.setAutoMemoryConfig({ recordingModel: API_ID });

    expect(() => loader.setAutoMemoryConfig({ recordingModel: SHELL_ID })).toThrow(/cmd cannot record: no headless command/);
    expect(() => loader.setAutoMemoryConfig({ recordingModel: HALF_ID })).toThrow(/needs \{promptFile\} and \{outputFile\}/);
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

  it('lists what can record, what a real CLI costs, and why the rest cannot', () => {
    expect(makeLoader().getRecordingModelOptions()).toEqual([
      { id: API_ID, name: 'Local model', kind: 'api', available: true },
      { id: CLI_ID, name: 'Claude Code', kind: 'cli', available: false, note: 'no headless command' },
      { id: BROKEN_ID, name: 'Half-edited', kind: 'api', available: false, note: 'API settings are incomplete' },
      { id: SHELL_ID, name: 'cmd', kind: 'cli', available: false, note: 'no headless command' },
      { id: OWN_ID, name: 'Aider', kind: 'cli', available: true, note: 'real CLI: its full prompt on every turn' },
      { id: HALF_ID, name: 'Half a command', kind: 'cli', available: false, note: 'headless command needs {promptFile} and {outputFile}' },
    ]);
  });
});
