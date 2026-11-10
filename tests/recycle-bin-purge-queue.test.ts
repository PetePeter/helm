import { describe, expect, it, vi } from 'vitest';
import type { RecycleBinEntry, RecycleBinPurgeJob } from '../src/types/recycle-bin.js';
import { RecycleBinPurgeQueue } from '../src/session/recycle-bin-purge-queue.js';

const makeJob = (id: string): RecycleBinPurgeJob => ({
  kind: 'forgotten',
  entry: {
    id,
    sessionId: `session-${id}`,
    name: 'codex',
    cliType: 'codex',
    workingDir: 'X:\\work',
    cliSessionName: `uuid-${id}`,
    closedAt: Date.now(),
  } satisfies RecycleBinEntry,
});

describe('RecycleBinPurgeQueue', () => {
  it('does no work before start and processes one session per scheduled turn', async () => {
    const jobs = [makeJob('a'), makeJob('b')];
    const ticks: Array<() => void> = [];
    const purged: string[] = [];
    const store = {
      pendingPurgeJobs: (skip = new Set<string>()) => jobs.filter(job => !skip.has(job.entry.id)),
      completePurge: (id: string) => { jobs.splice(jobs.findIndex(job => job.entry.id === id), 1); },
    };
    const queue = new RecycleBinPurgeQueue(
      store,
      job => { purged.push(job.entry.id); },
      callback => { ticks.push(callback); },
    );

    queue.wake();
    expect(ticks).toHaveLength(0);
    queue.start();
    expect(ticks).toHaveLength(1);

    ticks.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(purged).toEqual(['a']);
    expect(ticks).toHaveLength(1);

    ticks.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(purged).toEqual(['a', 'b']);
    expect(jobs).toHaveLength(0);
  });

  it('retains failures and skips them until a new queue starts', async () => {
    const jobs = [makeJob('bad')];
    const ticks: Array<() => void> = [];
    const store = {
      pendingPurgeJobs: (skip = new Set<string>()) => jobs.filter(job => !skip.has(job.entry.id)),
      completePurge: (id: string) => { jobs.splice(jobs.findIndex(job => job.entry.id === id), 1); },
    };
    const purge = vi.fn(() => { throw new Error('disk unavailable'); });
    const firstRun = new RecycleBinPurgeQueue(store, purge, callback => { ticks.push(callback); });
    firstRun.start();
    ticks.shift()!();
    await Promise.resolve();
    await Promise.resolve();

    expect(purge).toHaveBeenCalledTimes(1);
    expect(jobs.map(job => job.entry.id)).toEqual(['bad']);
    expect(ticks).toHaveLength(0);

    const nextRun = new RecycleBinPurgeQueue(store, purge, callback => { ticks.push(callback); });
    nextRun.start();
    ticks.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(purge).toHaveBeenCalledTimes(2);
    expect(jobs.map(job => job.entry.id)).toEqual(['bad']);
  });
});
