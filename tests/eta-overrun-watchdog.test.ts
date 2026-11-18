import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session/manager.js';
import { loadSessions, saveSessions } from '../src/session/session-persistence.js';
import { sweepEtaOverruns, type EtaOverrunDeps } from '../src/session/eta-overrun-watchdog.js';
import type { SessionInfo } from '../src/types/session.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIN = 60_000;
const T0 = 1_800_000_000_000;

function session(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, name: id, cliType: 'claude-code', processId: 1, ...extra };
}

/** A worker whose 20-minute estimate opened at T0. */
function worker(extra: Partial<SessionInfo> = {}): SessionInfo {
  return session('worker', { eta: { at: T0 + 20 * MIN, setAt: T0, startedAt: T0, firstAt: T0 + 20 * MIN }, ...extra });
}

function setup(sessions: SessionInfo[], percent = 50, settled = true) {
  const manager = new SessionManager();
  for (const s of sessions) manager.addSession(s, true);
  let now = T0;
  const stopped: string[] = [];
  const nudges: Array<{ id: string; text: string }> = [];
  const order: string[] = [];
  const deps: EtaOverrunDeps = {
    sessions: manager,
    percentFor: () => percent,
    stop: async (id) => { stopped.push(id); order.push('stop'); },
    settle: async () => { order.push('settle'); return settled; },
    nudge: async (id, text) => { nudges.push({ id, text }); order.push('nudge'); },
    now: () => now,
  };
  return {
    manager, stopped, nudges, order,
    sweepAt: async (minutes: number) => { now = T0 + minutes * MIN; await sweepEtaOverruns(deps); },
  };
}

describe('sweepEtaOverruns', () => {
  it('never fires when the CLI type has it off', async () => {
    const t = setup([worker()], 0);
    await t.sweepAt(100);
    expect(t.stopped).toEqual([]);
    expect(t.nudges).toEqual([]);
  });

  it('fires once the estimate is overrun by the threshold, not before', async () => {
    const t = setup([worker()]);
    await t.sweepAt(29.9);
    expect(t.stopped).toEqual([]);
    await t.sweepAt(30);
    expect(t.stopped).toEqual(['worker']);
    expect(t.nudges).toHaveLength(1);
    expect(t.nudges[0].text).not.toMatch(/\n/);
  });

  it('waits for the stop to settle before nudging, so the submit is not eaten mid-cancel', async () => {
    const t = setup([worker()]);
    await t.sweepAt(30);
    expect(t.order).toEqual(['stop', 'settle', 'nudge']);
  });

  it('still nudges when the session never goes quiet', async () => {
    const t = setup([worker()], 50, false);
    await t.sweepAt(30);
    expect(t.nudges).toHaveLength(1);
  });

  it('does not fire twice for the same estimate', async () => {
    const t = setup([worker()]);
    await t.sweepAt(30);
    await t.sweepAt(31);
    await t.sweepAt(45);
    expect(t.stopped).toEqual(['worker']);
  });

  it('rearms when the session sets a new estimate', async () => {
    const t = setup([worker()]);
    await t.sweepAt(30);
    // Rescope at 31m: a fresh 10-minute estimate.
    t.manager.updateSession('worker', { eta: { at: T0 + 41 * MIN, setAt: T0 + 31 * MIN, startedAt: T0 + 31 * MIN, firstAt: T0 + 41 * MIN } });
    await t.sweepAt(45);
    expect(t.stopped).toEqual(['worker']);
    await t.sweepAt(46);
    expect(t.stopped).toEqual(['worker', 'worker']);
  });

  it('points at the orchestrator first, then the creator, then the user', async () => {
    const both = setup([session('orch'), session('maker'), worker({ reportsTo: 'orch', createdBySessionId: 'maker' })]);
    await both.sweepAt(30);
    expect(both.nudges[0].text).toContain('orch');

    const creatorOnly = setup([session('maker'), worker({ createdBySessionId: 'maker' })]);
    await creatorOnly.sweepAt(30);
    expect(creatorOnly.nudges[0].text).toContain('"maker"');

    const nobody = setup([worker()]);
    await nobody.sweepAt(30);
    expect(nobody.nudges[0].text).toMatch(/the user/);
  });

  it('falls back to the user when the creator session is gone', async () => {
    const t = setup([worker({ reportsTo: 'gone-orch', createdBySessionId: 'gone-maker' })]);
    await t.sweepAt(30);
    expect(t.nudges[0].text).toMatch(/the user/);
    expect(t.nudges[0].text).not.toContain('gone-');
  });

  it('skips remote and frozen rows', async () => {
    const t = setup([worker({ remote: { peerId: 'p', sessionId: 's' } }), session('cold', { ...worker(), id: 'cold', frozen: true })]);
    await t.sweepAt(60);
    expect(t.stopped).toEqual([]);
  });

  it('a failed stop still marks the estimate and does not throw', async () => {
    const t = setup([worker()]);
    const manager = t.manager;
    const deps: EtaOverrunDeps = {
      sessions: manager,
      percentFor: () => 50,
      stop: async () => { throw new Error('pty gone'); },
      settle: async () => true,
      nudge: async () => {},
      now: () => T0 + 30 * MIN,
    };
    await expect(sweepEtaOverruns(deps)).resolves.toBeUndefined();
    expect(manager.getSession('worker')?.eta?.overrunAt).toBe(T0 + 30 * MIN);
  });
});

describe('createdBySessionId persistence', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('survives a save/load round trip, as does the overrun marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-overrun-'));
    dirs.push(dir);
    const file = join(dir, 'sessions.yaml');
    const eta = { at: T0 + 20 * MIN, setAt: T0, overrunAt: T0 + 30 * MIN };
    saveSessions([session('worker', { createdBySessionId: 'maker', eta })], file);
    const [loaded] = loadSessions(file);
    expect(loaded.createdBySessionId).toBe('maker');
    expect(loaded.eta?.overrunAt).toBe(T0 + 30 * MIN);
  });
});
