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
import { getProfileConfigDir } from '../src/utils/app-paths.js';

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) => { ipcHandlers.set(channel, handler); },
    removeHandler: (channel: string) => { ipcHandlers.delete(channel); },
  },
}));

const roots: string[] = [];

function setup(onProfileChanged?: (id: string) => void | Promise<void>) {
  const appData = mkdtempSync(join(tmpdir(), 'helm-profile-ipc-'));
  roots.push(appData);
  const globalConfigDir = join(appData, 'Helm', 'config');
  const profileOneDir = getProfileConfigDir('1', appData);
  mkdirSync(globalConfigDir, { recursive: true });
  mkdirSync(profileOneDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'settings.yaml'), '{}\n');
  const configLoader = new ConfigLoader({ userProfileId: '1', profileConfigDir: profileOneDir, globalConfigDir });
  const profileStore = new UserProfileStore(globalConfigDir);
  const composition = new ProfileRuntimeComposition({ configLoader, userProfileStore: profileStore, ptyManager: new PtyManager() });
  const runtimeView = new ActiveProfileRuntimeView(composition.getRequiredRuntime(profileStore.getActiveProfileId()));
  const devices = new MobileDeviceStore();
  const controller = new ProfileIpcController({ profileStore, composition, runtimeView, devices, windowManager: new WindowManager(), onProfileChanged });
  return { appData, profileStore, composition, runtimeView, devices, controller };
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
});

describe('Profile runtime IPC domain', () => {
  it('switches to profile 2 through the domain registered IPC handlers', async () => {
    const { profileStore, composition, runtimeView, devices } = setup();
    const profileTwo = composition.createProfile('Kids');
    const windowManager = new WindowManager();
    const makeServiceSet = () => ({ service: { setRestartAllowed() {}, dispose() {} } }) as any;
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
