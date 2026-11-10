/**
 * Recycle-bin persistence tests.
 *
 * Round-trips through the real recycle-bin file (same approach as the
 * scheduled-task-history persistence tests).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  saveRecycleBin,
  loadRecycleBin,
  loadRecycleBinState,
  RECYCLE_BIN_WINDOW_MS,
} from '../src/session/recycle-bin-persistence.js';
import type { RecycleBinEntry } from '../src/types/recycle-bin.js';
const RECYCLE_BIN_FILE = join(mkdtempSync(join(tmpdir(), 'helm-recycle-bin-test-')), 'recycle-bin.yaml');

function entry(overrides: Partial<RecycleBinEntry> = {}): RecycleBinEntry {
  return {
    id: 'id-1',
    sessionId: 'sess-1',
    name: 'claude-opus',
    cliType: 'claude-code',
    workingDir: 'X:\\coding\\test',
    cliSessionName: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    closedAt: Date.now(),
    ...overrides,
  };
}

describe('recycle-bin persistence', () => {
  afterEach(() => {
    saveRecycleBin([], RECYCLE_BIN_FILE);
  });

  it('round-trips entries through YAML', () => {
    saveRecycleBin([entry({ id: 'a', name: 'codex' })], RECYCLE_BIN_FILE);

    const loaded = loadRecycleBin(RECYCLE_BIN_FILE);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('a');
    expect(loaded[0].name).toBe('codex');
    expect(loaded[0].cliSessionName).toBe('a1b2c3d4-e5f6-7890-abcd-ef0123456789');
  });

  it('filters out entries older than the 7-day window on load', () => {
    const now = Date.now();
    saveRecycleBin([
      entry({ id: 'fresh', closedAt: now - 1000 }),
      entry({ id: 'stale', closedAt: now - RECYCLE_BIN_WINDOW_MS - 5000 }),
    ], RECYCLE_BIN_FILE);

    const ids = loadRecycleBin(RECYCLE_BIN_FILE).map(e => e.id);
    expect(ids).toContain('fresh');
    expect(ids).not.toContain('stale');
  });

  it('round-trips pending purge jobs and retains expired entries for startup pruning', () => {
    const stale = entry({ id: 'stale', closedAt: Date.now() - RECYCLE_BIN_WINDOW_MS - 5000 });
    const pending = { entry: entry({ id: 'pending' }), kind: 'forgotten' as const };
    saveRecycleBin([stale], RECYCLE_BIN_FILE, [pending]);

    const state = loadRecycleBinState(RECYCLE_BIN_FILE);

    expect(state.entries.map(value => value.id)).toEqual(['stale']);
    expect(state.pendingPurges).toEqual([pending]);
    expect(loadRecycleBin(RECYCLE_BIN_FILE)).toEqual([]);
  });

  it('drops entries missing a cliSessionName (not recoverable)', () => {
    const now = Date.now();
    saveRecycleBin([
      entry({ id: 'ok', closedAt: now }),
      { ...entry({ id: 'bad', closedAt: now }), cliSessionName: '' },
    ], RECYCLE_BIN_FILE);

    const ids = loadRecycleBin(RECYCLE_BIN_FILE).map(e => e.id);
    expect(ids).toEqual(['ok']);
  });

  it('returns [] for a missing file', () => {
    saveRecycleBin([], RECYCLE_BIN_FILE);
    expect(loadRecycleBin(RECYCLE_BIN_FILE)).toEqual([]);
  });

  it('returns [] for a corrupt file', () => {
    mkdirSync(dirname(RECYCLE_BIN_FILE), { recursive: true });
    writeFileSync(RECYCLE_BIN_FILE, ':::not yaml: [unclosed', 'utf8');
    expect(loadRecycleBin(RECYCLE_BIN_FILE)).toEqual([]);
    expect(existsSync(RECYCLE_BIN_FILE)).toBe(true);
  });
});
