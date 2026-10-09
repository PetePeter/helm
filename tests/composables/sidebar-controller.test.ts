/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
  state: {
    activeSessionId: 's1',
    draftCounts: new Map<string, number>(),
    projects: [] as Array<{ canonicalPath: string; alternatePaths: string[]; id: string; name: string }>,
    cliToolsCache: {} as Record<string, { displayName?: string; name?: string }>,
  },
  sessionsState: {
    directories: [] as Array<{ name: string; path: string }>,
  },
  patternCancelSchedule: vi.fn(),
  scheduledTaskDelete: vi.fn(),
  sessionSnapOut: vi.fn(),
  sessionSnapBack: vi.fn(),
  openDirPicker: vi.fn(),
  setDirPickerBridge: vi.fn(),
  refreshSessions: vi.fn(),
  setSortField: vi.fn(),
  setSortDirection: vi.fn(),
  spawnTargets: { value: [] as Array<{ id: string; alias: string }> },
  peerCliTypes: [] as Array<{ id: string; name: string; kind?: string }>,
  peerCliTypeError: null as Error | null,
  peerCliTypeCalls: [] as string[],
  peerSpawnCalls: [] as Array<{ peerId: string; cliType: string; dirPath: string }>,
  peerSpawnResult: { ok: true, sessionId: 'remote-session' } as { ok: boolean; sessionId?: string; error?: string },
}));

vi.mock('../../renderer/state.js', () => ({ state: mocks.state }));
vi.mock('../../renderer/screens/sessions-state.js', () => ({ sessionsState: mocks.sessionsState }));
vi.mock('../../renderer/ipc/clients.js', () => ({
  configClient: {
  },
  patternsClient: { patternCancelSchedule: mocks.patternCancelSchedule },
  schedulerClient: { scheduledTaskDelete: mocks.scheduledTaskDelete },
  sessionsClient: {
    sessionSnapOut: mocks.sessionSnapOut,
    sessionSnapBack: mocks.sessionSnapBack,
  },
}));
vi.mock('../../renderer/screens/sessions-spawn.js', () => ({ setDirPickerBridge: mocks.setDirPickerBridge }));
vi.mock('../../renderer/stores/modal-bridge.js', () => ({
  openDirPicker: mocks.openDirPicker,
  isAnyBridgeModalVisible: () => false,
  dirPicker: { cliType: 'codex' },
  closeConfirm: { visible: false, sessionId: '', sessionName: '', draftCount: 0 },
  setCloseConfirmCallback: vi.fn(),
}));
vi.mock('../../renderer/composables/usePeers.js', () => ({
  usePeers: () => ({
    spawnTargets: mocks.spawnTargets,
    listPeerCliTypes: async (peerId: string) => {
      mocks.peerCliTypeCalls.push(peerId);
      if (mocks.peerCliTypeError) throw mocks.peerCliTypeError;
      return mocks.peerCliTypes;
    },
    spawnOnPeer: async (peerId: string, cliType: string, dirPath: string) => {
      mocks.peerSpawnCalls.push({ peerId, cliType, dirPath });
      return mocks.peerSpawnResult;
    },
    ensureSubscribed: vi.fn(),
  }),
}));
vi.mock('../../renderer/composables/useAppBootstrap.js', () => ({
  refreshSessions: mocks.refreshSessions,
  getSortField: () => 'name',
  getSortDirection: () => 'asc',
  setSortField: mocks.setSortField,
  setSortDirection: mocks.setSortDirection,
}));
vi.mock('../../renderer/sidebar/session-services.js', () => ({
  startRename: vi.fn(),
  commitRename: vi.fn(),
  cancelRename: vi.fn(),
}));
vi.mock('../../renderer/screens/sessions.js', () => ({
  toggleSessionOverviewVisibility: vi.fn(),
  setSessionState: vi.fn(),
  toggleGroupCollapse: vi.fn(),
}));

import { useSidebarController } from '../../renderer/composables/useSidebarController.js';
import { useToast } from '../../renderer/composables/useToast.js';

function createController() {
  const navStore = {
    closeOverview: vi.fn(),
    navigateToSession: vi.fn(),
    openPlan: vi.fn(),
    openOverview: vi.fn(),
  };
  const deps = {
    activeView: ref<'terminal' | 'overview' | 'plan'>('terminal'),
    navStore,
    refreshProjects: vi.fn(),
    doSpawn: vi.fn(),
    doCloseSession: vi.fn(),
  };
  return { controller: useSidebarController(deps), deps, navStore };
}

describe('useSidebarController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.activeSessionId = 's1';
    mocks.state.draftCounts = new Map();
    mocks.state.projects = [];
    mocks.sessionsState.directories = [];
    mocks.spawnTargets.value = [];
    mocks.state.cliToolsCache = {};
    mocks.peerCliTypes = [];
    mocks.peerCliTypeError = null;
    mocks.peerCliTypeCalls = [];
    mocks.peerSpawnCalls = [];
    mocks.peerSpawnResult = { ok: true, sessionId: 'remote-session' };
    useToast().removeByKey('remote-spawn-error');
  });

  it('opens the directory picker when spawn directories exist', async () => {
    // Project info is now provided by the IPC layer; no renderer-side enrichment needed.
    mocks.sessionsState.directories = [{ name: 'Hub', path: 'X:\\coding\\hub', projectId: 'p1', projectName: 'Hub', isCanonical: true }];
    const { controller, deps } = createController();

    await controller.onSpawn('codex');

    expect(deps.refreshProjects).toHaveBeenCalled();
    expect(mocks.openDirPicker).toHaveBeenCalledWith('codex', [{
      name: 'Hub',
      path: 'X:\\coding\\hub',
      projectId: 'p1',
      projectName: 'Hub',
      isCanonical: true,
    }], undefined, []);
    expect(deps.doSpawn).not.toHaveBeenCalled();
  });

  it('offers fleet peers as machine tabs from the Spawn button', async () => {
    mocks.sessionsState.directories = [{ name: 'Hub', path: 'X:\coding\hub' }];
    mocks.spawnTargets.value = [{ id: 'mac', alias: 'MacBook' }];
    const { controller } = createController();

    await controller.onSpawn('codex');

    expect(mocks.openDirPicker).toHaveBeenCalledWith('codex', mocks.sessionsState.directories, undefined,
      [{ id: 'mac', label: 'MacBook' }]);
  });

  it('opens the picker for a fleet peer even with no local directories', async () => {
    mocks.spawnTargets.value = [{ id: 'mac', alias: 'MacBook' }];
    const { controller, deps } = createController();

    await controller.onSpawn('codex');

    expect(mocks.openDirPicker).toHaveBeenCalledWith('codex', [], undefined, [{ id: 'mac', label: 'MacBook' }]);
    expect(deps.doSpawn).not.toHaveBeenCalled();
  });

  it('spawns directly when no directories are configured', async () => {
    const { controller, deps } = createController();

    await controller.onSpawn('codex');

    expect(deps.refreshProjects).toHaveBeenCalled();
    expect(deps.doSpawn).toHaveBeenCalledWith('codex');
    expect(mocks.openDirPicker).not.toHaveBeenCalled();
  });

  it('resolves the local selection to the matching peer tool id before spawning', async () => {
    mocks.state.cliToolsCache = { 'local-cli-id': { displayName: 'Claude Code' } };
    mocks.peerCliTypes = [{ id: 'peer-cli-id', name: 'Claude Code', kind: 'cli' }];
    const { controller, navStore } = createController();

    await controller.onDirPickerSelect('D:/work/project', 'local-cli-id', 'mac');

    expect(mocks.peerCliTypeCalls).toEqual(['mac']);
    expect(mocks.peerSpawnCalls).toEqual([{
      peerId: 'mac',
      cliType: 'peer-cli-id',
      dirPath: 'D:/work/project',
    }]);
    expect(navStore.navigateToSession).toHaveBeenCalledWith('remote-session');
  });

  it('refuses a remote spawn when the peer has no matching display name and shows a toast', async () => {
    mocks.state.cliToolsCache = { 'local-cli-id': { displayName: 'Claude Code' } };
    mocks.peerCliTypes = [{ id: 'peer-other-id', name: 'Copilot CLI', kind: 'cli' }];
    const { controller, navStore } = createController();

    await controller.onDirPickerSelect('D:/work/project', 'local-cli-id', 'mac');

    expect(mocks.peerSpawnCalls).toEqual([]);
    expect(navStore.navigateToSession).not.toHaveBeenCalled();
    expect(useToast().toasts.find((toast) => toast.key === 'remote-spawn-error')).toMatchObject({
      type: 'error',
      persistent: true,
      message: expect.stringMatching(/No matching tool "Claude Code".*mac/i),
    });
  });

  it('shows peer-list and spawn failures through the toast mechanism', async () => {
    mocks.state.cliToolsCache = { 'local-cli-id': { displayName: 'Claude Code' } };
    mocks.peerCliTypeError = new Error('Tool not permitted');
    const { controller } = createController();

    await controller.onDirPickerSelect('D:/work/project', 'local-cli-id', 'mac');

    expect(mocks.peerSpawnCalls).toEqual([]);
    expect(useToast().toasts.find((toast) => toast.key === 'remote-spawn-error')?.message).toContain('Tool not permitted');

    useToast().removeByKey('remote-spawn-error');
    mocks.peerCliTypeError = null;
    mocks.peerCliTypes = [{ id: 'peer-cli-id', name: 'Claude Code', kind: 'cli' }];
    mocks.peerSpawnResult = { ok: false, error: 'No live link to peer mac' };

    await controller.onDirPickerSelect('D:/work/project', 'local-cli-id', 'mac');

    expect(useToast().toasts.find((toast) => toast.key === 'remote-spawn-error')?.message).toContain('No live link to peer mac');
  });

  it('closes overview before navigating from a session click', async () => {
    const { controller, deps, navStore } = createController();
    deps.activeView.value = 'overview';

    await controller.onSessionClick('s2');

    expect(navStore.closeOverview).toHaveBeenCalled();
    expect(navStore.navigateToSession).toHaveBeenCalledWith('s2');
  });
});
