import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';
import { ProfileRuntimeComposition } from '../src/electron/profile-runtime-composition.js';
import { getProfileConfigDir } from '../src/utils/app-paths.js';
import { getProfilePersistencePaths } from '../src/session/persistence-paths.js';
import { saveScheduledTasks } from '../src/session/scheduled-task-persistence.js';
import { PtyManager } from '../src/session/pty-manager.js';
import type { ScheduledTask } from '../src/types/scheduled-task.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'helm-profile-composition-'));
  roots.push(value);
  return value;
}

function write(configDir: string, relativePath: string, contents: string): void {
  const fullPath = join(configDir, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, contents);
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('ProfileRuntimeComposition', () => {
  it('creates and registers a new profile runtime after startup without restarting', () => {
    const appData = root();
    const globalConfigDir = join(appData, 'Helm', 'config');
    const profileOneDir = getProfileConfigDir('1', appData);
    write(globalConfigDir, 'settings.yaml', '{}\n');
    write(profileOneDir, 'cli-types.yaml', 'test:\n  name: Test\n  displayName: Test\n');
    const profiles = new UserProfileStore(globalConfigDir);
    const configLoader = new ConfigLoader({ userProfileId: '1', profileConfigDir: profileOneDir, globalConfigDir });
    const composition = new ProfileRuntimeComposition({ configLoader, userProfileStore: profiles, ptyManager: new PtyManager() });

    try {
      const profile = composition.createProfile('Three');
      const runtime = composition.getRequiredRuntime(profile.id);

      expect(runtime.userProfileId).toBe(profile.id);
      expect(runtime.configDir).toBe(getProfileConfigDir(profile.id, appData));
      expect(composition.suggestionUsageByProfile.has(profile.id)).toBe(true);
      expect(composition.subagentIngestors.has(profile.id)).toBe(true);
      expect(profiles.list().some(item => item.id === profile.id)).toBe(true);
    } finally {
      composition.dispose();
    }
  });

  it('starts every profile scheduler, routes quick compact by owner, and loads shared config once', async () => {
    vi.useFakeTimers();
    const appData = root();
    const globalConfigDir = join(appData, 'Helm', 'config');
    const profileOneDir = getProfileConfigDir('1', appData);
    const profileTwoDir = getProfileConfigDir('2', appData);
    write(globalConfigDir, 'settings.yaml', '{}\n');
    write(profileOneDir, 'cli-types.yaml', 'test:\n  name: Test\n  displayName: Test\n');
    write(profileTwoDir, 'cli-types.yaml', 'test:\n  name: Test\n  displayName: Test\n');
    write(profileOneDir, 'profiles/default.yaml', YAML.stringify({ bindings: {
      test: { A: { action: 'keyboard', sequence: '{Ctrl+One}' } },
    } }));
    write(profileTwoDir, 'profiles/default.yaml', YAML.stringify({ bindings: {
      test: { B: { action: 'keyboard', sequence: '{Ctrl+Two}' } },
    } }));

    const profiles = new UserProfileStore(globalConfigDir);
    writeFileSync(profiles.filePath, YAML.stringify({ version: 1, profiles: [
      { id: '2', name: 'Two', pinHash: null },
      { id: '1', name: 'One', pinHash: null },
    ] }));
    const configLoader = new ConfigLoader({
      userProfileId: '1', profileConfigDir: profileOneDir, globalConfigDir,
    });
    const shared = (configLoader as unknown as { sharedConfigState: {
      settingsManager: { load: () => unknown };
      bindingStore: { load: () => unknown; filePath: string };
      inputConfigStore: { load: () => unknown };
    } }).sharedConfigState;
    const settingsLoad = vi.spyOn(shared.settingsManager, 'load');
    const bindingsLoad = vi.spyOn(shared.bindingStore, 'load');
    const inputLoad = vi.spyOn(shared.inputConfigStore, 'load');
    const scheduledTime = new Date(Date.now() + 60_000);
    const task: ScheduledTask = {
      id: 'profile-two-task', title: 'Profile two task', planIds: [], initialPrompt: 'run',
      cliType: 'test', scheduledTime, nextRunAt: scheduledTime,
      dirPath: 'X:\\profile-two', scheduleKind: 'once', mode: 'direct', targetSessionId: 'session-two',
      onFrozen: 'quickCompact', status: 'pending', createdAt: Date.now(),
    };
    saveScheduledTasks([task], getProfilePersistencePaths(profileTwoDir).scheduledTasksFile);

    const ptyManager = new PtyManager();
    ptyManager.has = () => true;
    const composition = new ProfileRuntimeComposition({
      configLoader, userProfileStore: profiles, ptyManager,
    });
    try {
      const runtimeOne = composition.registry.getRequiredRuntime('1');
      const runtimeTwo = composition.registry.getRequiredRuntime('2');
      runtimeTwo.sessionManager.addSession({
        id: 'session-two', name: 'Two', cliType: 'test', processId: 2,
        workingDir: 'X:\\two', frozen: true,
      });
      const quickCompacts: string[] = [];
      composition.bindQuickCompactHandler('1', async id => { quickCompacts.push(`1:${id}`); });
      composition.bindQuickCompactHandler('2', async id => { quickCompacts.push(`2:${id}`); });

      composition.startScheduledTasks();

      expect(runtimeTwo.scheduledTaskManager.getTask(task.id)).toMatchObject({ id: task.id, status: 'pending' });
      expect(settingsLoad).toHaveBeenCalledTimes(1);
      expect(bindingsLoad).toHaveBeenCalledTimes(1);
      expect(inputLoad).toHaveBeenCalledTimes(1);
      expect(existsSync(join(profileTwoDir, 'profiles', 'default.yaml.migrated'))).toBe(true);
      const globalBindings = readFileSync(shared.bindingStore.filePath, 'utf8');
      expect(globalBindings).toContain('{Ctrl+One}');
      expect(globalBindings).not.toContain('{Ctrl+Two}');
      expect(runtimeOne.scheduledTaskManager.listTasks()).toEqual([]);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(quickCompacts).toEqual(['2:session-two']);
      expect(runtimeTwo.scheduledTaskManager.getTask(task.id)?.status).toBe('completed');
    } finally {
      composition.dispose();
    }
  });
});
