// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import FirstRunOnboarding from '../../../renderer/components/modals/FirstRunOnboarding.vue';
import { useFirstRunOnboarding } from '../../../renderer/composables/useFirstRunOnboarding';

let wrapper: ReturnType<typeof mount> | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
});

describe('FirstRunOnboarding workspace guide', () => {
  it('shows each workspace entry and opens the matching pane where available', async () => {
    const deps = {
      getCompleted: vi.fn().mockResolvedValue(true),
      setCompleted: vi.fn().mockResolvedValue({ success: true }),
      getTools: vi.fn().mockResolvedValue([]),
      getProjects: vi.fn().mockResolvedValue([]),
      browseDirectory: vi.fn().mockResolvedValue(null),
      createProject: vi.fn().mockResolvedValue({ success: true }),
      spawnSession: vi.fn().mockResolvedValue(true),
      openSettings: vi.fn(),
      openPane: vi.fn(),
    };
    const flow = useFirstRunOnboarding(deps);
    await flow.open();
    wrapper = mount(FirstRunOnboarding, { props: { flow }, attachTo: document.body });
    await nextTick();

    const workspaceSelector = '[aria-label="Your workspace"]';
    const entries = [
      ['mission-bar', 'Mission bar', 'terminal'],
      ['draft', 'Draft', 'draft'],
      ['artifacts', 'Artifacts', 'artifacts'],
      ['mess', 'Mess', 'mess'],
      ['statistics', 'Statistics (Timesheet + Tokens)', 'timesheet'],
      ['plans', 'Plans', 'plan-screen'],
      ['memory', 'Memory', 'memories'],
      ['freeze', 'Freeze', null],
    ] as const;

    expect(document.body.querySelector(workspaceSelector)?.querySelectorAll('[data-workspace-entry]')).toHaveLength(entries.length);
    for (const [entryId, title, paneId] of entries) {
      const entry = document.body.querySelector<HTMLElement>(`${workspaceSelector} [data-workspace-entry="${entryId}"]`);
      expect(entry).not.toBeNull();
      expect(entry?.textContent).toContain(title);
      if (!paneId) {
        expect(entry?.tagName).not.toBe('BUTTON');
        expect(entry?.getAttribute('data-pane-id')).toBeNull();
        continue;
      }

      expect(entry?.tagName).toBe('BUTTON');
      entry?.click();
      await nextTick();
      expect(deps.openPane).toHaveBeenLastCalledWith(paneId);
      if (!flow.visible.value) {
        flow.visible.value = true;
        await nextTick();
      }
    }
  });
});
