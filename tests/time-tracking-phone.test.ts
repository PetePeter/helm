/** Which phone calls count as the user's time, and where. */
import { describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { phoneActivityTarget, setupTimeTrackingHandlers, timesheetQuery } from '../src/electron/ipc/time-tracking-handlers.js';
import type { TimeSlot } from '../src/session/time-tracker.js';

const planDir = (id: string) => (id === 'plan-1' ? 'C:/proj' : null);

describe('phoneActivityTarget', () => {
  it('credits an action on a session to that session', () => {
    expect(phoneActivityTarget('session_rename', { sessionId: 's1', name: 'x' }, planDir)).toEqual({ sessionId: 's1' });
  });

  it('leaves a phone message to the delivery path, which already credits it (no double count)', () => {
    expect(phoneActivityTarget('session_send_text', { sessionId: 's1', text: 'hi' }, planDir)).toBeNull();
  });

  it('does not credit a call that reported failure', () => {
    expect(phoneActivityTarget('session_rename', { sessionId: 's1' }, planDir, { ok: false })).toBeNull();
  });

  it('credits a plan edit to the plan\'s folder, by id or dirPath', () => {
    expect(phoneActivityTarget('plan_update', { id: 'plan-1', title: 'x' }, planDir)).toEqual({ dirPath: 'C:/proj' });
    expect(phoneActivityTarget('plan_create', { dirPath: 'C:/other', title: 'x' }, planDir)).toEqual({ dirPath: 'C:/other' });
  });

  it('does not count looking around', () => {
    for (const method of ['session_read_terminal', 'plan_get', 'plan_list', 'session_info', 'memory_search', 'session_artifact_download']) {
      expect(phoneActivityTarget(method, { sessionId: 's1', id: 'plan-1' }, planDir)).toBeNull();
    }
  });

  it('ignores calls with no place to credit', () => {
    expect(phoneActivityTarget('plan_update', { id: 'unknown' }, planDir)).toBeNull();
    expect(phoneActivityTarget('session_rename', null, planDir)).toBeNull();
  });
});

describe('timesheetQuery (the phone Time tab)', () => {
  const day = new Date(2026, 8, 28, 9).getTime();
  const slots: TimeSlot[] = [
    { start: day, kind: 'user', projectKey: 'pA', projectName: 'Alpha', dir: 'C:/a' },
    { start: day, kind: 'ai', projectKey: 'pA', projectName: 'Alpha', dir: 'C:/a' },
  ];
  const tracker = { query: (from: number, to: number) => slots.filter(s => s.start >= from && s.start < to) };

  it('lists project totals for the period when no project is named', () => {
    expect(timesheetQuery(tracker, { period: 'day', anchor: day })).toEqual({
      projects: [{ projectKey: 'pA', projectName: 'Alpha', user: 5, ai: 5 }],
    });
  });

  it("returns one project's folder grid when named", () => {
    const result = timesheetQuery(tracker, { projectKey: 'pA', period: 'hour', anchor: day }) as { sheet: { rows: unknown[]; columns: number[] } };
    expect(result.sheet.columns).toHaveLength(24);
    expect(result.sheet.rows).toEqual([{ dir: 'C:/a', user: expect.any(Array), ai: expect.any(Array) }]);
  });

  it('registers the shared desktop query for the same overview and project detail', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const cleanup = setupTimeTrackingHandlers(tracker as any, () => ({ projectKey: 'pA', projectName: 'Alpha', dir: 'C:/a' }));
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'time:query')?.[1] as
      (event: unknown, params: unknown) => unknown;

    expect(handler).toBeTypeOf('function');
    expect(handler({}, { period: 'day', anchor: day })).toEqual({
      projects: [{ projectKey: 'pA', projectName: 'Alpha', user: 5, ai: 5 }],
    });
    expect(handler({}, { projectKey: 'pA', period: 'hour', anchor: day })).toMatchObject({
      sheet: { rows: [{ dir: 'C:/a' }], columns: expect.any(Array) },
    });
    cleanup();
  });

  it('rejects a malformed ask', () => {
    expect(() => timesheetQuery(tracker, { period: 'year', anchor: day })).toThrow(/period/);
    expect(() => timesheetQuery(tracker, null)).toThrow();
  });
});
