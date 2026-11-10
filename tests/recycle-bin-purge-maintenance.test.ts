import { describe, expect, it } from 'vitest';
import { RecycleBinManager } from '../src/session/recycle-bin-manager.js';
import type { ProfileRuntime } from '../src/session/profile-runtime.js';
import { RecycleBinPurgeMaintenance } from '../src/electron/recycle-bin-purge-maintenance.js';

function makeRuntime(profileId: string, purged: Array<[string, string]>): ProfileRuntime {
  return {
    userProfileId: profileId,
    recycleBinManager: new RecycleBinManager(),
    memoryManager: { purgeSession: (id: string) => { purged.push([profileId, id]); } },
    messManager: { onSessionClosed: () => undefined },
    artifactManager: { clearSession: () => undefined },
    artifactTempRegistry: { pathsFor: () => [], drain: () => undefined },
    draftManager: { clearSession: () => undefined },
    todoManager: { clearSession: () => undefined },
  } as ProfileRuntime;
}

function makeEntry(sessionId: string) {
  return {
    sessionId,
    name: 'codex',
    cliType: 'codex',
    workingDir: 'X:\\work',
    cliSessionName: `resume-${sessionId}`,
    closedAt: Date.now(),
  };
}

describe('RecycleBinPurgeMaintenance', () => {
  it('drains each concrete profile queue after first show and starts later profiles immediately', async () => {
    const scheduled: Array<() => void> = [];
    const purged: Array<[string, string]> = [];
    const maintenance = new RecycleBinPurgeMaintenance({
      scheduleImmediate: callback => { scheduled.push(callback); },
    });
    const profileOne = makeRuntime('1', purged);
    const profileTwo = makeRuntime('2', purged);
    maintenance.add(profileOne);
    maintenance.add(profileTwo);

    for (const [runtime, sessionId] of [[profileOne, 'one'], [profileTwo, 'two']] as const) {
      const entry = runtime.recycleBinManager.append(makeEntry(sessionId));
      runtime.recycleBinManager.forget(entry.id);
    }
    expect(scheduled).toHaveLength(0);

    maintenance.start();
    expect(scheduled).toHaveLength(2);
    scheduled.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    scheduled.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(purged.sort()).toEqual([['1', 'one'], ['2', 'two']]);

    const profileThree = makeRuntime('3', purged);
    maintenance.add(profileThree);
    const entry = profileThree.recycleBinManager.append(makeEntry('three'));
    profileThree.recycleBinManager.forget(entry.id);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await Promise.resolve();
    await Promise.resolve();

    expect(purged).toContainEqual(['3', 'three']);
    expect(profileOne.recycleBinManager.pendingPurgeJobs()).toEqual([]);
    expect(profileTwo.recycleBinManager.pendingPurgeJobs()).toEqual([]);
    expect(profileThree.recycleBinManager.pendingPurgeJobs()).toEqual([]);
    maintenance.dispose();
  });
});
