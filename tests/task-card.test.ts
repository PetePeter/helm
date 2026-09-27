import { describe, it, expect } from 'vitest';
import { taskCardLines } from '../renderer/plans/task-card.js';
import { formatDateTime } from '../renderer/utils/date-format.js';

describe('taskCardLines', () => {
  const now = Date.UTC(2026, 8, 27, 9, 0);

  it('names the builder, what the task waits on, and when it is next checked', () => {
    const at = now + 20 * 60_000;
    expect(taskCardLines({ builderName: 'coder', waitingOn: 'tests pass', nextCheckAt: at }, now))
      .toEqual({ builder: 'coder', waitingOn: 'tests pass', nextCheck: formatDateTime(at) });
  });

  it('falls back to the builder session id when the session is gone', () => {
    expect(taskCardLines({ builderSessionId: 's-123' }, now).builder).toBe('s-123');
  });

  it('flags a task with no live timer, and a check that is already due', () => {
    expect(taskCardLines({}, now).nextCheck).toBe('no timer');
    expect(taskCardLines({ nextCheckAt: now - 1 }, now).nextCheck).toBe('due now');
  });
});
