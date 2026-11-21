import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQuotaHistoryStore } from '../../src/session/quota-history-persistence.js';
import { SessionQuotaUsageTracker } from '../../src/session/session-quota-usage-tracker.js';
import { QUOTA_HISTORY_BUCKET_MS } from '../../src/session/quota-burn.js';

vi.mock('../../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const HOUR = 60 * 60_000;

function manager() {
  const sessions = new Map<string, any>([['s1', { id: 's1', cliType: 'claude-code' }]]);
  return Object.assign(new EventEmitter(), {
    getSession: (id: string) => sessions.get(id) ?? null,
    getAllSessions: () => [...sessions.values()],
    updateSession: (id: string, updates: object) => { Object.assign(sessions.get(id), updates); },
    sessions,
  });
}

function tracker(file: string, now: () => number) {
  const sm = manager();
  const t = new SessionQuotaUsageTracker({ sessionManager: sm, scopeFor: () => 'scope', now, historyStore: createQuotaHistoryStore(file) });
  return { t, sm };
}

const snap = (at: number, used: number) => ({
  fiveHour: { usedPercent: used, resetsAtEpochMs: at + 4 * HOUR },
  weekly: { usedPercent: 10, resetsAtEpochMs: at + 72 * HOUR },
  measuredAtEpochMs: at,
});

describe('quota history persistence', () => {
  it('keeps the burn history across a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-history-'));
    const file = path.join(dir, 'quota-history.json');
    try {
      let clock = 1_800_000_000_000;
      const first = tracker(file, () => clock);
      first.t.report('s1', snap(clock, 20));
      clock += QUOTA_HISTORY_BUCKET_MS;
      first.t.report('s1', snap(clock, 25));

      clock += 60_000;
      const second = tracker(file, () => clock);
      second.t.report('s1', snap(clock, 26));
      expect(second.sm.sessions.get('s1').quotaUsage.history.map((p: { fiveHour: number }) => p.fiveHour)).toEqual([20, 25]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops history older than the graph span and ignores a corrupt file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-history-'));
    const file = path.join(dir, 'quota-history.json');
    try {
      const now = 1_800_000_000_000;
      fs.writeFileSync(file, JSON.stringify({ scope: [{ at: now - 6 * HOUR, fiveHour: 1, weekly: 1 }, { at: 'x' }] }));
      const t = tracker(file, () => now);
      t.t.report('s1', snap(now, 5));
      expect(t.sm.sessions.get('s1').quotaUsage.history).toHaveLength(1);
      fs.writeFileSync(file, '{not json');
      expect(createQuotaHistoryStore(file).load().size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
