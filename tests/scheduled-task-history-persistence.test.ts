/**
 * ScheduledTaskHistory persistence tests.
 *
 * Round-trips through the real history file (same approach as the scheduled-task
 * persistence tests, which use the real SCHEDULED_TASKS_FILE).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  saveScheduledTaskHistory,
  loadScheduledTaskHistory,
  HISTORY_WINDOW_MS,
} from '../src/session/scheduled-task-history-persistence.js';
import type { ScheduledTaskHistoryEntry } from '../src/types/scheduled-task.js';
const SCHEDULED_TASK_HISTORY_FILE = join(mkdtempSync(join(tmpdir(), 'helm-task-history-test-')), 'scheduled-task-history.yaml');

function entry(overrides: Partial<ScheduledTaskHistoryEntry> = {}): ScheduledTaskHistoryEntry {
  return {
    id: 'id-1',
    taskId: 'task-1',
    title: 'Report',
    initialPrompt: 'do it',
    cliType: 'claude-code',
    dirPath: 'X:\\coding\\test',
    planIds: ['p1', 'p2'],
    ranAt: Date.now(),
    outcome: 'done',
    ...overrides,
  };
}

describe('scheduled-task-history persistence', () => {
  afterEach(() => {
    saveScheduledTaskHistory([], SCHEDULED_TASK_HISTORY_FILE);
  });

  it('round-trips entries and re-hydrates endDate to a Date', () => {
    const end = new Date('2026-12-31T23:59:59.000Z');
    saveScheduledTaskHistory([
      entry({ id: 'a', endDate: end, scheduleKind: 'cron', cronExpression: '0 9 * * *' }),
    ], SCHEDULED_TASK_HISTORY_FILE);

    const loaded = loadScheduledTaskHistory(SCHEDULED_TASK_HISTORY_FILE);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('a');
    expect(loaded[0].planIds).toEqual(['p1', 'p2']);
    expect(loaded[0].endDate).toBeInstanceOf(Date);
    expect(loaded[0].endDate?.toISOString()).toBe(end.toISOString());
  });

  it('filters out entries older than the 7-day window on load', () => {
    const now = Date.now();
    saveScheduledTaskHistory([
      entry({ id: 'fresh', ranAt: now - 1000 }),
      entry({ id: 'stale', ranAt: now - HISTORY_WINDOW_MS - 5000 }),
    ], SCHEDULED_TASK_HISTORY_FILE);

    const loaded = loadScheduledTaskHistory(SCHEDULED_TASK_HISTORY_FILE);
    const ids = loaded.map(e => e.id);
    expect(ids).toContain('fresh');
    expect(ids).not.toContain('stale');
  });

  it('returns [] for a missing file', () => {
    saveScheduledTaskHistory([], SCHEDULED_TASK_HISTORY_FILE);
    expect(loadScheduledTaskHistory(SCHEDULED_TASK_HISTORY_FILE)).toEqual([]);
  });

  it('returns [] for a corrupt file', () => {
    mkdirSync(dirname(SCHEDULED_TASK_HISTORY_FILE), { recursive: true });
    writeFileSync(SCHEDULED_TASK_HISTORY_FILE, ':::not yaml: [unclosed', 'utf8');
    expect(loadScheduledTaskHistory(SCHEDULED_TASK_HISTORY_FILE)).toEqual([]);
    expect(existsSync(SCHEDULED_TASK_HISTORY_FILE)).toBe(true);
  });
});
