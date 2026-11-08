import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';
import {
  createProfileOneHandoverDelivery,
  createProfileOneOperatorTaskWatcher,
  createProfileOnePromptDelivery,
  sendDesktopChatToSessionOwner,
} from '../src/electron/ipc/profile-runtime-routing.js';
import { ActiveProfileRuntimeView } from '../src/electron/active-profile-runtime.js';
import { ProfileRuntimeComposition } from '../src/electron/profile-runtime-composition.js';
import type { ProfileRuntime } from '../src/session/profile-runtime.js';
import { ProfileIpcController } from '../src/electron/ipc/profile-handlers.js';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { PtyManager } from '../src/session/pty-manager.js';
import { getProfileConfigDir } from '../src/utils/app-paths.js';
import { WindowManager } from '../src/electron/window-manager.js';

const roots: string[] = [];

function setup() {
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
  const runtimeView = new ActiveProfileRuntimeView(composition.getRequiredRuntime('1'));
  const controller = new ProfileIpcController({
    profileStore,
    composition,
    runtimeView,
    devices: new MobileDeviceStore(),
    windowManager: new WindowManager(),
  });
  const profileTwo = composition.createProfile('Kids');
  return { composition, profileStore, controller, profileTwo };
}

function addSession(runtime: ProfileRuntime, id: string): void {
  runtime.sessionManager.addSession({
    id,
    name: id,
    cliType: 'test',
    processId: 1,
    workingDir: 'X:\\project',
  });
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

describe('profile runtime routing with profile 2 active', () => {
  it('delivers voice prompts to the profile 1 operator', async () => {
    const { composition, profileStore, controller, profileTwo } = setup();
    try {
      addSession(composition.getRequiredRuntime('1'), 'operator-1');
      addSession(composition.getRequiredRuntime(profileTwo.id), 'child-session');
      expect(await controller.switchProfile(profileTwo.id)).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profileTwo.id);
      const { ptyManager, writes } = recordingPty();

      await createProfileOnePromptDelivery(composition.getRequiredRuntime('1'), ptyManager)('operator-1', 'voice prompt');

      expect(writes.some(write => write.sessionId === 'operator-1' && write.text.includes('voice prompt'))).toBe(true);
    } finally {
      composition.dispose();
    }
  });

  it('delivers a profile 1 handover with profile 1 session and CLI configuration', async () => {
    const { composition, profileStore, controller, profileTwo } = setup();
    try {
      addSession(composition.getRequiredRuntime('1'), 'parent-session');
      addSession(composition.getRequiredRuntime(profileTwo.id), 'child-session');
      expect(await controller.switchProfile(profileTwo.id)).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profileTwo.id);
      const { ptyManager, writes } = recordingPty();

      const handover = createProfileOneHandoverDelivery(
        composition.getRequiredRuntime('1'),
        ptyManager,
        { notifyLlmDirected() {} } as any,
        { floorMs: 0, silenceMs: 0 },
        0,
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

  it('keeps the operator task watcher on profile 1 while profile 2 is active', async () => {
    const { composition, profileStore, controller, profileTwo } = setup();
    try {
      const profileOneRuntime = composition.getRequiredRuntime('1');
      const profileOneSessionManager = profileOneRuntime.sessionManager;
      profileOneSessionManager.addSession({
        id: 'builder-1',
        name: 'Builder',
        cliType: 'test',
        processId: 1,
        workingDir: 'X:\\project',
        activityLevel: 'active',
      });
      const timer = {
        id: 'check-1',
        status: 'pending',
        mode: 'direct',
        planIds: ['plan-1'],
        enabled: true,
        scheduleKind: 'interval',
      } as any;
      const plan = { status: 'doing', task: { builderSessionId: 'builder-1', checks: 'on' } };
      const runs: string[] = [];
      profileOneRuntime.scheduledTaskManager.listTasks = () => [timer];
      profileOneRuntime.scheduledTaskManager.runTaskNow = async id => { runs.push(id); return true; };
      profileOneRuntime.planManager.getItem = id => id === 'plan-1' ? plan as any : null;

      addSession(composition.getRequiredRuntime(profileTwo.id), 'child-session');
      expect(await controller.switchProfile(profileTwo.id)).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profileTwo.id);
      createProfileOneOperatorTaskWatcher(profileOneRuntime).start();

      profileOneSessionManager.updateSession('builder-1', { activityLevel: 'idle' });

      expect(runs).toEqual(['check-1']);
    } finally {
      composition.dispose();
    }
  });

  it('sends desktop chat through the session owner profile service', async () => {
    const { composition, profileStore, controller, profileTwo } = setup();
    try {
      addSession(composition.getRequiredRuntime('1'), 'parent-session');
      addSession(composition.getRequiredRuntime(profileTwo.id), 'child-session');
      expect(await controller.switchProfile(profileTwo.id)).toMatchObject({ ok: true });
      expect(profileStore.getActiveProfileId()).toBe(profileTwo.id);
      const messages: Array<{ profileId: string; sessionId: string; text: string }> = [];

      await sendDesktopChatToSessionOwner({
        registry: composition.registry,
        serviceForProfile: profileId => ({
          sendDesktopChatTextToSession: async (sessionId: string, text: string) => {
            messages.push({ profileId, sessionId, text });
          },
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
