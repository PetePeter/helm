/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SuggestionLearningSection from '../../../renderer/components/settings/pages/SuggestionLearningSection.vue';

const learned = {
  items: [
    {
      id: '["project-a","skill/graphify"]', key: 'skill/graphify', type: 'skill', itemId: 'graphify',
      name: 'Graphify', projectId: 'project-a', projectName: 'Project Alpha', weight: 8,
      topTerms: [{ term: 'deploy', count: 4 }, { term: 'graph', count: 4 }], recent: [Date.parse('2026-10-19T04:00:00Z')],
    },
    {
      id: '["project-a","memory/deploy"]', key: 'memory/deploy', type: 'memory', itemId: 'deploy',
      name: 'Deploy guide', projectId: 'project-a', projectName: 'Project Alpha', weight: 3,
      topTerms: [{ term: 'deploy', count: 3 }], recent: [Date.parse('2026-10-18T04:00:00Z')],
    },
    {
      id: '["project-b","skill/graphify"]', key: 'skill/graphify', type: 'skill', itemId: 'graphify',
      name: 'Graphify', projectId: 'project-b', projectName: 'Project Beta', weight: 2,
      topTerms: [{ term: 'graph', count: 2 }], recent: [Date.parse('2026-10-17T04:00:00Z')],
    },
    {
      id: '["unattributed-legacy","skill/old"]', key: 'skill/old', type: 'skill', itemId: 'old',
      name: 'Old skill', projectId: 'unattributed-legacy', projectName: 'Unattributed legacy', weight: 1,
      topTerms: [{ term: 'legacy', count: 1 }], recent: [],
    },
  ],
  projects: [
    { id: 'project-a', name: 'Project Alpha', items: 2, totalWeight: 11 },
    { id: 'project-b', name: 'Project Beta', items: 1, totalWeight: 2 },
  ],
  totalWeight: 14,
};

const mocks = vi.hoisted(() => ({ getUsage: vi.fn(), resetUsage: vi.fn() }));

vi.mock('../../../renderer/ipc/clients.js', () => ({
  configClient: {
    hooksGetSuggestionUsage: mocks.getUsage,
    hooksResetSuggestionUsage: mocks.resetUsage,
  },
}));

describe('SuggestionLearningSection', () => {
  beforeEach(() => {
    mocks.getUsage.mockReset().mockResolvedValue({ success: true, usage: structuredClone(learned) });
    mocks.resetUsage.mockReset().mockResolvedValue({ success: true });
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  it('filters the full list by type and project, then shows item details', async () => {
    const wrapper = mount(SuggestionLearningSection);
    await flushPromises();

    expect(wrapper.text()).toContain('Graphify');
    expect(wrapper.text()).toContain('Deploy guide');
    expect(wrapper.text()).toContain('All projects is reporting only');
    expect(wrapper.find('button[aria-pressed="true"]').text()).toBe('Both');

    await wrapper.findAll('button').find((button) => button.text() === 'Skill')!.trigger('click');
    await flushPromises();
    expect(wrapper.find('button[aria-pressed="true"]').text()).toBe('Skill');
    expect(wrapper.text()).toContain('Graphify');
    expect(wrapper.text()).not.toContain('Deploy guide');

    await wrapper.get('select[aria-label="Project scope"]').setValue('project-a');
    await flushPromises();
    expect(wrapper.find('.master-detail__rows').text()).toContain('Project Alpha');
    expect(wrapper.find('.master-detail__rows').text()).not.toContain('Project Beta');
    expect(wrapper.find('.master-detail__rows').text()).not.toContain('Old skill');
    expect(wrapper.text()).toContain('Topic terms');
    expect(wrapper.text()).toContain('deploy');
    expect(wrapper.text()).toContain('Recent correlated fetches');
    expect(wrapper.text()).toContain('Associations');
  });

  it('requires confirmation and refreshes after resetting all projects', async () => {
    const wrapper = mount(SuggestionLearningSection);
    await flushPromises();
    const confirmMock = vi.mocked(window.confirm);
    confirmMock.mockReturnValueOnce(false);
    await wrapper.findAll('button').find((button) => button.text() === 'Reset all')!.trigger('click');
    expect(mocks.resetUsage).not.toHaveBeenCalled();

    await wrapper.findAll('button').find((button) => button.text() === 'Reset all')!.trigger('click');
    await flushPromises();
    expect(mocks.resetUsage).toHaveBeenCalledTimes(1);
    expect(mocks.getUsage).toHaveBeenCalledTimes(2);
    expect(confirmMock).toHaveBeenCalledWith('Reset all suggestion learning for every project?');
  });
});
