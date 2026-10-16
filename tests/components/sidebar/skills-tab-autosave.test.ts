/**
 * SkillsTab auto-save tests. The save status itself lives in the settings footer.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SkillsTab, { type SkillDraft, type SkillProject, type SkillSummary } from '../../../renderer/components/settings/pages/SkillsTab.vue';

const baseSkill: SkillSummary = {
  id: 'skill-1',
  name: 'Test Skill',
  description: 'When to trigger',
  aiAmendable: false,
  allProjects: true,
  projectIds: [],
};

const baseDraft: SkillDraft = {
  id: 'skill-1',
  name: 'Test Skill',
  description: 'When to trigger',
  body: 'Initial body',
  aiAmendable: false,
  allProjects: true,
  projectIds: [],
  source: 'user',
};

const projects: SkillProject[] = [
  { id: 'proj-1', name: 'Alpha', canonicalPath: 'X:\\alpha' },
];

function makeWrapper(draft: SkillDraft = baseDraft) {
  return mount(SkillsTab, {
    props: { skills: [baseSkill], draft, projects },
  });
}

describe('SkillsTab auto-save', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('toggles and project scope changes autosave too, not just text', async () => {
    const wrapper = makeWrapper();
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.find('.settings-skill-project-option:not([disabled])').trigger('click');
    await flushPromises();
    vi.advanceTimersByTime(500);
    await flushPromises();

    const saves = wrapper.emitted('save') as SkillDraft[][];
    expect(saves).toHaveLength(1);
    expect(saves[0][0]).toMatchObject({ aiAmendable: true });
    wrapper.unmount();
  });

  it('auto-saves after 500ms debounce with correct payload', async () => {
    const wrapper = makeWrapper();
    await wrapper.find('textarea.settings-skill-body').setValue('Auto-saved body');
    await flushPromises();

    vi.advanceTimersByTime(500);
    await flushPromises();

    const saves = wrapper.emitted('save') as SkillDraft[][];
    expect(saves).toHaveLength(1);
    expect(saves[0][0]).toMatchObject({
      id: 'skill-1',
      name: 'Test Skill',
      body: 'Auto-saved body',
      aiAmendable: false,
    });
    wrapper.unmount();
  });

  it('debounces: only one save emitted for rapid changes', async () => {
    const wrapper = makeWrapper();
    const textarea = wrapper.find('textarea.settings-skill-body');

    await textarea.setValue('a');
    await flushPromises();
    vi.advanceTimersByTime(200);

    await textarea.setValue('ab');
    await flushPromises();
    vi.advanceTimersByTime(200);

    await textarea.setValue('abc');
    await flushPromises();
    vi.advanceTimersByTime(500);
    await flushPromises();

    expect((wrapper.emitted('save') ?? []).length).toBe(1);
    wrapper.unmount();
  });

  it('does not emit save when props.draft changes (no spurious auto-save)', async () => {
    const wrapper = makeWrapper();
    const newDraft: SkillDraft = { ...baseDraft, id: 'skill-2', name: 'Other', body: 'Other' };

    await wrapper.setProps({ draft: newDraft });
    await flushPromises();
    vi.advanceTimersByTime(600);
    await flushPromises();

    expect(wrapper.emitted('save')).toBeUndefined();
    wrapper.unmount();
  });

  it('does not auto-save system skills', async () => {
    const systemDraft: SkillDraft = { ...baseDraft, source: 'system' };
    const wrapper = makeWrapper(systemDraft);

    const bodyArea = wrapper.find('textarea.settings-skill-body');
    if (bodyArea.exists()) {
      await bodyArea.setValue('Attempt edit');
      await flushPromises();
    }

    vi.advanceTimersByTime(600);
    await flushPromises();

    expect(wrapper.emitted('save')).toBeUndefined();
    wrapper.unmount();
  });
});
