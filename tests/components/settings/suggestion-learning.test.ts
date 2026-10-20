/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SuggestionLearningSection from '../../../renderer/components/settings/pages/SuggestionLearningSection.vue';

const learned = {
  items: [
    {
      id: 'skill/graphify', key: 'skill/graphify', type: 'skill', itemId: 'graphify',
      name: 'Graphify', body: 'Read-only skill text for Graphify.',
      projects: [
        { id: 'project-a', name: 'Project Alpha', weight: 8 },
        { id: 'project-b', name: 'Project Beta', weight: 2 },
      ],
      weight: 10,
      topTerms: [{ term: 'graph', count: 6 }, { term: 'deploy', count: 4 }],
      recent: [Date.parse('2026-10-17T04:00:00Z'), Date.parse('2026-10-19T04:00:00Z')],
    },
    {
      id: 'memory/deploy', key: 'memory/deploy', type: 'memory', itemId: 'deploy',
      name: 'Deploy guide', projects: [{ id: 'project-a', name: 'Project Alpha', weight: 3 }], weight: 3,
      topTerms: [{ term: 'deploy', count: 3 }], recent: [Date.parse('2026-10-18T04:00:00Z')],
    },
    {
      id: 'skill/old', key: 'skill/old', type: 'skill', itemId: 'old',
      name: 'Old skill', projects: [{ id: 'unattributed-legacy', name: 'Unattributed legacy', weight: 1 }], weight: 1,
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

    const rows = wrapper.find('.master-detail__rows').text();
    expect(rows.match(/Graphify/g)).toHaveLength(1);
    const detail = wrapper.get('.suggestion-learning__detail');
    expect(detail.get('.suggestion-learning__body').element.tagName).toBe('PRE');
    expect(detail.get('.suggestion-learning__body').text()).toBe('Read-only skill text for Graphify.');
    const learntIn = detail.findAll('.suggestion-learning__group')
      .find((group) => group.find('h5').text() === 'Learnt in');
    expect(learntIn?.text()).toContain('Project Alpha');
    expect(learntIn?.text()).toContain('Project Beta');

    await wrapper.findAll('button').find((button) => button.text() === 'Skill')!.trigger('click');
    await flushPromises();
    expect(wrapper.find('button[aria-pressed="true"]').text()).toBe('Skill');
    expect(wrapper.text()).toContain('Graphify');
    expect(wrapper.text()).not.toContain('Deploy guide');

    await wrapper.get('select[aria-label="Project scope"]').setValue('project-a');
    await flushPromises();
    const projectARows = wrapper.find('.master-detail__rows').text();
    expect(projectARows).toContain('Project Alpha');
    expect(projectARows).toContain('Project Beta');
    expect(projectARows.match(/Graphify/g)).toHaveLength(1);
    expect(projectARows).not.toContain('Old skill');
    expect(wrapper.text()).toContain('Topic terms');
    expect(wrapper.text()).toContain('deploy');
    expect(wrapper.text()).toContain('Recent correlated fetches');
    expect(wrapper.text()).toContain('Associations');

    await wrapper.get('select[aria-label="Project scope"]').setValue('project-b');
    await flushPromises();
    const projectBRows = wrapper.find('.master-detail__rows').text();
    expect(projectBRows.match(/Graphify/g)).toHaveLength(1);
    expect(projectBRows).not.toContain('Deploy guide');
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
