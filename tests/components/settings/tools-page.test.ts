/**
 * ToolsPage — CLI type list + inline editor selection flow.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ToolsPage from '../../../renderer/components/settings/tools/ToolsPage.vue';

vi.mock('../../../renderer/ipc/clients.js', () => ({
  toolsClient: { toolsApiToolCatalog: async () => [] },
}));

const tool = (key: string, name: string) => ({ key, name, command: name.toLowerCase(), hasInitialPrompt: false, initialPromptCount: 0 });
const data = (name: string) => ({
  name, env: [], initialPromptDelay: 0, spawnCommand: '', resumeCommand: '', continueCommand: '', renameCommand: '',
  largeTextAsTempFile: false, submitSuffix: '\r', helmActions: { clear: '', compact: '', export: '' }, initialPrompt: [],
});

function mountPage(overrides: Record<string, unknown> = {}) {
  const tools = [tool('a', 'Claude'), tool('b', 'Codex')];
  const calls: string[] = [];
  const props = {
    tools,
    bindingProfiles: [],
    validateName: () => null,
    load: async (key: string) => { calls.push(`load:${key}`); return data(tools.find((t) => t.key === key)?.name ?? key); },
    save: async () => true,
    add: async () => 'new',
    clone: async () => 'copy',
    remove: async (key: string) => { calls.push(`remove:${key}`); },
    move: async () => {},
    ...overrides,
  };
  return { w: mount(ToolsPage, { props }), calls };
}

describe('ToolsPage', () => {
  it('opens the first tool in the editor', async () => {
    const { w, calls } = mountPage();
    await flushPromises();
    expect(calls).toEqual(['load:a']);
    expect((w.find('#te-name').element as HTMLInputElement).value).toBe('Claude');
  });

  it('selecting another row loads that tool', async () => {
    const { w } = mountPage();
    await flushPromises();
    await w.findAll('.master-detail__row')[1].trigger('click');
    await flushPromises();
    expect(w.find('.tools-page__title').text()).toBe('Codex');
    expect((w.find('#te-name').element as HTMLInputElement).value).toBe('Codex');
  });

  it('clears the prior editor during a delayed selection and flushes edits to its tool', async () => {
    let resolveB!: (value: ReturnType<typeof data> | null) => void;
    const load = vi.fn((key: string) => key === 'b'
      ? new Promise<ReturnType<typeof data> | null>((resolve) => { resolveB = resolve; })
      : Promise.resolve(data('Claude')));
    const save = vi.fn(async () => true);
    const { w } = mountPage({ load, save });

    await flushPromises();
    await w.find('#te-name').setValue('Claude edited');
    await w.findAll('.master-detail__row')[1].trigger('click');
    await flushPromises();

    expect(w.find('#te-name').exists()).toBe(false);
    expect(save).toHaveBeenCalledWith('a', expect.objectContaining({ name: 'Claude edited' }));

    resolveB(data('Codex'));
    await flushPromises();
    expect((w.find('#te-name').element as HTMLInputElement).value).toBe('Codex');
  });

  it.each(['null', 'error'])('does not keep the prior editor when the new load returns %s', async (outcome) => {
    const load = async (key: string) => {
      if (key === 'a') return data('Claude');
      if (outcome === 'error') throw new Error('tool unavailable');
      return null;
    };
    const { w } = mountPage({ load });

    await flushPromises();
    await w.findAll('.master-detail__row')[1].trigger('click');
    await flushPromises();

    expect(w.find('#te-name').exists()).toBe(false);
    expect(w.get('[role="alert"]').text()).toBe("Unable to load this tool's settings.");
  });

  it('Add selects the newly created type once it is in the list', async () => {
    const { w } = mountPage();
    await flushPromises();
    await w.find('.master-detail__list-head button').trigger('click');
    await flushPromises();
    await w.setProps({ tools: [tool('a', 'Claude'), tool('b', 'Codex'), tool('new', 'New CLI type')] });
    await flushPromises();
    expect(w.find('.master-detail__row--active').text()).toContain('New CLI type');
  });

  it('Delete asks once more before removing', async () => {
    const { w, calls } = mountPage();
    await flushPromises();
    const del = () => w.findAll('.tools-page__head button').find((b) => /delete/i.test(b.text()))!;
    await del().trigger('click');
    expect(calls).not.toContain('remove:a');
    expect(del().text()).toBe('Confirm delete');
    await del().trigger('click');
    expect(calls).toContain('remove:a');
  });
});
