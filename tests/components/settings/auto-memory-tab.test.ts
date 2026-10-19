/**
 * AutoMemoryTab — the recording model picker and the two switches.
 *
 * Real component, real Pinia store; the config client is a hand-rolled fake of
 * main, which owns the truth and refuses a model that cannot run silently.
 */

/** @vitest-environment jsdom */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import AutoMemoryTab from '../../../renderer/components/settings/pages/AutoMemoryTab.vue';
import { DEFAULT_JUDGE_PROMPT } from '../../../src/types/auto-memory.js';

const ALL_MODELS = [
  { id: 'api-local', name: 'Local model', kind: 'api', available: true },
  { id: 'cli-claude', name: 'Claude Code', kind: 'cli', available: true, note: 'real CLI: its full prompt on every turn' },
  { id: 'cli-shell', name: 'cmd', kind: 'cli', available: false, note: 'no headless command' },
];
let models = ALL_MODELS;
let stored = { recordingModel: '', autoSave: true, autoRecall: true, judgePrompt: '' };
let testResult: Record<string, string> = { status: 'ok', text: 'OK' };
const setCalls: Array<Record<string, unknown>> = [];

vi.mock('../../../renderer/ipc/clients.js', () => ({
  configClient: {
    configGetAutoMemory: vi.fn(async () => ({ success: true, settings: { ...stored }, models })),
    configSetAutoMemory: vi.fn(async (updates: Record<string, unknown>) => {
      setCalls.push(updates);
      if (updates.recordingModel === 'cli-shell') return { success: false, error: 'cmd cannot record: no headless command' };
      stored = { ...stored, ...updates } as typeof stored;
      return { success: true, settings: { ...stored }, models };
    }),
    configTestAutoMemoryModel: vi.fn(async () => testResult),
    hooksGetSuggestionUsage: vi.fn(async () => ({ success: true, usage: { items: [], projects: [], totalWeight: 0 } })),
    hooksResetSuggestionUsage: vi.fn(async () => ({ success: true })),
  },
}));

async function factory() {
  const wrapper = mount(AutoMemoryTab, { attachTo: document.body, global: { plugins: [createPinia()] } });
  await flushPromises();
  return wrapper;
}

describe('AutoMemoryTab', () => {
  beforeEach(() => {
    stored = { recordingModel: '', autoSave: true, autoRecall: true, judgePrompt: '' };
    testResult = { status: 'ok', text: 'OK' };
    setCalls.length = 0;
    models = ALL_MODELS;
  });

  it('lists what can record, marks a real CLI with its cost, and disables the rest with the reason', async () => {
    const wrapper = await factory();
    const options = wrapper.find('select').findAll('option');

    expect(options.map((option) => option.text())).toEqual([
      'None', 'Local model', 'Claude Code (real CLI: its full prompt on every turn)', 'cmd (no headless command)',
    ]);
    expect(options.map((option) => (option.element as HTMLOptionElement).disabled)).toEqual([false, false, false, true]);
  });

  it('spells out what a real CLI costs before one is picked, and only when one can be', async () => {
    const wrapper = await factory();

    expect(stored.recordingModel).toBe('');
    expect(wrapper.text()).toContain('about 28k tokens for Claude Code');
    expect(wrapper.text()).toContain('after every turn of every session');

    models = [ALL_MODELS[0], ALL_MODELS[2]];
    expect((await factory()).text()).not.toContain('28k tokens');
  });

  it('says auto-save is inert until a model is picked, and offers no test', async () => {
    const wrapper = await factory();

    expect(wrapper.text()).toContain('auto-save does nothing until you pick one');
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();

    await wrapper.find('select').setValue('api-local');
    await flushPromises();

    expect(setCalls).toEqual([{ recordingModel: 'api-local' }]);
    expect(wrapper.text()).not.toContain('auto-save does nothing');
    expect(wrapper.find('button').attributes('disabled')).toBeUndefined();
  });

  it('saves each switch on its own', async () => {
    const wrapper = await factory();
    const [autoSave, autoRecall] = wrapper.findAll('input[type="checkbox"]');

    await autoSave.setValue(false);
    await autoRecall.setValue(false);
    await flushPromises();

    expect(setCalls).toEqual([{ autoSave: false }, { autoRecall: false }]);
    expect(stored).toMatchObject({ autoSave: false, autoRecall: false });
  });

  it('shows why a pick was refused and falls back to the stored model', async () => {
    stored.recordingModel = 'api-local';
    const wrapper = await factory();

    // A disabled option cannot be clicked, but main is the gate: prove the refusal surfaces.
    const select = wrapper.find('select');
    (select.element as HTMLSelectElement).options[3].disabled = false;
    await select.setValue('cli-shell');
    await flushPromises();

    expect(wrapper.text()).toContain('cmd cannot record: no headless command');
    expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('api-local');
  });

  it('flags a stored model whose CLI type was deleted, and offers no test', async () => {
    stored.recordingModel = 'deleted-type';
    const wrapper = await factory();

    expect(wrapper.text()).toContain('can no longer record');
    expect(wrapper.find('select option:checked').text()).toBe('Deleted CLI type');
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
  });

  it('shows the default judge prompt to edit from, and saves an edit', async () => {
    const wrapper = await factory();
    const prompt = wrapper.find('textarea');

    expect((prompt.element as HTMLTextAreaElement).value).toBe(DEFAULT_JUDGE_PROMPT);

    await prompt.setValue('Only save ports.');
    await flushPromises();

    expect(setCalls).toEqual([{ judgePrompt: 'Only save ports.' }]);
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('Only save ports.');
  });

  it('resets an edited judge prompt to the default', async () => {
    stored.judgePrompt = 'Only save ports.';
    const wrapper = await factory();
    const reset = wrapper.findAll('button').find((button) => button.text() === 'Reset to default')!;

    await reset.trigger('click');
    await flushPromises();

    expect(setCalls).toEqual([{ judgePrompt: '' }]);
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(DEFAULT_JUDGE_PROMPT);
    expect(reset.attributes('disabled')).toBeDefined();
  });

  it('reports the outcome of a test run in words', async () => {
    stored.recordingModel = 'api-local';
    testResult = { status: 'failed', error: 'API 500: boom' };
    const wrapper = await factory();

    await wrapper.find('button').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Failed: API 500: boom');
  });
});
