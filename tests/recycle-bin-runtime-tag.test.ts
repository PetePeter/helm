/**
 * recordRemovedSession runtime-group tagging tests.
 *
 * A fake `recycleBin` (Pick<append>) captures the appended entry so we can assert
 * the runtime group id/name are threaded through when present, and that the
 * cliSessionName recoverability gate is unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionRemovedEvent } from '../src/types/session.js';
import type { RecycleBinEntry } from '../src/types/recycle-bin.js';

// recycle-bin-manager imports persistence which resolves a real config path;
// stub the persistence module so no filesystem/app-path work happens on import.
vi.mock('../src/session/recycle-bin-persistence.js', () => ({
  saveRecycleBin: vi.fn(),
  loadRecycleBin: vi.fn(() => []),
  RECYCLE_BIN_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { recordRemovedSession } from '../src/session/recycle-bin-manager.js';

function makeEvent(overrides: Partial<SessionRemovedEvent['session']> = {}): SessionRemovedEvent {
  return {
    sessionId: 'sess-1',
    timestamp: 1700000000000,
    session: {
      id: 'sess-1',
      name: 'My Session',
      cliType: 'claude-code',
      processId: 1234,
      workingDir: 'X:/work',
      cliSessionName: 'uuid-abc',
      ...overrides,
    },
  };
}

function fakeBin() {
  const appended: Array<Omit<RecycleBinEntry, 'id'>> = [];
  return {
    appended,
    append: vi.fn((entry: Omit<RecycleBinEntry, 'id'>) => {
      appended.push(entry);
      return { id: 'bin-1', ...entry } as RecycleBinEntry;
    }),
  };
}

describe('recordRemovedSession runtime-group tag', () => {
  it('R1 threads runtimeGroupId + name into the appended entry', () => {
    const bin = fakeBin();
    const bookmark = vi.fn();

    const result = recordRemovedSession(
      makeEvent(),
      bin,
      bookmark,
      { id: 'g1', name: 'Alpha' },
    );

    expect(result).not.toBeNull();
    expect(bin.appended).toHaveLength(1);
    expect(bin.appended[0].runtimeGroupId).toBe('g1');
    expect(bin.appended[0].runtimeGroupName).toBe('Alpha');
    expect(bookmark).toHaveBeenCalledWith('X:/work');
  });

  it('omits runtime tag fields when no group is supplied', () => {
    const bin = fakeBin();
    recordRemovedSession(makeEvent(), bin, vi.fn());

    expect(bin.appended[0].runtimeGroupId).toBeUndefined();
    expect(bin.appended[0].runtimeGroupName).toBeUndefined();
  });

  it('R2 no cliSessionName → no bin entry even with a runtime group', () => {
    const bin = fakeBin();

    const result = recordRemovedSession(
      makeEvent({ cliSessionName: undefined }),
      bin,
      vi.fn(),
      { id: 'g1', name: 'Alpha' },
    );

    expect(result).toBeNull();
    expect(bin.append).not.toHaveBeenCalled();
  });
});

describe('recordRemovedSession project tag', () => {
  it('P1 threads projectId + projectName into the appended entry', () => {
    const bin = fakeBin();

    recordRemovedSession(makeEvent(), bin, vi.fn(), undefined, { id: 'p-helm', name: 'Helm' });

    expect(bin.appended[0].projectId).toBe('p-helm');
    expect(bin.appended[0].projectName).toBe('Helm');
  });

  it('P2 omits project fields when no project is supplied', () => {
    const bin = fakeBin();
    recordRemovedSession(makeEvent(), bin, vi.fn());

    expect(bin.appended[0].projectId).toBeUndefined();
    expect(bin.appended[0].projectName).toBeUndefined();
  });

  it('P3 project and runtime group can both be threaded independently', () => {
    const bin = fakeBin();
    recordRemovedSession(makeEvent(), bin, vi.fn(), { id: 'g1', name: 'Alpha' }, { id: 'p1', name: 'Proj' });

    expect(bin.appended[0].runtimeGroupId).toBe('g1');
    expect(bin.appended[0].projectId).toBe('p1');
    expect(bin.appended[0].projectName).toBe('Proj');
  });
});
