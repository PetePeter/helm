import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { ConfigLoader } from '../src/config/loader.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';
import { ActiveProfileRuntimeView, createActiveServiceProxy } from '../src/electron/active-profile-runtime.js';
import { setupPlanHandlers } from '../src/electron/ipc/plan-handlers.js';
import { ProfileRuntimeComposition } from '../src/electron/profile-runtime-composition.js';
import { PtyManager } from '../src/session/pty-manager.js';
import { SuggestedPlanService } from '../src/session/suggested-plan-service.js';
import { getProfileConfigDir } from '../src/utils/app-paths.js';

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, Function>() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => ipcState.handlers.set(channel, handler)),
  },
  BrowserWindow: Object.assign(function BrowserWindow() {}, { getAllWindows: () => [] }),
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

const temporaryRoots: string[] = [];
const compositions: ProfileRuntimeComposition[] = [];

afterEach(() => {
  ipcState.handlers.clear();
  for (const composition of compositions.splice(0)) composition.dispose();
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createHarness(initialActiveProfileId: '1' | '2') {
  const appData = mkdtempSync(join(tmpdir(), 'helm-suggested-plan-ipc-'));
  temporaryRoots.push(appData);
  const globalConfigDir = join(appData, 'Helm', 'config');
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'settings.yaml'), '{}\n');

  const profiles = new UserProfileStore(globalConfigDir);
  profiles.ensureDefaultProfile();
  writeFileSync(profiles.filePath, YAML.stringify({
    version: 1,
    activeProfileId: initialActiveProfileId,
    profiles: [
      { id: '1', name: 'One', pinHash: null },
      { id: '2', name: 'Two', pinHash: null },
    ],
  }));

  for (const id of ['1', '2']) {
    const configDir = getProfileConfigDir(id, appData);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'cli-types.yaml'), 'test:\n  name: Test\n  displayName: Test\n');
  }

  const configLoader = new ConfigLoader({
    userProfileId: '1',
    profileConfigDir: getProfileConfigDir('1', appData),
    globalConfigDir,
  });
  const composition = new ProfileRuntimeComposition({
    configLoader,
    userProfileStore: profiles,
    ptyManager: new PtyManager(),
  });
  compositions.push(composition);

  const runtimeOne = composition.registry.getRequiredRuntime('1');
  const runtimeTwo = composition.registry.getRequiredRuntime('2');
  const runtimeView = new ActiveProfileRuntimeView(
    composition.registry.getRequiredRuntime(profiles.getActiveProfileId()),
  );
  const suggestionServices = new Map([
    ['1', new SuggestedPlanService(runtimeOne.planManager, runtimeOne.memoryManager)],
    ['2', new SuggestedPlanService(runtimeTwo.planManager, runtimeTwo.memoryManager)],
  ]);
  let factoryReady = false;
  const profileOneControl = {
    getSuggestedPlanService: () => suggestionServices.get('1')!,
  };
  const activeControl = createActiveServiceProxy(() => factoryReady
    ? { getSuggestedPlanService: () => suggestionServices.get(profiles.getActiveProfileId())! }
    : profileOneControl);

  return {
    appData,
    profiles,
    composition,
    runtimeOne,
    runtimeTwo,
    runtimeView,
    activeControl,
    setFactoryReady: () => { factoryReady = true; },
    switchToTwo: () => {
      profiles.setActiveProfileId('2');
      runtimeView.select(runtimeTwo);
    },
  };
}

function suggested(runtime: ReturnType<typeof createHarness>['runtimeOne'], appData: string, title: string) {
  return runtime.planManager.createSuggested(join(appData, title.replaceAll(' ', '-')), title, 'Review this proposal.');
}

function registerUsingCurrentSuggestedService(harness: ReturnType<typeof createHarness>): void {
  setupPlanHandlers(
    harness.runtimeView.runtime.planManager,
    harness.runtimeView.runtime.contextManager,
    undefined,
    undefined,
    undefined,
    () => harness.activeControl.getSuggestedPlanService() ?? undefined,
    harness.runtimeView.runtime.planAttachmentManager,
  );
}

describe('suggested plan desktop IPC follows the active profile', () => {
  it('resolves accept, reject, and suggested deletion after switching from profile 1 to profile 2', async () => {
    const harness = createHarness('1');
    const profileOneSuggestion = suggested(harness.runtimeOne, harness.appData, 'Profile one proposal');
    const accepted = suggested(harness.runtimeTwo, harness.appData, 'Profile two accepted proposal');
    const rejected = suggested(harness.runtimeTwo, harness.appData, 'Profile two rejected proposal');
    const deleted = suggested(harness.runtimeTwo, harness.appData, 'Profile two deleted proposal');

    registerUsingCurrentSuggestedService(harness);
    harness.setFactoryReady();
    harness.switchToTwo();

    expect(ipcState.handlers.get('plan:acceptSuggestion')!({}, accepted.id)).toEqual({ ok: true });
    expect(ipcState.handlers.get('plan:rejectSuggestion')!({}, rejected.id)).toEqual({ ok: true, deleted: true });
    expect(ipcState.handlers.get('plan:delete')!({}, deleted.id)).toBe(true);

    expect(harness.runtimeTwo.planManager.getItem(accepted.id)?.status).toBe('ready');
    expect(harness.runtimeTwo.planManager.getItem(rejected.id)).toBeNull();
    expect(harness.runtimeTwo.planManager.getItem(deleted.id)).toBeNull();
    expect(harness.runtimeOne.planManager.getItem(profileOneSuggestion.id)?.status).toBe('suggested');
  });

  it('uses profile 2 on startup when that selection is persisted before handler registration', async () => {
    const harness = createHarness('2');
    const accepted = suggested(harness.runtimeTwo, harness.appData, 'Startup accepted proposal');
    const rejected = suggested(harness.runtimeTwo, harness.appData, 'Startup rejected proposal');

    expect(harness.profiles.getActiveProfileId()).toBe('2');
    registerUsingCurrentSuggestedService(harness);
    harness.setFactoryReady();

    expect(ipcState.handlers.get('plan:acceptSuggestion')!({}, accepted.id)).toEqual({ ok: true });
    expect(ipcState.handlers.get('plan:rejectSuggestion')!({}, rejected.id)).toEqual({ ok: true, deleted: true });

    expect(harness.runtimeTwo.planManager.getItem(accepted.id)?.status).toBe('ready');
    expect(harness.runtimeTwo.planManager.getItem(rejected.id)).toBeNull();
  });
});
