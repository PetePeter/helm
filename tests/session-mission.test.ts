/**
 * Session mission statement — the TL;DR pinned above a session's terminal.
 *
 * Real SessionManager, real session-persistence (round-tripped through a unique
 * temp file so the shared vitest APPDATA is never touched) and the real
 * recycle-bin capture helper. The manager's own disk sink is replaced by an
 * in-memory fake for the same isolation reason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo, SessionUpdatedEvent } from '../src/types/session.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let persisted: SessionInfo[] = [];
vi.mock('../src/session/persistence.js', () => ({
  saveSessions: (sessions: SessionInfo[]) => { persisted = sessions.map(s => ({ ...s })); },
  loadSessions: () => persisted.map(s => ({ ...s })),
}));

vi.mock('../src/session/recycle-bin-persistence.js', () => ({
  RECYCLE_BIN_WINDOW_MS: 30 * 24 * 60 * 60 * 1000,
  saveRecycleBin: () => {},
  loadRecycleBin: () => [],
}));

const { SessionManager } = await import('../src/session/manager.js');
const { saveSessions, loadSessions } = await import('../src/session/session-persistence.js');
const { RecycleBinManager, recordRemovedSession } = await import('../src/session/recycle-bin-manager.js');
const { MISSION_MAX_CHARS } = await import('../src/session/mission.js');

function makeSession(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-1',
    name: 'worker',
    cliType: 'claude-code',
    processId: 1,
    workingDir: 'X:/work',
    cliSessionName: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    ...patch,
  };
}

describe('SessionManager.setMission', () => {
  let manager: InstanceType<typeof SessionManager>;

  beforeEach(() => {
    persisted = [];
    manager = new SessionManager();
    manager.addSession(makeSession());
  });

  it('stores trimmed text, setBy and setAt, persists, and emits session:updated', () => {
    const events: SessionUpdatedEvent[] = [];
    manager.on('session:updated', (e: SessionUpdatedEvent) => events.push(e));
    const before = Date.now();

    manager.setMission('sess-1', '  ship the mission bar  ', 'ai');

    const mission = manager.getSession('sess-1')!.mission!;
    expect(mission.text).toBe('ship the mission bar');
    expect(mission.setBy).toBe('ai');
    expect(mission.setAt).toBeGreaterThanOrEqual(before);
    expect(events).toHaveLength(1);
    expect(events[0].mission?.text).toBe('ship the mission bar');
    expect(persisted[0].mission?.text).toBe('ship the mission bar');
  });

  it('clears the mission on an empty or whitespace-only string', () => {
    manager.setMission('sess-1', 'something', 'user');
    const events: SessionUpdatedEvent[] = [];
    manager.on('session:updated', (e: SessionUpdatedEvent) => events.push(e));

    manager.setMission('sess-1', '   ', 'user');

    expect(manager.getSession('sess-1')!.mission).toBeUndefined();
    // The renderer spread-merges updates, so the key must be present to clear.
    expect(events).toHaveLength(1);
    expect('mission' in events[0]).toBe(true);
    expect(events[0].mission).toBeUndefined();
  });

  it('accepts exactly the limit', () => {
    manager.setMission('sess-1', 'x'.repeat(MISSION_MAX_CHARS), 'user');
    expect(manager.getSession('sess-1')!.mission!.text).toHaveLength(500);
  });

  it('rejects text over 500 characters and leaves the existing mission unchanged', () => {
    manager.setMission('sess-1', 'keep me', 'user');
    const kept = { ...manager.getSession('sess-1')!.mission! };

    expect(() => manager.setMission('sess-1', 'x'.repeat(501), 'ai')).toThrow(/500/);
    expect(manager.getSession('sess-1')!.mission).toEqual(kept);
  });

  it('throws for an unknown session', () => {
    expect(() => manager.setMission('nope', 'x', 'user')).toThrow(/does not exist/);
  });

  it('stores a rounded, clamped bar height', () => {
    manager.setMissionBarHeight('sess-1', 90.6);
    expect(manager.getSession('sess-1')!.missionBarHeight).toBe(91);
    manager.setMissionBarHeight('sess-1', 5);
    expect(manager.getSession('sess-1')!.missionBarHeight).toBe(28);
    manager.setMissionBarHeight('sess-1', 5000);
    expect(manager.getSession('sess-1')!.missionBarHeight).toBe(240);
    expect(() => manager.setMissionBarHeight('sess-1', Number.NaN)).toThrow();
  });
});

describe('mission persistence', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'helm-mission-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('mission and missionBarHeight survive serialize → load', () => {
    const file = join(dir, 'sessions.yaml');
    const mission = { text: 'refactor the dock', setBy: 'user' as const, setAt: 1700000000000 };
    saveSessions([makeSession({ mission, missionBarHeight: 64 })], file);

    const [loaded] = loadSessions(file);
    expect(loaded.mission).toEqual(mission);
    expect(loaded.missionBarHeight).toBe(64);
  });

  it('drops a malformed mission record on load', () => {
    const file = join(dir, 'sessions.yaml');
    saveSessions([makeSession({ mission: { text: 42 } as never, missionBarHeight: 'tall' as never })], file);
    const [loaded] = loadSessions(file);
    expect(loaded.mission).toBeUndefined();
    expect(loaded.missionBarHeight).toBeUndefined();
  });

  it('a recycle-bin close → restore carries the mission and bar height back', () => {
    persisted = [];
    const manager = new SessionManager();
    const bin = new RecycleBinManager();
    manager.on('session:removed', (event) => recordRemovedSession(event, bin, () => {}));
    manager.addSession(makeSession());
    manager.setMission('sess-1', 'port the planner', 'ai');
    manager.setMissionBarHeight('sess-1', 80);
    const original = { ...manager.getSession('sess-1')!.mission! };

    manager.removeSession('sess-1');
    const entry = bin.list()[0];
    expect(entry.mission).toEqual(original);
    expect(entry.missionBarHeight).toBe(80);

    // Restore re-spawns under the original id, then re-applies the bin's fields.
    manager.addSession(makeSession());
    manager.restoreMission(entry.sessionId, entry.mission, entry.missionBarHeight);
    expect(manager.getSession('sess-1')!.mission).toEqual(original);
    expect(manager.getSession('sess-1')!.missionBarHeight).toBe(80);
  });
});
