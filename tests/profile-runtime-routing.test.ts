import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';
import {
  createAdminHandoverDelivery,
  createAdminOperatorTaskWatcher,
  createAdminPromptDelivery,
  createProfileRecycleBinRestorer,
  ringAnsweredForBoundDevice,
  sendDesktopChatToSessionOwner,
} from '../src/electron/ipc/profile-runtime-routing.js';
import { ActiveProfileRuntimeView } from '../src/electron/active-profile-runtime.js';
import { ProfileRuntimeComposition } from '../src/electron/profile-runtime-composition.js';
import { registerProfileSessionCleanup } from '../src/electron/profile-session-cleanup.js';
import { ComfyUiSessionHost } from '../src/session/comfyui/comfyui-session-host.js';
import { cloneDefaultComfyUiConfigForKind } from '../src/session/comfyui/comfyui-config.js';
import type { ProfileRuntime } from '../src/session/profile-runtime.js';
import { ProfileIpcController } from '../src/electron/ipc/profile-handlers.js';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { PtyManager } from '../src/session/pty-manager.js';
import { RecycleBinManager } from '../src/session/recycle-bin-manager.js';
import { getProfileConfigDir } from '../src/utils/app-paths.js';
import { WindowManager } from '../src/electron/window-manager.js';
import type { RecycleBinEntry } from '../src/types/recycle-bin.js';

const roots: string[] = [];

function setupAdminRouting() {
  const appData = mkdtempSync(join(tmpdir(), 'helm-profile-routing-'));
  roots.push(appData);
  const globalConfigDir = join(appData, 'Helm', 'config');
  const profileOneDir = getProfileConfigDir('1', appData);
  mkdirSync(globalConfigDir, { recursive: true });
  mkdirSync(profileOneDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'settings.yaml'), '{}\n');
  const configLoader = new ConfigLoader({ userProfileId: '1', profileConfigDir: profileOneDir, globalConfigDir });
  const profileStore = new UserProfileStore(globalConfigDir);
  const composition = new ProfileRuntimeComposition({ configLoader, userProfileStore: profileStore, ptyManager: new PtyManager() });
  const controller = new ProfileIpcController({
    profileStore,
    composition,
    runtimeView: new ActiveProfileRuntimeView(composition.getRequiredRuntime('1')),
    devices: new MobileDeviceStore(),
    windowManager: new WindowManager(),
  });
  const profileTwo = composition.createProfile('Kids');
  return { composition, profileStore, controller, profileTwo };
}

function addSession(runtime: ProfileRuntime, id: string): void {
  runtime.sessionManager.addSession({ id, name: id, cliType: 'test', processId: 1, workingDir: 'X:\\project' });
}

function recordingPty() {
  const writes: Array<{ sessionId: string; text: string }> = [];
  const ptyManager = new EventEmitter() as PtyManager;
  Object.assign(ptyManager, {
    nudgeResize: async () => undefined,
    write: (sessionId: string, text: string) => { writes.push({ sessionId, text }); return true; },
    deliverText: async (sessionId: string, text: string) => { writes.push({ sessionId, text }); },
  });
  return { ptyManager, writes };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<RecycleBinEntry> = {}): RecycleBinEntry {
  return {
    id: 'bin-entry', sessionId: 'session-1', name: 'Session', cliType: 'claude-code',
    workingDir: 'X:/source-project', cliSessionName: 'cli-session', closedAt: 1,
    ...overrides,
  };
}

function makeRuntime(profileId: string, entry?: RecycleBinEntry, projects = ['X:/source-project']) {
  const entries = entry ? [entry] : [];
  const metadataOperations: string[] = [];
  const restoring = new Set<string>();
  return {
    userProfileId: profileId,
    metadataOperations,
    recycleBinManager: {
      peek: vi.fn((id: string) => entries.find(candidate => candidate.id === id) ?? null),
      beginRestore: vi.fn((id: string) => {
        const found = entries.find(candidate => candidate.id === id) ?? null;
        if (found) restoring.add(id);
        return found;
      }),
      releaseRestore: vi.fn((id: string) => { restoring.delete(id); }),
      removeRestored: vi.fn((id: string) => {
        metadataOperations.push('commit');
        const index = entries.findIndex(candidate => candidate.id === id);
        if (index >= 0) entries.splice(index, 1);
      }),
    },
    sessionManager: {
      hasSession: vi.fn(() => false),
      renameSession: vi.fn((_id: string, _name: string) => { metadataOperations.push('rename'); }),
      getSpawnCwdContext: () => ({ userProfileId: profileId, projectStore: { list: () => projects.map(canonicalPath => ({ canonicalPath })) } }),
      restoreMission: vi.fn(),
    },
    runtimeGroupManager: {
      ensureGroup: vi.fn(() => { metadataOperations.push('ensure-group'); }),
      addSession: vi.fn(() => { metadataOperations.push('add-session'); }),
    },
    configLoader: { reloadActiveProfileIfChanged: vi.fn() },
  };
}

describe('profile runtime routing', () => {
  it.each([
    ['no device binding', undefined],
    ['stale profile binding', 'deleted-profile'],
  ])('does not route ringAnswered with %s', (_case, binding) => {
    const ringAnswered = vi.fn();
    const profileId = binding;
    const routed = ringAnsweredForBoundDevice({
      sessionId: 'session-1', deviceId: 'phone-1',
      devices: { get: () => profileId ? { userProfileId: profileId } : {} } as any,
      profiles: { list: () => [{ id: '1' }] } as any,
      registry: { getRequiredRuntime: vi.fn(() => { throw new Error('stale runtime'); }) } as any,
      services: { forProfile: () => ({ service: { ringAnswered } }) } as any,
    });

    expect(routed).toBe(false);
    expect(ringAnswered).not.toHaveBeenCalled();
  });

  it('routes ringAnswered only to the currently bound profile runtime', () => {
    const ringAnswered = vi.fn();
    const routed = ringAnsweredForBoundDevice({
      sessionId: 'session-1', deviceId: 'phone-1',
      devices: { get: () => ({ userProfileId: '2' }) } as any,
      profiles: { list: () => [{ id: '1' }, { id: '2' }] } as any,
      registry: { getRequiredRuntime: vi.fn(id => ({ userProfileId: id })) } as any,
      services: { forProfile: vi.fn(() => ({ service: { ringAnswered } })) } as any,
    });

    expect(routed).toBe(true);
    expect(ringAnswered).toHaveBeenCalledOnce();
    expect(ringAnswered).toHaveBeenCalledWith('session-1');
  });

  it('keeps restore bound to its source runtime when the active profile switches', async () => {
    const entry = makeEntry({ name: 'Restored Name', runtimeGroupId: 'group-2', runtimeGroupName: 'Source Group' });
    const admin = makeRuntime('1');
    const source = makeRuntime('2', entry);
    const ptyManager = { has: vi.fn(() => false) };
    const stateDetector = { markRestored: vi.fn() };
    let activeProfileId = '2';
    const spawn = vi.fn((params: any) => {
      activeProfileId = '1';
      expect(params.sessionManager).toBe(source.sessionManager);
      expect(params.configLoader).toBe(source.configLoader);
      return {};
    });
    const restore = createProfileRecycleBinRestorer({
      registry: { all: () => [admin, source] } as any,
      getActiveProfileId: () => activeProfileId,
      ptyManager: ptyManager as any,
      stateDetector: stateDetector as any,
      trackPromptCanceller: vi.fn(),
      spawn: spawn as any,
    });

    await expect(restore(entry.id)).resolves.toEqual(entry);

    expect(activeProfileId).toBe('1');
    expect(source.sessionManager.restoreMission).toHaveBeenCalledWith(entry.sessionId, undefined, undefined);
    expect(source.sessionManager.renameSession).toHaveBeenCalledWith(entry.sessionId, 'Restored Name');
    expect(source.runtimeGroupManager.ensureGroup).toHaveBeenCalledWith('group-2', 'Source Group');
    expect(source.runtimeGroupManager.addSession).toHaveBeenCalledWith('group-2', entry.sessionId);
    expect(source.metadataOperations).toEqual(['rename', 'ensure-group', 'add-session', 'commit']);
    expect(source.recycleBinManager.removeRestored).toHaveBeenCalledWith(entry.id);
    expect(admin.recycleBinManager.removeRestored).not.toHaveBeenCalled();
  });

  it('routes MCP restore to its explicit profile and guards the saved name', async () => {
    const entry = makeEntry({ name: 'Saved Name' });
    const admin = makeRuntime('1');
    const source = makeRuntime('2', entry);
    const spawn = vi.fn();
    const restore = createProfileRecycleBinRestorer({
      registry: { all: () => [admin, source] } as any,
      getActiveProfileId: () => '1',
      ptyManager: { has: vi.fn(() => false) } as any,
      stateDetector: { markRestored: vi.fn() } as any,
      trackPromptCanceller: vi.fn(),
      spawn: spawn as any,
    });

    await expect(restore(entry.id, { profileId: '2', expectedName: 'Saved Name' })).resolves.toEqual(entry);
    expect(spawn).toHaveBeenCalledOnce();
    expect(source.sessionManager.renameSession).toHaveBeenCalledWith(entry.sessionId, 'Saved Name');
    expect(source.recycleBinManager.removeRestored).toHaveBeenCalledWith(entry.id);
    expect(admin.recycleBinManager.peek).not.toHaveBeenCalled();
  });

  it('rejects a mismatched expected name without spawning or committing', async () => {
    const entry = makeEntry({ name: 'Saved Name' });
    const source = makeRuntime('2', entry);
    const spawn = vi.fn();
    const restore = createProfileRecycleBinRestorer({
      registry: { all: () => [source] } as any,
      getActiveProfileId: () => '1',
      ptyManager: { has: vi.fn(() => false) } as any,
      stateDetector: { markRestored: vi.fn() } as any,
      trackPromptCanceller: vi.fn(),
      spawn: spawn as any,
    });

    await expect(restore(entry.id, { profileId: '2', expectedName: 'Wrong Name' })).rejects.toThrow(/expected name/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(source.recycleBinManager.removeRestored).not.toHaveBeenCalled();
  });

  it('reports a duplicate in-flight restore for the same profile entry', async () => {
    const entry = makeEntry();
    const source = makeRuntime('2', entry);
    const restore = createProfileRecycleBinRestorer({
      registry: { all: () => [source] } as any,
      getActiveProfileId: () => '1',
      ptyManager: { has: vi.fn(() => false) } as any,
      stateDetector: { markRestored: vi.fn() } as any,
      trackPromptCanceller: vi.fn(),
      spawn: vi.fn(() => ({})) as any,
    });
    const first = restore(entry.id, { profileId: '2' });
    const duplicate = restore(entry.id, { profileId: '2' });

    await expect(first).resolves.toEqual(entry);
    await expect(duplicate).rejects.toThrow(/already in progress/i);
  });

  it('keeps a failed explicit-profile restore retryable and surfaces the spawn error', async () => {
    const entry = makeEntry();
    const source = makeRuntime('2', entry);
    const restore = createProfileRecycleBinRestorer({
      registry: { all: () => [source] } as any,
      getActiveProfileId: () => '1',
      ptyManager: { has: vi.fn(() => false) } as any,
      stateDetector: { markRestored: vi.fn() } as any,
      trackPromptCanceller: vi.fn(),
      spawn: (() => { throw new Error('spawn failed'); }) as any,
    });

    await expect(restore(entry.id, { profileId: '2' })).rejects.toThrow('spawn failed');
    expect(source.recycleBinManager.removeRestored).not.toHaveBeenCalled();
  });

  it('rejects a recycle-bin entry owned by another profile before spawning', async () => {
    const entry = makeEntry();
    const active = makeRuntime('1');
    const other = makeRuntime('2', entry);
    const spawn = vi.fn();
    const restore = createProfileRecycleBinRestorer({
      registry: { all: () => [active, other] } as any,
      getActiveProfileId: () => '1',
      ptyManager: { has: vi.fn(() => false) } as any,
      stateDetector: { markRestored: vi.fn() } as any,
      trackPromptCanceller: vi.fn(),
      spawn: spawn as any,
    });

    await expect(restore(entry.id)).rejects.toThrow(/not found or expired/i);

    expect(spawn).not.toHaveBeenCalled();
    expect(other.recycleBinManager.removeRestored).not.toHaveBeenCalled();
    expect(active.recycleBinManager.beginRestore).toHaveBeenCalledWith(entry.id);
  });

  it('rejects a restore cwd outside the source profile projects without committing', async () => {
    const entry = makeEntry({ workingDir: 'X:/another-profile' });
    const source = makeRuntime('2', entry, ['X:/source-project']);
    const ptyManager = { has: vi.fn(() => false), spawn: vi.fn() };
    const restore = createProfileRecycleBinRestorer({
      registry: { all: () => [source] } as any,
      getActiveProfileId: () => '2',
      ptyManager: ptyManager as any,
      stateDetector: { markRestored: vi.fn() } as any,
      trackPromptCanceller: vi.fn(),
    });

    await expect(restore(entry.id)).rejects.toThrow();

    expect(source.recycleBinManager.removeRestored).not.toHaveBeenCalled();
    expect(source.sessionManager.restoreMission).not.toHaveBeenCalled();
    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });

  it('reserves a row during restore so Forget and Empty cannot queue the live session', async () => {
    const runtime = makeRuntime('2');
    const manager = new RecycleBinManager();
    const entry = manager.append({ ...makeEntry(), closedAt: Date.now() });
    runtime.recycleBinManager = manager;
    let onSpawnStarted!: () => void;
    let finishSpawn!: () => void;
    const spawnStarted = new Promise<void>(resolve => { onSpawnStarted = resolve; });
    const spawnGate = new Promise<void>(resolve => { finishSpawn = resolve; });
    const restore = createProfileRecycleBinRestorer({
      registry: { all: () => [runtime] } as any,
      getActiveProfileId: () => '2',
      ptyManager: { has: vi.fn(() => false) } as any,
      stateDetector: { markRestored: vi.fn() } as any,
      trackPromptCanceller: vi.fn(),
      spawn: (async () => { onSpawnStarted(); await spawnGate; }) as any,
    });

    const restoringRequest = restore(entry.id);
    await spawnStarted;
    expect(() => manager.forget(entry.id)).toThrow(/being restored/i);
    expect(() => manager.empty()).toThrow(/being restored/i);

    finishSpawn();
    await expect(restoringRequest).resolves.toEqual(entry);
    expect(manager.pendingPurgeJobs()).toEqual([]);
    expect(manager.list()).toEqual([]);
  });

  it('rolls back a live restore when the durable bin commit fails without purging session data', async () => {
    const { composition, profileTwo } = setupAdminRouting();
    const runtime = composition.getRequiredRuntime(profileTwo.id);
    const entry = runtime.recycleBinManager.append({ ...makeEntry({ cliType: 'comfyui' }), closedAt: Date.now() });
    const memory = runtime.memoryManager.createForSession(entry.sessionId, {
      tldr: 'keep this memory', content: 'restore retry data', sessionBound: true,
    });
    const chatFiles = runtime.artifactManager.create(entry.sessionId, 'Chat files', 'markdown', 'saved image', 'manual');
    const savedImage = runtime.artifactAttachmentManager.add(chatFiles.id, {
      filename: 'saved.png', content: Buffer.from([137, 80, 78, 71]), contentType: 'image/png',
    });
    const savedImagePath = runtime.artifactAttachmentManager.getPath(chatFiles.id, savedImage.id);
    runtime.draftManager.append(entry.sessionId, 'keep this draft', 'user');
    runtime.todoManager.add(entry.sessionId, 'keep this todo');
    const removeRestored = vi.spyOn(runtime.recycleBinManager, 'removeRestored').mockImplementation(() => {
      throw new Error('disk failure');
    });
    const comfyHost = new ComfyUiSessionHost({
      tempDir: runtime.configDir,
      storesForProfile: () => ({ artifacts: runtime.artifactManager, attachments: runtime.artifactAttachmentManager }),
      postChat: async () => undefined,
      recordPrompt: () => undefined,
      notifyRequester: async () => undefined,
    });
    const comfyConfig = { ...cloneDefaultComfyUiConfigForKind('image'), endpoint: 'http://comfy.test:8188' };
    const comfyProcess = comfyHost.create(entry.sessionId, comfyConfig, profileTwo.id);
    const killComfyProcess = vi.spyOn(comfyProcess, 'kill');
    const ptyManager = new PtyManager();
    ptyManager.on('exit', (sessionId: string) => {
      if (runtime.sessionManager.hasSession(sessionId)) {
        runtime.sessionManager.removeSession(sessionId, { force: true });
      }
    });
    const processEffects = {
      forgetSessionState: vi.fn(),
      abortComfyUiSession: vi.fn((sessionId: string) => comfyHost.abortSession(sessionId)),
      closeComfyUiSession: vi.fn((sessionId: string) => comfyHost.closeSession(sessionId)),
      pruneMobileJournal: vi.fn(),
    };
    registerProfileSessionCleanup(composition, processEffects);

    const restore = createProfileRecycleBinRestorer({
      registry: composition.registry,
      getActiveProfileId: () => '1',
      ptyManager,
      stateDetector: { markRestored: vi.fn() },
      trackPromptCanceller: vi.fn(),
      spawn: ({ sessionManager, sessionId, cliType, cwd, resumeSessionName }) => {
        ptyManager.adopt(sessionId, comfyProcess, { cols: 80, rows: 24 });
        sessionManager.addSession({
          id: sessionId, name: 'Restored', cliType, processId: comfyProcess.pid,
          workingDir: cwd, cliSessionName: resumeSessionName, comfyUiTool: true,
        });
        return { sessionId } as any;
      },
    });

    try {
      await expect(restore(entry.id, { profileId: profileTwo.id })).rejects.toThrow('disk failure');

      expect(killComfyProcess).toHaveBeenCalledOnce();
      expect(ptyManager.has(entry.sessionId)).toBe(false);
      expect(runtime.sessionManager.hasSession(entry.sessionId)).toBe(false);
      expect(runtime.recycleBinManager.list()).toEqual([entry]);
      expect(runtime.recycleBinManager.list()).toHaveLength(1);
      expect(runtime.recycleBinManager.pendingPurgeJobs()).toEqual([]);
      expect(runtime.memoryManager.getRecord(memory.id)).not.toBeNull();
      expect(runtime.artifactManager.count(entry.sessionId)).toBe(1);
      expect(runtime.artifactAttachmentManager.list(chatFiles.id)).toEqual([savedImage]);
      expect(existsSync(savedImagePath)).toBe(true);
      expect(runtime.draftManager.get(entry.sessionId).text).toBe('keep this draft');
      expect(runtime.todoManager.list(entry.sessionId)).toHaveLength(1);
      expect(processEffects.forgetSessionState).toHaveBeenCalledWith(runtime, entry.sessionId);
      expect(processEffects.pruneMobileJournal).not.toHaveBeenCalled();
      expect(processEffects.closeComfyUiSession).not.toHaveBeenCalled();
      expect(processEffects.abortComfyUiSession).toHaveBeenCalledOnce();
      expect(removeRestored).toHaveBeenCalledWith(entry.id);
    } finally {
      composition.dispose();
    }
  });
});

describe('admin profile routing while another profile is active', () => {
  it('delivers voice prompts to the admin profile operator', async () => {
    const { composition, profileStore, controller, profileTwo } = setupAdminRouting();
    try {
      addSession(composition.getRequiredRuntime('1'), 'operator-1');
      addSession(composition.getRequiredRuntime(profileTwo.id), 'child-session');
      expect(await controller.switchProfile(profileTwo.id)).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profileTwo.id);
      const { ptyManager, writes } = recordingPty();

      await createAdminPromptDelivery(composition.getRequiredRuntime('1'), ptyManager)('operator-1', 'voice prompt');

      expect(writes.some(write => write.sessionId === 'operator-1' && write.text.includes('voice prompt'))).toBe(true);
    } finally {
      composition.dispose();
    }
  });

  it('delivers admin handovers through the admin session and CLI configuration', async () => {
    const { composition, profileStore, controller, profileTwo } = setupAdminRouting();
    try {
      addSession(composition.getRequiredRuntime('1'), 'parent-session');
      addSession(composition.getRequiredRuntime(profileTwo.id), 'child-session');
      expect(await controller.switchProfile(profileTwo.id)).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profileTwo.id);
      const { ptyManager, writes } = recordingPty();
      const handover = createAdminHandoverDelivery(
        composition.getRequiredRuntime('1'), ptyManager, { notifyLlmDirected() {} } as any,
        { floorMs: 0, silenceMs: 0 }, 0,
      );
      handover.arm('parent-session', 'handover note');
      const settled = handover.whenSettled('parent-session');
      handover.sendNow('parent-session');
      await settled;

      expect(writes.some(write => write.sessionId === 'parent-session' && write.text.includes('handover note'))).toBe(true);
      handover.dispose();
    } finally {
      composition.dispose();
    }
  });

  it('keeps the admin operator task watcher on the admin runtime', async () => {
    const { composition, profileStore, controller, profileTwo } = setupAdminRouting();
    try {
      const admin = composition.getRequiredRuntime('1');
      admin.sessionManager.addSession({
        id: 'builder-1', name: 'Builder', cliType: 'test', processId: 1,
        workingDir: 'X:\\project', activityLevel: 'active',
      });
      const timer = { id: 'check-1', status: 'pending', mode: 'direct', planIds: ['plan-1'], enabled: true, scheduleKind: 'interval' } as any;
      const plan = { status: 'doing', task: { builderSessionId: 'builder-1', checks: 'on' } };
      const runs: string[] = [];
      admin.scheduledTaskManager.listTasks = () => [timer];
      admin.scheduledTaskManager.runTaskNow = async id => { runs.push(id); return true; };
      admin.planManager.getItem = id => id === 'plan-1' ? plan as any : null;
      addSession(composition.getRequiredRuntime(profileTwo.id), 'child-session');
      expect(await controller.switchProfile(profileTwo.id)).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profileTwo.id);
      createAdminOperatorTaskWatcher(admin).start();

      admin.sessionManager.updateSession('builder-1', { activityLevel: 'idle' });

      expect(runs).toEqual(['check-1']);
    } finally {
      composition.dispose();
    }
  });

  it('sends desktop chat through the owning profile service', async () => {
    const { composition, profileStore, controller, profileTwo } = setupAdminRouting();
    try {
      addSession(composition.getRequiredRuntime('1'), 'parent-session');
      addSession(composition.getRequiredRuntime(profileTwo.id), 'child-session');
      expect(await controller.switchProfile(profileTwo.id)).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profileTwo.id);
      const messages: Array<{ profileId: string; sessionId: string; text: string }> = [];

      await sendDesktopChatToSessionOwner({
        registry: composition.registry,
        serviceForProfile: profileId => ({
          sendDesktopChatTextToSession: async (sessionId: string, text: string) => { messages.push({ profileId, sessionId, text }); },
        }),
        sessionId: 'child-session',
        text: 'chat prompt',
      });

      expect(messages).toEqual([{ profileId: profileTwo.id, sessionId: 'child-session', text: 'chat prompt' }]);
    } finally {
      composition.dispose();
    }
  });
});
