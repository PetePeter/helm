import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { hashProfilePin } from '../src/config/profile-pin.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';
import { ActiveProfileRuntimeView } from '../src/electron/active-profile-runtime.js';
import { ProfileRuntimeComposition } from '../src/electron/profile-runtime-composition.js';
import { WindowManager } from '../src/electron/window-manager.js';
import { ProfileIpcController, setupProfileRuntimeDomain } from '../src/electron/ipc/profile-handlers.js';
import { ProfileMcpRouter } from '../src/mcp/profile-mcp-router.js';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { PtyManager } from '../src/session/pty-manager.js';
import { RECYCLE_BIN_WINDOW_MS } from '../src/session/recycle-bin-manager.js';
import { getProfileConfigDir } from '../src/utils/app-paths.js';

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => { ipcHandlers.set(channel, handler); },
    removeHandler: (channel: string) => { ipcHandlers.delete(channel); },
  },
}));

const roots: string[] = [];

function setup(onProfileChanged?: (id: string) => void | Promise<void>, windowManager = new WindowManager()) {
  const appData = mkdtempSync(join(tmpdir(), 'helm-profile-ipc-'));
  roots.push(appData);
  const globalConfigDir = join(appData, 'Helm', 'config');
  const profileOneDir = getProfileConfigDir('1', appData);
  mkdirSync(globalConfigDir, { recursive: true });
  mkdirSync(profileOneDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'settings.yaml'), '{}\n');
  const configLoader = new ConfigLoader({ userProfileId: '1', profileConfigDir: profileOneDir, globalConfigDir });
  const profileStore = new UserProfileStore(globalConfigDir);
  const ptyManager = new PtyManager();
  const composition = new ProfileRuntimeComposition({ configLoader, userProfileStore: profileStore, ptyManager });
  const runtimeView = new ActiveProfileRuntimeView(composition.getRequiredRuntime(profileStore.getActiveProfileId()));
  const devices = new MobileDeviceStore();
  const controller = new ProfileIpcController({ profileStore, composition, runtimeView, devices, windowManager, onProfileChanged });
  return { appData, profileStore, composition, runtimeView, devices, controller, windowManager, ptyManager };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('ProfileIpcController', () => {
  it('rejects a wrong PIN without changing the active runtime', async () => {
    const { profileStore, composition, controller } = setup();
    try {
      const profile = composition.createProfile('Child');
      profileStore.setPinHash(profile.id, hashProfilePin('4826'));

      const result = await controller.switchProfile(profile.id, '0000');

      expect(result).toMatchObject({ ok: false });
      expect(profileStore.getActiveProfileId()).toBe('1');
    } finally {
      composition.dispose();
    }
  });

  it('validates PIN format on the main process and switches with the verified PIN', async () => {
    const { composition, controller, profileStore } = setup();
    try {
      const profile = composition.createProfile('Child');
      expect(await controller.switchProfile(profile.id)).toMatchObject({ ok: true });
      expect(controller.setProfilePin(profile.id, '12')).toMatchObject({ ok: false });
      expect(controller.setProfilePin(profile.id, '2468')).toMatchObject({ ok: true });
      expect(await controller.switchProfile('1')).toEqual({ ok: true });
      expect(await controller.switchProfile(profile.id, '2468')).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profile.id);
    } finally {
      composition.dispose();
    }
  });

  it('switches a no-PIN profile and moves existing runtime references with it', async () => {
    const { profileStore, composition, runtimeView, controller } = setup();
    try {
      const profile = composition.createProfile('Child');
      const sessionView = runtimeView.runtime.sessionManager as unknown as { getAllSessions: () => unknown[] };
      composition.getRequiredRuntime('1').sessionManager.addSession({
        id: 'parent-session', name: 'Parent', cliType: 'test', processId: 1, workingDir: 'X:\\parent',
      });
      expect(sessionView.getAllSessions()).toHaveLength(1);

      const result = await controller.switchProfile(profile.id);

      expect(result).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profile.id);
      expect(sessionView.getAllSessions()).toEqual([]);
    } finally {
      composition.dispose();
    }
  });

  it('closes snap-outs owned by the previous profile while keeping their sessions for switch-back', async () => {
    const windowManager = new WindowManager();
    const makeWindow = (id: number) => ({
      id,
      isDestroyed: () => false,
      destroy: vi.fn(),
      webContents: { id, send: vi.fn() },
    });
    const main = makeWindow(1);
    const adminSnapOut = makeWindow(2);
    const memberSnapOut = makeWindow(3);
    windowManager.setMainWindow(main as any);
    windowManager.registerWindow(2, adminSnapOut as any);
    windowManager.registerWindow(3, memberSnapOut as any);
    const { composition, controller, windowManager: manager } = setup(undefined, windowManager);
    try {
      const member = composition.createProfile('Member');
      composition.getRequiredRuntime('1').sessionManager.addSession({
        id: 'admin-terminal', name: 'Admin terminal', cliType: 'test', processId: 11, workingDir: 'X:\\admin',
      });
      composition.getRequiredRuntime(member.id).sessionManager.addSession({
        id: 'member-terminal', name: 'Member terminal', cliType: 'test', processId: 12, workingDir: 'X:\\member',
      });
      manager.assignSessionToWindow('admin-terminal', 2);
      manager.assignSessionToWindow('member-terminal', 3);

      expect(await controller.switchProfile(member.id)).toEqual({ ok: true });

      expect(adminSnapOut.destroy).toHaveBeenCalledOnce();
      expect(memberSnapOut.destroy).not.toHaveBeenCalled();
      expect(manager.getWindowIdForSession('admin-terminal')).toBeUndefined();
      expect(composition.getRequiredRuntime('1').sessionManager.hasSession('admin-terminal')).toBe(true);

      expect(await controller.switchProfile('1')).toEqual({ ok: true });

      expect(memberSnapOut.destroy).toHaveBeenCalledOnce();
      expect(manager.getWindowIdForSession('member-terminal')).toBeUndefined();
      expect(composition.getRequiredRuntime(member.id).sessionManager.hasSession('member-terminal')).toBe(true);
    } finally {
      composition.dispose();
    }
  });

  it('tells every surviving window about a switch so each drops the previous profile renderer state', async () => {
    const windowManager = new WindowManager();
    const makeWindow = (id: number) => ({ id, isDestroyed: () => false, destroy: vi.fn(), webContents: { id, send: vi.fn() } });
    const main = makeWindow(1);
    const popOut = makeWindow(2);
    windowManager.setMainWindow(main as any);
    windowManager.registerWindow(2, popOut as any);
    const { composition, controller } = setup(undefined, windowManager);
    try {
      const member = composition.createProfile('Member');
      expect(await controller.switchProfile(member.id)).toMatchObject({ ok: true });
      expect(main.webContents.send).toHaveBeenCalledWith('profile:changed', expect.objectContaining({ id: member.id }));
      expect(popOut.webContents.send).toHaveBeenCalledWith('profile:changed', expect.objectContaining({ id: member.id }));
    } finally {
      composition.dispose();
    }
  });

  it('waits for profile runtime preparation before committing the switch', async () => {
    let finishPreparation!: () => void;
    let prepared = false;
    const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
    const { profileStore, composition, runtimeView, controller } = setup(async () => {
      await preparation;
      prepared = true;
    });
    try {
      const profile = composition.createProfile('Child');
      const pending = controller.switchProfile(profile.id);

      expect(profileStore.getActiveProfileId()).toBe('1');
      expect(runtimeView.runtime.userProfileId).toBe('1');
      finishPreparation();

      expect(await pending).toMatchObject({ ok: true });
      expect(prepared).toBe(true);
      expect(profileStore.getActiveProfileId()).toBe(profile.id);
      expect(runtimeView.runtime.userProfileId).toBe(profile.id);
    } finally {
      composition.dispose();
    }
  });

  it('persists device-to-profile binding and protects profiles with bound devices from deletion', () => {
    const { profileStore, composition, devices, controller } = setup();
    try {
      const profile = composition.createProfile('Child');
      const device = devices.add({ machineId: 'tablet-one', name: 'Tablet', pskRef: 'secret-ref' });

      expect(controller.bindDeviceToProfile(device.id, profile.id)).toMatchObject({ ok: true });
      expect(devices.get(device.id)?.userProfileId).toBe(profile.id);
      expect(controller.deleteProfile(profile.id)).toMatchObject({ ok: false });
      expect(profileStore.list().some(item => item.id === profile.id)).toBe(true);
    } finally {
      composition.dispose();
    }
  });

  it('redacts other profiles for a non-admin while keeping the active profile counts', async () => {
    const { composition, controller } = setup();
    try {
      const child = composition.createProfile('Child');
      expect(await controller.switchProfile(child.id)).toMatchObject({ ok: true });

      const profiles = controller.listProfiles();
      const own = profiles.find(profile => profile.id === child.id)!;
      const other = profiles.find(profile => profile.id === '1')!;

      expect(Object.keys(other).sort()).toEqual(['hasPin', 'id', 'isAdmin', 'name']);
      expect(own).toMatchObject({
        id: child.id, isActive: true, sessionCount: 0,
        recoverableSessionCount: 0, deviceCount: 0, canDelete: false,
      });
    } finally {
      composition.dispose();
    }
  });

  it('returns full profile summaries to the admin', () => {
    const { composition, controller } = setup();
    try {
      composition.createProfile('Child');

      expect(controller.listProfiles().every(profile =>
        profile.isActive !== undefined && profile.sessionCount !== undefined
          && profile.recoverableSessionCount !== undefined && profile.deviceCount !== undefined
          && profile.canDelete !== undefined,
      )).toBe(true);
    } finally {
      composition.dispose();
    }
  });

  it('blocks profile deletion while durable recycle-bin purges are pending', () => {
    const { composition, controller, profileStore } = setup();
    try {
      const profile = composition.createProfile('Child');
      const recycleBin = composition.getRequiredRuntime(profile.id).recycleBinManager;
      const entry = recycleBin.append({
        sessionId: 'closed-session', name: 'Closed', cliType: 'claude-code',
        workingDir: 'X:/project', cliSessionName: 'resume-id', closedAt: Date.now(),
      });
      recycleBin.forget(entry.id);

      const summary = controller.listProfiles().find(item => item.id === profile.id);
      expect(summary?.canDelete).toBe(false);
      expect(controller.deleteProfile(profile.id)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/pending recycle-bin cleanup/i),
      });
      expect(profileStore.list().some(item => item.id === profile.id)).toBe(true);
      expect(composition.registry.getRequiredRuntime(profile.id).recycleBinManager.pendingPurgeJobs()).toHaveLength(1);
    } finally {
      composition.dispose();
    }
  });

  it('blocks profile deletion when an expired row could not be durably queued', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { composition, controller, profileStore } = setup();
    try {
      const profile = composition.createProfile('Child');
      const runtime = composition.getRequiredRuntime(profile.id);
      const recycleBin = runtime.recycleBinManager;
      const entry = recycleBin.append({
        sessionId: 'expired-session', name: 'Expired', cliType: 'claude-code',
        workingDir: 'X:/project', cliSessionName: 'resume-id', closedAt: Date.now(),
      });
      now.mockReturnValue(entry.closedAt + RECYCLE_BIN_WINDOW_MS + 1);
      vi.spyOn(recycleBin as any, 'persist').mockImplementation(() => { throw new Error('disk failure'); });

      expect(() => recycleBin.pruneExpired()).toThrow('disk failure');
      expect(recycleBin.list()).toEqual([]);
      expect(recycleBin.pendingPurgeJobs()).toEqual([]);
      expect(recycleBin.retainedSessionIds()).toEqual(new Set([entry.sessionId]));
      expect(controller.listProfiles().find(item => item.id === profile.id)?.canDelete).toBe(false);
      expect(controller.deleteProfile(profile.id)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/recycle-bin cleanup/i),
      });
      expect(profileStore.list().some(item => item.id === profile.id)).toBe(true);
      expect(composition.registry.getRequiredRuntime(profile.id)).toBe(runtime);
    } finally {
      composition.dispose();
      now.mockRestore();
    }
  });
});

describe('Profile runtime IPC domain', () => {
  it('switches to profile 2 through the domain registered IPC handlers', async () => {
    const { profileStore, composition, runtimeView, devices } = setup();
    const profileTwo = composition.createProfile('Kids');
    const windowManager = new WindowManager();
    const makeServiceSet = () => ({ userProfileId: '1', service: { setRestartAllowed() {}, dispose() {} } }) as any;
    let domain: ReturnType<typeof setupProfileRuntimeDomain> | undefined;
    try {
      domain = setupProfileRuntimeDomain({
        profileStore,
        composition,
        runtimeView,
        devices,
        windowManager,
        incomingWatcher: { switchTo: async () => undefined } as any,
        router: new ProfileMcpRouter(composition, devices),
        baseServices: makeServiceSet(),
        createServices: () => makeServiceSet(),
      });

      const switchProfile = ipcHandlers.get('profile:switch');
      expect(switchProfile).toBeDefined();
      expect(await switchProfile!({}, profileTwo.id)).toEqual({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profileTwo.id);
      expect(runtimeView.runtime.userProfileId).toBe(profileTwo.id);
      expect((ipcHandlers.get('profile:active')!() as { id: string }).id).toBe(profileTwo.id);
    } finally {
      domain?.cleanup();
      domain?.serviceFactory.dispose();
      composition.dispose();
    }
  });
});
