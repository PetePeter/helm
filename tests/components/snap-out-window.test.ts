/**
 * @vitest-environment jsdom
 *
 * The snapped-out shell is a real docking workspace on the `popout` profile.
 * These tests exercise the actual panes and stores — the only seam mocked is the
 * IPC client surface — because the whole design claim is that pinning
 * `activeSessionId` is sufficient to bind every pane to the right session.
 */

import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const { mockTerminalAttach, mockTerminalDetach } = vi.hoisted(() => ({
  mockTerminalAttach: vi.fn(),
  mockTerminalDetach: vi.fn(),
}));

vi.mock('../../renderer/terminal/terminal-view.js', () => ({
  TerminalView: class {
    static instances: any[] = [];
    written: string[] = [];
    disposed = false;
    constructor(public options: any) { (this.constructor as any).instances.push(this); }
    fit(): void {}
    focus(): void {}
    getDimensions(): { cols: number; rows: number } { return { cols: 80, rows: 24 }; }
    write(data: string): void { this.written.push(data); }
    dispose(): void { this.disposed = true; }
    getSelection(): string { return ''; }
    hasSelection(): boolean { return false; }
  },
}));

import SnapOutWindow from '../../renderer/components/SnapOutWindow.vue';
import { TerminalView } from '../../renderer/terminal/terminal-view.js';
import { state } from '../../renderer/state.js';
import { useAppStore, resetActiveSessionPinForTests } from '../../renderer/stores/app.js';
import { useModalStack } from '../../renderer/composables/useModalStack.js';
import { createDefaultLayout } from '../../renderer/dock-layout.js';
import { DOCK_PROFILE_PANES, PANE_TERMINAL } from '../../renderer/dock-types.js';
import { planScreenState } from '../../renderer/plans/plan-screen.js';
import { resetKeyHandlers } from '../../renderer/keyboard/router.js';
import { useEscProtection } from '../../renderer/composables/useEscProtection.js';

const POPOUT_SESSION = {
  id: 'session-1',
  name: 'Test Session',
  cliType: 'claude-code',
  workingDir: 'X:\\coding\\gamepad-cli-hub',
  projectId: 'project-1',
  processId: 1,
};

const OTHER_SESSION = {
  id: 'session-2',
  name: 'Other Session',
  cliType: 'codex',
  workingDir: 'X:\\coding\\other',
  projectId: 'project-2',
  processId: 2,
};

let savedLayouts: Array<{ profile: string | undefined; layout: unknown }>;
let ptyDataListeners: Array<(sessionId: string, data: string) => void>;
let api: Record<string, any>;

let mounted: Array<{ unmount: () => void }>;

/** Mount and settle: the shell loads the session and the layout before the dock renders. */
async function mountShell(sessionId = POPOUT_SESSION.id) {
  const wrapper = mount(SnapOutWindow, { props: { sessionId } });
  mounted.push(wrapper);
  await flushPromises();
  await flushPromises();
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  resetActiveSessionPinForTests();
  useModalStack().clear();
  (TerminalView as any).instances = [];
  state.sessions = [];
  state.activeSessionId = null;
  state.projects = [];
  savedLayouts = [];
  ptyDataListeners = [];
  mounted = [];
  // Key handlers are window-global singletons; a leaked
  // registration from a previous case would answer this one's keystrokes.
  resetKeyHandlers();
  // Escape in an earlier case arms ESC protection, which is a modal state and
  // would swallow the next case's shortcuts.
  useEscProtection().dismissProtection();

  (window as any).sessionStore = {
    load: vi.fn().mockResolvedValue([POPOUT_SESSION, OTHER_SESSION]),
  };

  mockTerminalAttach.mockResolvedValue({ success: true, replay: 'REPLAYED-OUTPUT' });
  mockTerminalDetach.mockResolvedValue({ success: true });

  api = {
    // config
    configGetEscProtectionEnabled: vi.fn().mockResolvedValue(true),
    configGetWorkspaceLayout: vi.fn().mockResolvedValue(undefined),
    configSetWorkspaceLayout: vi.fn((layout: unknown, profile?: string) => {
      savedLayouts.push({ profile, layout });
      return Promise.resolve({ success: true });
    }),
    configGetPlanFilters: vi.fn().mockResolvedValue({}),
    // terminal
    terminalAttach: mockTerminalAttach,
    terminalDetach: mockTerminalDetach,
    ptyWrite: vi.fn(),
    ptyScrollInput: vi.fn(),
    ptyResize: vi.fn(),
    // events
    onPtyData: vi.fn((cb: (sessionId: string, data: string) => void) => {
      ptyDataListeners.push(cb);
      return vi.fn();
    }),
    onPtyExit: vi.fn(() => vi.fn()),
    onSessionUpdated: vi.fn(() => vi.fn()),
    onMessAppended: vi.fn(() => vi.fn()),
    onArtifactsChanged: vi.fn(() => vi.fn()),
    onMemoryChanged: vi.fn(() => vi.fn()),
    // domain reads the panes make on mount
    projectList: vi.fn().mockResolvedValue([
      { id: 'project-1', name: 'Helm', canonicalPath: 'X:\\coding\\gamepad-cli-hub', alternatePaths: [] },
      { id: 'project-2', name: 'Other', canonicalPath: 'X:\\coding\\other', alternatePaths: [] },
    ]),
    messHistory: vi.fn().mockResolvedValue({ entries: [], hasMore: false }),
    memoryList: vi.fn().mockResolvedValue([]),
    memoryGraphAll: vi.fn().mockResolvedValue({ records: [], edges: [] }),
    artifactList: vi.fn().mockResolvedValue([]),
    draftGet: vi.fn(async (sessionId: string) => ({ sessionId, text: '', revision: 0 })),
    planList: vi.fn().mockResolvedValue([]),
    planDeps: vi.fn().mockResolvedValue([]),
    planSequenceList: vi.fn().mockResolvedValue([]),
    planContextList: vi.fn().mockResolvedValue([]),
    draftList: vi.fn().mockResolvedValue([]),
    chipActionsGet: vi.fn().mockResolvedValue([]),
    sessionRequestFocusSlot: vi.fn().mockResolvedValue(undefined),
    sessionSnapBack: vi.fn().mockResolvedValue({ success: true }),
  };
  (window as any).gamepadCli = api;
  (window as any).helm = undefined;
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.clearAllMocks();
});

describe('SnapOutWindow shell', () => {
  it('pins the window to its session and refuses later navigation', async () => {
    await mountShell();

    const store = useAppStore();
    expect(store.state.activeSessionId).toBe(POPOUT_SESSION.id);
    expect(store.isActiveSessionPinned()).toBe(true);

    store.setActiveSessionId(OTHER_SESSION.id);
    expect(store.state.activeSessionId).toBe(POPOUT_SESSION.id);
  });

  it('sets the document title from the pinned session', async () => {
    await mountShell();

    expect(document.title).toContain('Test Session');
    expect(document.title).toContain('gamepad-cli-hub');
  });

  it('renders exactly the panes of the popout profile', async () => {
    const wrapper = await mountShell();

    const rendered = wrapper.findAll('[data-dock-pane-id]')
      .map(pane => pane.attributes('data-dock-pane-id'))
      .sort();
    expect(rendered).toEqual([...DOCK_PROFILE_PANES.popout].sort());
  });

  it('persists its layout under the popout profile and never the main key', async () => {
    const wrapper = await mountShell();

    expect(api.configGetWorkspaceLayout).toHaveBeenCalledWith('popout');
    expect(savedLayouts.length).toBeGreaterThan(0);
    expect(savedLayouts.every(entry => entry.profile === 'popout')).toBe(true);

    savedLayouts.length = 0;
    await wrapper.findAll('[data-dock-tab-id] .dock-tab')[1].trigger('click');
    await flushPromises();

    expect(savedLayouts.length).toBeGreaterThan(0);
    expect(savedLayouts.every(entry => entry.profile === 'popout')).toBe(true);
  });

  it('adopts a persisted popout layout', async () => {
    const persisted = createDefaultLayout('popout');
    api.configGetWorkspaceLayout.mockResolvedValue(persisted);

    const wrapper = await mountShell();

    expect(wrapper.findAll('[data-dock-pane-id]').length).toBe(DOCK_PROFILE_PANES.popout.length);
  });
});

describe('SnapOutWindow view menu', () => {
  /** Open the header View menu and return the wrapper. */
  async function openViewMenu(wrapper: any) {
    await wrapper.find('.app-header .dock-view-menu__trigger').trigger('click');
    await flushPromises();
    return wrapper;
  }

  const menuLabels = (wrapper: any) =>
    wrapper.findAll('.dock-view-menu__popover .dock-view-menu__label').map((n: any) => n.text());

  it('shows the pinned session identity in the header', async () => {
    const wrapper = await mountShell();

    const header = wrapper.find('.app-header');
    expect(header.exists()).toBe(true);
    expect(header.text()).toContain('Test Session');
    expect(header.text()).toContain('gamepad-cli-hub');
  });

  it('lists exactly the popout profile panes and no main-only pane', async () => {
    const wrapper = await openViewMenu(await mountShell());

    const items = wrapper.findAll('.dock-view-menu__popover .dock-view-menu__item')
      .filter((n: any) => !n.classes('dock-view-menu__reset'));
    expect(items.length).toBe(DOCK_PROFILE_PANES.popout.length);
    expect(menuLabels(wrapper)).not.toContain('Sessions');
  });

  it('closes a pane from the menu and restores it again', async () => {
    const wrapper = await mountShell();
    const artifactsTab = wrapper.findAll('[data-dock-tab-id="artifacts"]');
    expect(artifactsTab.length).toBeGreaterThan(0);

    await openViewMenu(wrapper);
    const closeItem = wrapper.findAll('.dock-view-menu__popover .dock-view-menu__item')
      .find((n: any) => n.text().includes('Artifacts'));
    await closeItem!.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-dock-pane-id="artifacts"]').exists()).toBe(false);

    await openViewMenu(wrapper);
    const reopenItem = wrapper.findAll('.dock-view-menu__item--closed')
      .find((n: any) => n.text().includes('Artifacts'));
    expect(reopenItem).toBeTruthy();
    await reopenItem!.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-dock-pane-id="artifacts"]').exists()).toBe(true);
  });

  it('resets the layout back to the popout default', async () => {
    const wrapper = await mountShell();

    await openViewMenu(wrapper);
    const closeItem = wrapper.findAll('.dock-view-menu__popover .dock-view-menu__item')
      .find((n: any) => n.text().includes('Memories'));
    await closeItem!.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-dock-pane-id="memories"]').exists()).toBe(false);

    await openViewMenu(wrapper);
    await wrapper.find('.dock-view-menu__reset').trigger('click');
    await flushPromises();

    const rendered = wrapper.findAll('[data-dock-pane-id]')
      .map((pane: any) => pane.attributes('data-dock-pane-id')).sort();
    expect(rendered).toEqual([...DOCK_PROFILE_PANES.popout].sort());
  });
});

describe('SnapOutWindow pane bindings', () => {
  it('binds the plan pane to the pinned session directory', async () => {
    await mountShell();

    expect(planScreenState.currentDir).toBe(POPOUT_SESSION.workingDir);
  });

  it('derives the mess project from the pinned session', async () => {
    const wrapper = await mountShell();

    expect(api.messHistory).toHaveBeenCalled();
    expect(api.messHistory.mock.calls[0][0]).toBe(POPOUT_SESSION.projectId);
    expect(wrapper.find('.mess-pane').text()).toContain('Helm');
  });

  it('scopes memories to the pinned session', async () => {
    await mountShell();

    expect(api.memoryList).toHaveBeenCalled();
  });

  it('resolves artifacts for the pinned session', async () => {
    const wrapper = await mountShell();

    const artifactsPane = wrapper.find('[data-dock-pane-id="artifacts"]');
    expect(artifactsPane.exists()).toBe(true);
    expect(useAppStore().state.activeSessionId).toBe(POPOUT_SESSION.id);
  });
});

describe('SnapOutWindow terminal pane', () => {
  it('attaches, replays, and streams live output for the pinned session', async () => {
    await mountShell();

    expect(mockTerminalAttach).toHaveBeenCalledWith(POPOUT_SESSION.id);
    const view = (TerminalView as any).instances[0];
    expect(view.options.sessionId).toBe(POPOUT_SESSION.id);
    expect(view.written).toContain('REPLAYED-OUTPUT');

    for (const listener of ptyDataListeners) listener(POPOUT_SESSION.id, 'LIVE');
    expect(view.written).toContain('LIVE');

    // Output for a session this window is not pinned to never reaches the view.
    for (const listener of ptyDataListeners) listener(OTHER_SESSION.id, 'FOREIGN');
    expect(view.written).not.toContain('FOREIGN');
  });

  it('detaches PTY ownership before snapping back', async () => {
    const wrapper = await mountShell();

    const pane = wrapper.findComponent({ name: 'PopOutTerminalPane' });
    await (pane.vm as any).snapBack();
    await flushPromises();

    expect(mockTerminalDetach).toHaveBeenCalledWith(POPOUT_SESSION.id);
    expect(api.sessionSnapBack).toHaveBeenCalledWith(POPOUT_SESSION.id);
    expect(mockTerminalDetach.mock.invocationCallOrder[0])
      .toBeLessThan(api.sessionSnapBack.mock.invocationCallOrder[0]);
  });

  it('opens the terminal context menu against the pinned session', async () => {
    const wrapper = await mountShell();

    const container = wrapper.find('.popout-terminal').element as HTMLElement;
    container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await flushPromises();

    expect(document.querySelector('.context-menu')).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();

    expect(document.querySelector('.context-menu')).toBeNull();
    wrapper.unmount();
  });

  it('routes Ctrl+<n> to the main window without unpinning this one', async () => {
    const wrapper = await mountShell();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }));
    await flushPromises();

    expect(api.sessionRequestFocusSlot).toHaveBeenCalledWith(2);
    expect(useAppStore().state.activeSessionId).toBe(POPOUT_SESSION.id);
    expect(api.ptyWrite).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('disposes the terminal view when the window unmounts', async () => {
    const wrapper = await mountShell();
    const view = (TerminalView as any).instances[0];

    wrapper.unmount();

    expect(view.disposed).toBe(true);
  });

  it('overrides only the terminal pane component', async () => {
    const wrapper = await mountShell();

    const terminalPane = wrapper.find(`[data-dock-pane-id="${PANE_TERMINAL}"]`);
    expect(terminalPane.find('.popout-terminal').exists()).toBe(true);
    // The shared TerminalPane mounts the manager's host element; a pop-out has
    // no manager, so that element must not exist here.
    expect(wrapper.find('#terminalContainer').exists()).toBe(false);
  });
});
