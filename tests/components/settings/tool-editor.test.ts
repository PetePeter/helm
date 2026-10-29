/**
 * ToolEditor — the inline, autosaving CLI type editor in Settings → Tools.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { markRaw } from 'vue';
import ToolEditor, { type ToolEditorValues } from '../../../renderer/components/settings/tools/ToolEditor.vue';
import { settingsSaveState } from '../../../renderer/composables/useAutosave.js';
import { toolsClient } from '../../../renderer/ipc/clients.js';
import { cloneDefaultComfyUiConfig } from '../../../src/session/comfyui/comfyui-config.js';

vi.mock('../../../renderer/ipc/clients.js', () => ({
  toolsClient: { toolsApiToolCatalog: vi.fn(async () => []) },
}));

const DEFAULT_DATA = {
  name: 'Tool',
  env: [] as Array<{ name: string; value: string }>,
  initialPromptDelay: 2000,
  spawnCommand: '',
  resumeCommand: '',
  continueCommand: '',
  renameCommand: '',
  helmPreambleForInterSession: true,
  largeTextAsTempFile: false,
  messReminders: true,
  submitSuffix: '\\r',
  helmActions: { clear: '', compact: '', export: '' },
  initialPrompt: [] as Array<{ label: string; sequence: string }>,
};

type Saved = { key: string; values: ToolEditorValues };
let saves: Saved[];
let wrapper: VueWrapper | null = null;

function factory(props: Record<string, unknown> = {}) {
  wrapper = mount(ToolEditor, {
    props: {
      toolKey: 'tool-1',
      initialData: { ...DEFAULT_DATA },
      save: async (key: string, values: ToolEditorValues) => { saves.push({ key, values }); return true; },
      ...props,
    },
    attachTo: document.body,
  });
  return wrapper;
}

/** Let the autosave debounce elapse and the save settle. */
const settle = () => vi.advanceTimersByTimeAsync(600);
const lastSaved = () => saves[saves.length - 1]?.values;
const checkboxRow = (w: VueWrapper, text: string) => w.findAll('.te-checkbox-row').find((r) => r.text().includes(text))!.find('input');

beforeEach(() => {
  vi.useFakeTimers();
  saves = [];
  vi.mocked(toolsClient.toolsApiToolCatalog).mockResolvedValue([]);
  settingsSaveState.status = 'idle';
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
});

describe('ToolEditor', () => {
  it('opening a tool is not an edit: nothing is saved', async () => {
    factory({ initialData: { ...DEFAULT_DATA, spawnCommand: 'claude' } });
    await settle();
    expect(saves).toEqual([]);
  });

  it('does not save when the API catalog arrives, but still autosaves API edits', async () => {
    vi.mocked(toolsClient.toolsApiToolCatalog).mockResolvedValue([
      { name: 'tool-a', description: 'A', source: 'native' },
      { name: 'tool-b', description: 'B', source: 'native' },
    ]);
    const w = factory({
      initialData: {
        ...DEFAULT_DATA,
        api: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'model', allowedTools: ['tool-b', 'tool-a'] },
      },
    });

    await settle();
    expect(saves).toEqual([]);

    await w.findAll('.pill-tabs__tab').find((pill) => pill.text() === 'API')!.trigger('click');
    await w.find('#te-api-model').setValue('edited-model');
    await settle();

    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ key: 'tool-1', values: { api: { model: 'edited-model', allowedTools: ['tool-a', 'tool-b'] } } });
  });

  it('autosaves one debounced write per burst of typing, to the open tool', async () => {
    const w = factory();
    const spawn = w.find('#te-spawn');
    await spawn.setValue('c');
    await spawn.setValue('cl');
    await spawn.setValue('claude --resume');
    expect(saves).toHaveLength(0);
    await settle();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ key: 'tool-1', values: { spawnCommand: 'claude --resume' } });
    expect(settingsSaveState.status).toBe('saved');
  });

  it('a pending edit is written to the tool it was made on when the selection changes', async () => {
    const w = factory();
    await w.find('#te-spawn').setValue('first');
    await w.setProps({ toolKey: 'tool-2', initialData: { ...DEFAULT_DATA, name: 'Other' } });
    await settle();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ key: 'tool-1', values: { spawnCommand: 'first' } });
    expect((w.find('#te-name').element as HTMLInputElement).value).toBe('Other');
  });

  it('saves a queued edit to the old tool before switching forms', async () => {
    let finishFirst: ((ok: boolean) => void) | undefined;
    const save = vi.fn((key: string, values: ToolEditorValues) => {
      saves.push({ key, values });
      if (saves.length === 1) return new Promise<boolean>((resolve) => { finishFirst = resolve; });
      return Promise.resolve(true);
    });
    const w = factory({ save });

    await w.find('#te-spawn').setValue('first');
    await vi.advanceTimersByTimeAsync(500);
    expect(saves).toHaveLength(1);

    await w.find('#te-spawn').setValue('last');
    await vi.advanceTimersByTimeAsync(500);
    await w.setProps({ toolKey: 'tool-2', initialData: { ...DEFAULT_DATA, name: 'Other' } });

    finishFirst!(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ key: 'tool-1', values: { spawnCommand: 'last' } });
    expect((w.find('#te-name').element as HTMLInputElement).value).toBe('Other');
  });

  it('saves env, prompts and toggles in the payload shape the IPC expects', async () => {
    const w = factory({
      initialData: { ...DEFAULT_DATA, env: [{ name: 'COPILOT_MODEL', value: 'qwen' }], initialPrompt: [{ label: 'greet', sequence: 'hello' }] },
    });
    await checkboxRow(w, 'temp file').setValue(true);
    await w.findAll('button').find((b) => b.text() === '+ Helm session init')!.trigger('click');
    await settle();
    expect(lastSaved()).toMatchObject({
      env: [{ name: 'COPILOT_MODEL', value: 'qwen' }],
      largeTextAsTempFile: true,
      _promptItems: [
        { label: 'greet', sequence: 'hello' },
        { label: 'Helm session init', sequence: 'Call session_info to get Helm MCP initial information.{Enter}' },
      ],
    });
  });

  it('omits Mess reminders while on (the default) and saves false when turned off', async () => {
    const w = factory();
    await w.find('#te-spawn').setValue('x');
    await settle();
    expect(lastSaved()).not.toHaveProperty('messReminders');
    await checkboxRow(w, 'Mess reminders').setValue(false);
    await settle();
    expect(lastSaved()?.messReminders).toBe(false);
  });

  it('manual context warnings: red <= amber is refused with an inline error, then saved once fixed', async () => {
    const w = factory();
    expect(w.find('#te-context-amber').exists()).toBe(false);
    await checkboxRow(w, 'Manual context warnings').setValue(true);
    await w.find('#te-context-amber').setValue(120_000);
    await w.find('#te-context-red').setValue(100_000);
    await settle();
    expect(saves.filter((s) => s.values.contextLimits)).toHaveLength(0);
    expect(w.find('[role="alert"]').text()).toContain('Red must be above amber');
    expect(settingsSaveState.status).toBe('error');

    await w.find('#te-context-red').setValue(150_000);
    await settle();
    expect(lastSaved()?.contextLimits).toEqual({ amber: 120_000, red: 150_000 });
  });

  it('a clashing display name shows the error, is not saved, and saves once unique', async () => {
    const w = factory({
      validateName: (name: string) => (name.trim() === 'Codex' ? 'A CLI type named "Codex" already exists.' : null),
    });
    await w.find('#te-name').setValue('Codex');
    await settle();
    expect(saves).toHaveLength(0);
    expect(w.find('.te-error').text()).toContain('already exists');
    expect(settingsSaveState.message).toContain('already exists');

    await w.find('#te-name').setValue('Codex Next');
    await settle();
    expect(w.find('.te-error').exists()).toBe(false);
    expect(lastSaved()?.name).toBe('Codex Next');
  });

  it('section pills follow the type: Launch for CLI, API/ComfyUI for theirs', async () => {
    const w = factory();
    const pills = () => w.findAll('.pill-tabs__tab').map((p) => p.text());
    expect(pills()).toContain('Launch');
    await w.find('#te-kind').setValue('api');
    expect(pills()).toContain('API');
    expect(pills()).not.toContain('Launch');
  });

  it('switching to a section that the new type lacks falls back to General', async () => {
    const w = factory();
    await w.findAll('.pill-tabs__tab').find((p) => p.text() === 'Launch')!.trigger('click');
    expect(w.find('#te-spawn').isVisible()).toBe(true);
    await w.find('#te-kind').setValue('api');
    expect(w.find('.pill-tabs__tab--active').text()).toBe('General');
  });

  it('keeps a shared section selected when switching tools', async () => {
    const w = factory();
    await w.findAll('.pill-tabs__tab').find((p) => p.text() === 'Behaviour')!.trigger('click');

    await w.setProps({
      toolKey: 'tool-2',
      initialData: {
        ...DEFAULT_DATA,
        api: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'model', allowedTools: [] },
      },
    });
    await settle();

    expect(w.find('.pill-tabs__tab--active').text()).toBe('Behaviour');
  });

  it('falls back to General when the switched tool lacks the selected section', async () => {
    const w = factory();
    await w.findAll('.pill-tabs__tab').find((p) => p.text() === 'Launch')!.trigger('click');

    await w.setProps({
      toolKey: 'tool-2',
      initialData: {
        ...DEFAULT_DATA,
        api: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'model', allowedTools: [] },
      },
    });
    await settle();

    expect(w.find('.pill-tabs__tab--active').text()).toBe('General');
  });

  it('a new ComfyUI type defaults to no prompt cache; a CLI type does not inherit that', async () => {
    const w = factory();
    const kind = w.find('#te-kind');
    await kind.setValue('comfyui');
    expect((checkboxRow(w, 'No prompt cache').element as HTMLInputElement).checked).toBe(true);
    await kind.setValue('cli');
    expect((checkboxRow(w, 'No prompt cache').element as HTMLInputElement).checked).toBe(false);
  });

  it('keeps an existing CLI no-cache choice after a round trip through ComfyUI', async () => {
    const w = factory({ initialData: { ...DEFAULT_DATA, noPromptCache: true } });
    await w.find('#te-kind').setValue('comfyui');
    await w.find('#te-kind').setValue('cli');
    expect((checkboxRow(w, 'No prompt cache').element as HTMLInputElement).checked).toBe(true);
  });

  it('preserves an explicit no-cache opt-out on an existing ComfyUI type', () => {
    const w = factory({ initialData: { ...DEFAULT_DATA, comfyUi: markRaw(cloneDefaultComfyUiConfig()), noPromptCache: false } });
    expect((checkboxRow(w, 'No prompt cache').element as HTMLInputElement).checked).toBe(false);
  });

  it('shows Helm-managed env vars read-only and never saves them', async () => {
    const w = factory();
    const managed = w.findAll('.te-env-item--readonly input').map((i) => (i.element as HTMLInputElement).value);
    expect(managed).toEqual(expect.arrayContaining(['HELM_MCP_TOKEN', 'HELM_SESSION_ID', 'HELM_SESSION_NAME']));
    await w.findAll('button').find((b) => b.text() === '+ Add Variable')!.trigger('click');
    await w.find('#te-env-name-0').setValue('A');
    await settle();
    expect(lastSaved()?.env).toEqual([{ name: 'A', value: '' }]);
  });

  it('removing a prompt item saves the shorter list', async () => {
    const w = factory({ initialData: { ...DEFAULT_DATA, initialPrompt: [{ label: 'a', sequence: 's1' }, { label: 'b', sequence: 's2' }] } });
    await w.find('.te-prompt-item .btn--danger').trigger('click');
    await settle();
    expect(lastSaved()?._promptItems).toEqual([{ label: 'b', sequence: 's2' }]);
  });

  it('shows the id as diagnostic detail only', () => {
    const w = factory({ toolKey: '11111111-2222-4333-8444-555566667777' });
    expect(w.find('.te-identity').text()).toContain('11111111-2222-4333-8444-555566667777');
  });
});
