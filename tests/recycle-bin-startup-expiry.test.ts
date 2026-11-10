import { beforeEach, describe, expect, it, vi } from 'vitest';

let diskEntries: Array<Record<string, unknown>> = [];
let diskPurges: Array<Record<string, unknown>> = [];

vi.mock('../src/session/recycle-bin-persistence.js', () => ({
  RECYCLE_BIN_WINDOW_MS: 30 * 24 * 60 * 60 * 1000,
  loadRecycleBinState: vi.fn(() => ({ entries: [...diskEntries], pendingPurges: [...diskPurges] })),
  saveRecycleBin: vi.fn((entries: Array<Record<string, unknown>>, _file?: string, pendingPurges: Array<Record<string, unknown>> = []) => {
    diskEntries = [...entries]; diskPurges = [...pendingPurges];
  }),
}));

import { RECYCLE_BIN_WINDOW_MS, RecycleBinManager } from '../src/session/recycle-bin-manager.js';

describe('recycle-bin startup expiry', () => {
  beforeEach(() => {
    diskEntries = [];
    diskPurges = [];
  });

  it('prunes persisted expired entries through the same expiry event used at runtime', () => {
    const now = 2 * RECYCLE_BIN_WINDOW_MS;
    diskEntries = [{ id: 'bin-old', sessionId: 's-old', closedAt: 0 }];
    const manager = new RecycleBinManager(() => now);
    const expired: string[] = [];
    manager.on('recycle-bin:expired', (entries) => expired.push(...entries.map((entry) => entry.sessionId)));

    expect(manager.pruneExpired().map((entry) => entry.sessionId)).toEqual(['s-old']);
    expect(expired).toEqual(['s-old']);
    expect(manager.list()).toEqual([]);
    expect(diskEntries).toEqual([]);
    expect(diskPurges.map(job => (job as any).entry.sessionId)).toEqual(['s-old']);
  });
});
