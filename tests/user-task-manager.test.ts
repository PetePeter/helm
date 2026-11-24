import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { UserTaskManager } = await import('../src/session/user-task-manager.js');
const { createUserTaskStore } = await import('../src/session/user-task-persistence.js');
const { USER_TASK_DONE_RETENTION_MS } = await import('../src/types/user-task.js');

describe('UserTaskManager', () => {
  let dir: string;
  let id = 0;
  let now = 1000;
  const open = () => new UserTaskManager(createUserTaskStore(dir), () => `id-${++id}`, () => now);
  const ai = { kind: 'ai' as const, name: 'helm-core', cliType: 'claude-code', dir: 'x:/repo', sessionId: 's1' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm-user-tasks-'));
    id = 0;
    now = 1000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds a task, persists it, and orders urgent first then newest', () => {
    const manager = open();
    manager.add({ title: 'Old' }, { kind: 'user' });
    now = 2000;
    manager.add({ title: 'Newer' }, ai);
    now = 3000;
    manager.add({ title: 'Urgent', urgent: true, projectId: 'p1' }, { kind: 'user' });
    expect(open().list().map(t => t.title)).toEqual(['Urgent', 'Newer', 'Old']);
    expect(open().list()[1].author).toEqual(ai);
  });

  it('rejects an empty or overlong title', () => {
    const manager = open();
    expect(() => manager.add({ title: '  ' }, { kind: 'user' })).toThrow(/title/);
    expect(() => manager.add({ title: 'x'.repeat(201) }, { kind: 'user' })).toThrow(/title/);
  });

  it('updates fields, clears a project, and marks done / undone', () => {
    const manager = open();
    const task = manager.add({ title: 'A', projectId: 'p1' }, { kind: 'user' });
    now = 5000;
    const updated = manager.update(task.id, { title: 'B', body: 'details', projectId: null, urgent: true, done: true });
    expect(updated).toMatchObject({ title: 'B', body: 'details', urgent: true, doneAt: 5000, updatedAt: 5000 });
    expect(updated.projectId).toBeUndefined();
    expect(manager.update(task.id, { done: false }).doneAt).toBeUndefined();
    expect(() => manager.update('nope', { title: 'x' })).toThrow(/not found/);
  });

  it('owns attachment copies and deletes them with the task', () => {
    const manager = open();
    const task = manager.add({ title: 'Review' }, ai, [
      { kind: 'artifact', title: 'Report', contentType: 'text/markdown', content: Buffer.from('# hi') },
      { kind: 'plan', title: 'Plan', contentType: 'text/markdown', content: Buffer.from('plan'), planId: 'plan-1' },
    ]);
    expect(task.attachments).toHaveLength(2);
    expect(task.attachments[1]).toMatchObject({ kind: 'plan', planId: 'plan-1', sizeBytes: 4 });
    const read = open().readAttachment(task.id, task.attachments[0].id);
    expect(read.content.toString()).toBe('# hi');
    manager.delete(task.id);
    expect(existsSync(join(dir, 'attachments', task.id))).toBe(false);
    expect(open().list()).toEqual([]);
  });

  it('purges tasks done for longer than the retention window', () => {
    const manager = open();
    const task = manager.add({ title: 'Done long ago' }, { kind: 'user' });
    manager.update(task.id, { done: true });
    manager.add({ title: 'Still open' }, { kind: 'user' });
    now += USER_TASK_DONE_RETENTION_MS + 1;
    expect(open().list().map(t => t.title)).toEqual(['Still open']);
  });

  it('emits the whole list on every change', () => {
    const manager = open();
    const seen: number[] = [];
    manager.on('userTasks:changed', (e: { tasks: unknown[] }) => seen.push(e.tasks.length));
    const task = manager.add({ title: 'A' }, { kind: 'user' });
    manager.delete(task.id);
    expect(seen).toEqual([1, 0]);
  });
});
