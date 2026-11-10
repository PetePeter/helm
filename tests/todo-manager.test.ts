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

  it('completes a waiting todo directly, removing it', () => {
    const manager = open();
    const todo = manager.add('s1', 'Ask which port');
    manager.setWaiting('s1', todo.id, true);
    expect(manager.markDone('s1', todo.id)).toMatchObject({ id: todo.id, status: 'done', doneAt: expect.any(Number) });
    expect(manager.list('s1')).toEqual([]);
    expect(() => manager.setWaiting('s1', todo.id, true)).toThrow(/not found/);
  });

  it('persists independent session lists and survives a restart', () => {
    const manager = open();
    const first = manager.add('s1', 'Ship the feature');
    manager.add('s2', 'Other session');

    expect(first).toMatchObject({ id: 'todo-1', text: 'Ship the feature', status: 'open', createdAt: 1000 });
    expect(open().list('s1')).toEqual([first]);
    expect(open().list('s2').map(todo => todo.text)).toEqual(['Other session']);
  });

  it('drops a completed todo from the list and the store, and hides manager state', () => {
    const manager = open();
    const first = manager.add('s1', 'First');
    manager.add('s1', 'Second');
    manager.markDone('s1', first.id);

    const todos = manager.list('s1');
    expect(todos.map(todo => todo.text)).toEqual(['Second']);
    expect(open().list('s1').map(todo => todo.text)).toEqual(['Second']);
    todos[0]!.text = 'changed outside';
    expect(manager.list('s1')[0]!.text).toBe('Second');
  });

  it('requires non-empty text and only completes an existing todo', () => {
    const manager = open();
    expect(() => manager.add('s1', '  ')).toThrow(/text is required/);
    expect(() => manager.markDone('s1', 'missing')).toThrow(/Todo not found/);
  });

  it('drops done items left in a file written by an older version', () => {
    const store = createTodoStore(dir);
    store.save('s1', [
      { id: 'a', text: 'Old done', status: 'done', createdAt: 1, doneAt: 2 } as never,
      { id: 'b', text: 'Still open', status: 'open', createdAt: 3 },
    ]);
    expect(open().list('s1').map(todo => todo.id)).toEqual(['b']);
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

  it('copies unfinished todos to a successor and rolls back only the copy', () => {
    const manager = open();
    const openTodo = manager.add('source', 'Carry the parser work');
    const waitingTodo = manager.add('source', 'Ask before changing format');
    manager.setWaiting('source', waitingTodo.id, true);

    const rollback = manager.copySession('source', 'successor');

    expect(manager.list('successor')).toEqual([openTodo, { ...waitingTodo, status: 'waiting' }]);
    rollback();
    rollback();
    expect(manager.list('successor')).toEqual([]);
    expect(manager.list('source')).toEqual([openTodo, { ...waitingTodo, status: 'waiting' }]);
  });
});
