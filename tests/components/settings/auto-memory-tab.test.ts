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
import AutoMemoryTab from '../../../renderer/components/sidebar/AutoMemoryTab.vue';

const MODELS = [
  { id: 'api-local', name: 'Local model', kind: 'api', available: true },
  { id: 'cli-claude', name: 'Claude Code', kind: 'cli', available: false, note: 'needs headless runner' },
];
let stored = { recordingModel: '', autoSave: true, autoRecall: true };
let testResult: Record<string, string> = { status: 'ok', text: 'OK' };
const setCalls: Array<Record<string, unknown>> = [];

vi.mock('../../../renderer/ipc/clients.js', () => ({
  configClient: {
    configGetAutoMemory: vi.fn(async () => ({ success: true, settings: { ...stored }, models: MODELS })),
    configSetAutoMemory: vi.fn(async (updates: Record<string, unknown>) => {
      setCalls.push(updates);
      if (updates.recordingModel === 'cli-claude') return { success: false, error: 'Claude Code is a real CLI: recording with it needs the headless runner' };
      stored = { ...stored, ...updates } as typeof stored;
      return { success: true, settings: { ...stored }, models: MODELS };
    }),
    configTestAutoMemoryModel: vi.fn(async () => testResult),
  },
}));

async function factory() {
  const wrapper = mount(AutoMemoryTab, { attachTo: document.body, global: { plugins: [createPinia()] } });
  await flushPromises();
  return wrapper;
}

describe('AutoMemoryTab', () => {
  beforeEach(() => {
    stored = { recordingModel: '', autoSave: true, autoRecall: true };
    testResult = { status: 'ok', text: 'OK' };
    setCalls.length = 0;
  });

  it('lists API tools as pickable and real CLI types as disabled with the reason', async () => {
    const wrapper = await factory();
    const options = wrapper.findAll('select option');

    expect(options.map((option) => option.text())).toEqual(['None', 'Local model', 'Claude Code (needs headless runner)']);
    expect(options.map((option) => (option.element as HTMLOptionElement).disabled)).toEqual([false, false, true]);
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
    (select.element as HTMLSelectElement).options[2].disabled = false;
    await select.setValue('cli-claude');
    await flushPromises();

    expect(wrapper.text()).toContain('needs the headless runner');
    expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('api-local');
  });

  it('flags a stored model whose CLI type was deleted, and offers no test', async () => {
    stored.recordingModel = 'deleted-type';
    const wrapper = await factory();

    expect(wrapper.text()).toContain('can no longer record');
    expect(wrapper.find('select option:checked').text()).toBe('Deleted CLI type');
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
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
