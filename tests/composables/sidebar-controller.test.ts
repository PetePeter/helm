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
  setDirPickerBridge: vi.fn(),
  refreshSessions: vi.fn(),
  setSortField: vi.fn(),
  setSortDirection: vi.fn(),
  spawnTargets: { value: [] as Array<{ id: string; alias: string }> },
  peerCliTypes: [] as Array<{ id: string; name: string; kind?: string }>,
  peerCliTypeError: null as Error | null,
  peerCliTypeCalls: [] as string[],
  peerDirs: [] as Array<{ name: string; path: string }>,
  peerDirCalls: [] as string[],
  peerDirsPromise: null as Promise<Array<{ name: string; path: string }>> | null,
  peerDirsError: null as Error | null,
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
vi.mock('../../renderer/stores/modal-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../renderer/stores/modal-bridge.js')>('../../renderer/stores/modal-bridge.js');
  return {
    ...actual,
    isAnyBridgeModalVisible: () => false,
    closeConfirm: { visible: false, sessionId: '', sessionName: '', draftCount: 0 },
    setCloseConfirmCallback: vi.fn(),
  };
});
vi.mock('../../renderer/composables/usePeers.js', () => ({
  usePeers: () => ({
    spawnTargets: mocks.spawnTargets,
    listPeerCliTypes: async (peerId: string) => {
      mocks.peerCliTypeCalls.push(peerId);
      if (mocks.peerCliTypeError) throw mocks.peerCliTypeError;
      return mocks.peerCliTypes;
    },
    listPeerDirs: async (peerId: string) => {
      mocks.peerDirCalls.push(peerId);
      if (mocks.peerDirsError) throw mocks.peerDirsError;
      if (mocks.peerDirCalls.length === 1 && mocks.peerDirsPromise) return mocks.peerDirsPromise;
      return mocks.peerDirs;
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
import { closeDirPicker, dirPicker } from '../../renderer/stores/modal-bridge.js';

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
    closeDirPicker();
    mocks.state.activeSessionId = 's1';
    mocks.state.draftCounts = new Map();
    mocks.state.projects = [];
    mocks.sessionsState.directories = [];
    mocks.spawnTargets.value = [];
    mocks.state.cliToolsCache = {};
    mocks.peerCliTypes = [];
    mocks.peerCliTypeError = null;
    mocks.peerCliTypeCalls = [];
    mocks.peerDirs = [];
    mocks.peerDirCalls = [];
    mocks.peerDirsPromise = null;
    mocks.peerDirsError = null;
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
    expect(dirPicker).toMatchObject({
      visible: true,
      cliType: 'codex',
      items: [{
        name: 'Hub',
        path: 'X:\\coding\\hub',
        projectId: 'p1',
        projectName: 'Hub',
        isCanonical: true,
      }],
      machineId: '',
    });
    expect(deps.doSpawn).not.toHaveBeenCalled();
  });

  it('loads folders for the chosen peer, then spawns with that peer tool id and path', async () => {
    mocks.peerDirs = [{ name: 'Remote Project', path: 'D:/remote/project' }];
    const { controller, deps } = createController();

    await controller.onSpawn('peer-cli-id', 'mac');

    expect(mocks.peerDirCalls).toEqual(['mac']);
    expect(dirPicker).toMatchObject({
      visible: true,
      cliType: 'peer-cli-id',
      machineId: 'mac',
      items: [{ name: 'Remote Project', path: 'D:/remote/project' }],
      loading: false,
    });
    expect(deps.doSpawn).not.toHaveBeenCalled();

    await controller.onDirPickerSelect('D:/remote/project', 'peer-cli-id', 'mac');
    expect(mocks.peerSpawnCalls).toEqual([{ peerId: 'mac', cliType: 'peer-cli-id', dirPath: 'D:/remote/project' }]);
  });

  it('spawns directly when no directories are configured', async () => {
    const { controller, deps } = createController();

    await controller.onSpawn('codex');

    expect(deps.refreshProjects).toHaveBeenCalled();
    expect(deps.doSpawn).toHaveBeenCalledWith('codex');
    expect(dirPicker.visible).toBe(false);
  });

  it('drops late peer folders after the picker is reopened for a different tool', async () => {
    let resolveFirst!: (items: Array<{ name: string; path: string }>) => void;
    mocks.peerDirsPromise = new Promise(resolve => { resolveFirst = resolve; });
    mocks.peerDirs = [{ name: 'Second Tool Project', path: 'D:/second/project' }];
    const { controller } = createController();

    const firstPicker = controller.onSpawn('first-peer-tool', 'mac');
    expect(dirPicker).toMatchObject({ cliType: 'first-peer-tool', machineId: 'mac', loading: true });
    await controller.onSpawn('second-peer-tool', 'mac');
    expect(dirPicker).toMatchObject({
      cliType: 'second-peer-tool',
      items: [{ name: 'Second Tool Project', path: 'D:/second/project' }],
      loading: false,
    });

    resolveFirst([{ name: 'Late First Tool Project', path: 'D:/late/project' }]);
    await firstPicker;

    expect(dirPicker).toMatchObject({
      cliType: 'second-peer-tool',
      items: [{ name: 'Second Tool Project', path: 'D:/second/project' }],
      loading: false,
    });
  });

  it('shows a peer folder request error in the real directory picker state', async () => {
    mocks.peerDirsError = new Error('Folders denied');
    const { controller } = createController();

    await controller.onSpawn('peer-cli-id', 'mac');

    expect(dirPicker).toMatchObject({
      visible: true,
      machineId: 'mac',
      loading: false,
      error: 'Folders denied',
    });
  });

  it('passes the selected peer-owned tool id straight to spawnOnPeer', async () => {
    const { controller, navStore } = createController();

    await controller.onDirPickerSelect('D:/work/project', 'peer-cli-id', 'mac');

    expect(mocks.peerCliTypeCalls).toEqual([]);
    expect(mocks.peerSpawnCalls).toEqual([{
      peerId: 'mac',
      cliType: 'peer-cli-id',
      dirPath: 'D:/work/project',
    }]);
    expect(navStore.navigateToSession).toHaveBeenCalledWith('remote-session');
  });

  it('shows remote spawn failures through the persistent toast mechanism', async () => {
    mocks.peerSpawnResult = { ok: false, error: 'Tool not permitted' };
    const { controller } = createController();

    await controller.onDirPickerSelect('D:/work/project', 'peer-cli-id', 'mac');

    expect(mocks.peerSpawnCalls).toEqual([{ peerId: 'mac', cliType: 'peer-cli-id', dirPath: 'D:/work/project' }]);
    expect(useToast().toasts.find((toast) => toast.key === 'remote-spawn-error')).toMatchObject({
      type: 'error',
      persistent: true,
      message: expect.stringContaining('Tool not permitted'),
    });
  });

  it('closes overview before navigating from a session click', async () => {
    const { controller, deps, navStore } = createController();
    deps.activeView.value = 'overview';

    await controller.onSessionClick('s2');

    expect(navStore.closeOverview).toHaveBeenCalled();
    expect(navStore.navigateToSession).toHaveBeenCalledWith('s2');
  });
});
