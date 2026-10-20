import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { TodoManager } = await import('../src/session/todo-manager.js');
const { createTodoStore } = await import('../src/session/todo-persistence.js');

describe('TodoManager', () => {
  let dir: string;
  let id = 0;
  let now = 1000;
  const open = () => new TodoManager(createTodoStore(dir), () => `todo-${++id}`, () => now++);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm-todos-'));
    id = 0;
    now = 1000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parks a todo as waiting on the user, resumes it, and keeps the state across a restart', () => {
    const manager = open();
    const todo = manager.add('s1', 'Ask which port');
    expect(manager.setWaiting('s1', todo.id, true)).toMatchObject({ status: 'waiting' });
    expect(open().list('s1')).toEqual([expect.objectContaining({ id: todo.id, status: 'waiting' })]);
    expect(manager.setWaiting('s1', todo.id, false)).toMatchObject({ status: 'open' });
    expect(() => manager.setWaiting('s1', 'nope', true)).toThrow(/not found/);
  });

  it('completes a waiting todo directly but never parks a done one', () => {
    const manager = open();
    const todo = manager.add('s1', 'Ask which port');
    manager.setWaiting('s1', todo.id, true);
    expect(manager.markDone('s1', todo.id)).toMatchObject({ status: 'done' });
    expect(() => manager.setWaiting('s1', todo.id, true)).toThrow(/done/);
  });

  it('persists independent session lists and survives a restart', () => {
    const manager = open();
    const first = manager.add('s1', 'Ship the feature');
    manager.add('s2', 'Other session');

    expect(first).toMatchObject({ id: 'todo-1', text: 'Ship the feature', status: 'open', createdAt: 1000 });
    expect(open().list('s1')).toEqual([first]);
    expect(open().list('s2').map(todo => todo.text)).toEqual(['Other session']);
  });

  it('returns open items before completed items and does not expose mutable manager state', () => {
    const manager = open();
    const first = manager.add('s1', 'First');
    manager.add('s1', 'Second');
    manager.markDone('s1', first.id);

    const todos = manager.list('s1');
    expect(todos.map(todo => [todo.text, todo.status])).toEqual([['Second', 'open'], ['First', 'done']]);
    todos[0]!.text = 'changed outside';
    expect(manager.list('s1')[0]!.text).toBe('Second');
  });

  it('requires non-empty text and only completes an existing todo', () => {
    const manager = open();
    expect(() => manager.add('s1', '  ')).toThrow(/text is required/);
    expect(() => manager.markDone('s1', 'missing')).toThrow(/Todo not found/);
  });

  it('allows deleting completed items only and makes completion idempotent', () => {
    const manager = open();
    const openTodo = manager.add('s1', 'Open');
    expect(() => manager.delete('s1', openTodo.id)).toThrow(/open todo/i);

    const done = manager.markDone('s1', openTodo.id);
    expect(done.status).toBe('done');
    expect(manager.markDone('s1', openTodo.id)).toEqual(done);
    expect(manager.delete('s1', openTodo.id)).toBe(true);
    expect(manager.delete('s1', openTodo.id)).toBe(false);
    expect(manager.list('s1')).toEqual([]);
  });

  it('clears one session and prunes persisted orphans', () => {
    const manager = open();
    manager.add('live', 'Keep');
    manager.add('binned', 'Keep for restore');
    manager.add('orphan', 'Drop');

    expect(manager.clear('live')).toBe(1);
    expect(manager.pruneOrphans(new Set(['live', 'binned']))).toEqual(['orphan']);
    expect(readdirSync(dir).sort()).toEqual(['binned.json']);
  });
});
