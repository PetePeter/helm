/**
 * ProjectsTab component tests.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ProjectsTab from '../../../renderer/components/sidebar/ProjectsTab.vue';

const mocks = vi.hoisted(() => ({
  projectList: vi.fn(),
  projectUpdate: vi.fn(),
  projectDelete: vi.fn(),
  projectCreate: vi.fn(),
  projectAddDir: vi.fn(),
  projectRemoveDir: vi.fn(),
  projectSetMainDir: vi.fn(),
  dialogOpenFolder: vi.fn(),
}));

vi.mock('../../../renderer/ipc/clients.js', () => ({
  appClient: {},
  attachmentsClient: {},
  configClient: {},
  contextsClient: {},
  deliveryClient: {},
  dialogClient: {
    dialogOpenFolder: mocks.dialogOpenFolder,
  },
  eventsClient: {},
  incomingClient: {},
  keyboardClient: {},
  patternsClient: {},
  plansClient: {},
  projectsClient: {
    projectList: mocks.projectList,
    projectUpdate: mocks.projectUpdate,
    projectDelete: mocks.projectDelete,
    projectCreate: mocks.projectCreate,
    projectAddDir: mocks.projectAddDir,
    projectRemoveDir: mocks.projectRemoveDir,
    projectSetMainDir: mocks.projectSetMainDir,
  },
  schedulerClient: {},
  sessionsClient: {},
  systemClient: {},
  telegramClient: {},
  terminalClient: {},
  toolsClient: {},
}));

const baseProject = {
  id: 'project-1',
  key: 'git:x:/coding/repo/.git',
  name: 'Repo',
  canonicalPath: 'x:\\coding\\repo',
  alternatePaths: ['x:\\coding\\repo-worktree'],
  rootKind: 'git',
  createdAt: 1,
  updatedAt: 1,
};

function mountProjectsTab() {
  return mount(ProjectsTab);
}

describe('ProjectsTab', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.projectList.mockResolvedValue([baseProject]);
    mocks.projectUpdate.mockResolvedValue({ success: true });
    mocks.projectDelete.mockResolvedValue({ success: true });
    mocks.projectCreate.mockResolvedValue({ success: true });
    mocks.projectAddDir.mockResolvedValue({ success: true });
    mocks.projectRemoveDir.mockResolvedValue({ success: true });
    mocks.projectSetMainDir.mockResolvedValue({ success: true });
  });

  it('shows an explicit project rename action', async () => {
    const wrapper = mountProjectsTab();
    await flushPromises();

    expect(wrapper.findAll('button').some(button => button.text() === 'Rename')).toBe(true);

    wrapper.unmount();
  });

  it('opens inline rename from the rename button and saves through projectUpdate', async () => {
    const wrapper = mountProjectsTab();
    await flushPromises();

    const renameButton = wrapper.findAll('button').find(button => button.text() === 'Rename');
    expect(renameButton).toBeTruthy();
    await renameButton!.trigger('click');

    const input = wrapper.find('.settings-project-name-edit input');
    expect((input.element as HTMLInputElement).value).toBe('Repo');

    await input.setValue('Renamed Repo');
    await input.trigger('keydown.enter');
    await flushPromises();

    expect(mocks.projectUpdate).toHaveBeenCalledWith('project-1', { name: 'Renamed Repo' });
    expect(mocks.projectList).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });
});
