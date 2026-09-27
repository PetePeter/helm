import { describe, it, expect } from 'vitest';
import { nextCheckAt, openTaskLines, parsePlanTask } from '../src/session/operator-tasks.js';
import type { ScheduledTask } from '../src/types/scheduled-task.js';

function timer(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 't', title: 'check', planIds: [], initialPrompt: 'check task', cliType: 'claude-code',
    scheduledTime: new Date(1000), dirPath: 'C:/op', status: 'pending', createdAt: 0,
    ...overrides,
  };
}

describe('nextCheckAt', () => {
  it('is the earliest upcoming run of a pending timer linked to the plan', () => {
    const timers = [
      timer({ id: 'a', planIds: ['p1'], nextRunAt: new Date(5000) }),
      timer({ id: 'b', planIds: ['p1'], scheduledTime: new Date(3000) }),
      timer({ id: 'c', planIds: ['p2'], nextRunAt: new Date(100) }),
    ];
    expect(nextCheckAt('p1', timers)).toBe(3000);
  });

  it('ignores cancelled, finished and disabled timers', () => {
    const timers = [
      timer({ planIds: ['p1'], status: 'cancelled' }),
      timer({ planIds: ['p1'], status: 'completed' }),
      timer({ planIds: ['p1'], enabled: false }),
    ];
    expect(nextCheckAt('p1', timers)).toBeUndefined();
  });
});

describe('parsePlanTask', () => {
  it('trims the known fields and keeps "" as a field-removal marker', () => {
    expect(parsePlanTask({ builderSessionId: ' s-1 ', watchPlanId: '' }))
      .toEqual({ builderSessionId: 's-1', watchPlanId: '' });
  });

  it('rejects a misspelt field or a non-string value instead of dropping it', () => {
    expect(() => parsePlanTask({ waitngOn: 'x' })).toThrow(/waitngOn is not a task field/);
    expect(() => parsePlanTask({ waitingOn: 5 })).toThrow(/must be a string/);
  });

  it('null clears the block; anything not an object is rejected', () => {
    expect(parsePlanTask(null)).toBeNull();
    expect(() => parsePlanTask('build G')).toThrow(/task must be an object/);
  });
});

describe('openTaskLines', () => {
  it('lists only open plans that carry a task block, with what each waits on', () => {
    const base = { dirPath: 'C:/op', description: '', createdAt: 0, updatedAt: 0 };
    const lines = openTaskLines([
      { ...base, id: '1', humanId: 'P-0901', title: 'build G', status: 'coding', task: { waitingOn: 'coder finishes' } },
      { ...base, id: '2', humanId: 'P-0902', title: 'check EF', status: 'ready', task: {} },
      { ...base, id: '3', humanId: 'P-0903', title: 'old', status: 'done', task: {} },
      { ...base, id: '4', humanId: 'P-0904', title: 'not a task', status: 'ready' },
    ]);
    expect(lines).toEqual(['P-0901 "build G" (waiting on: coder finishes)', 'P-0902 "check EF"']);
  });
});
