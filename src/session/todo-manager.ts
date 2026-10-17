import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { orderSessionTodos, type SessionTodo, type SessionTodosChanged } from '../types/todo.js';

/** Persistence is injected so the manager remains usable with an in-memory store in tests. */
export interface TodoStore {
  load(sessionId: string): SessionTodo[] | null;
  save(sessionId: string, todos: SessionTodo[]): void;
  remove(sessionId: string): void;
  list(): string[];
}

/** The one owner of each session's checklist. Mutations are synchronous and immediately persisted. */
export class TodoManager extends EventEmitter {
  private readonly bySession = new Map<string, SessionTodo[]>();

  constructor(
    private readonly store: TodoStore,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  list(sessionId: string): SessionTodo[] {
    return this.ordered(this.current(sessionId)).map(todo => ({ ...todo }));
  }

  add(sessionId: string, text: string): SessionTodo {
    const cleanText = typeof text === 'string' ? text.trim() : '';
    if (!cleanText) throw new Error('text is required');
    const todos = this.current(sessionId);
    let id = this.createId();
    while (todos.some(todo => todo.id === id)) id = this.createId();
    const todo: SessionTodo = { id, text: cleanText, status: 'open', createdAt: this.now() };
    this.write(sessionId, [...todos, todo]);
    return { ...todo };
  }

  markDone(sessionId: string, id: string): SessionTodo {
    const todos = this.current(sessionId);
    const current = todos.find(todo => todo.id === id);
    if (!current) throw new Error(`Todo not found: ${id}`);
    if (current.status === 'done') return { ...current };
    const completed: SessionTodo = { ...current, status: 'done', doneAt: this.now() };
    this.write(sessionId, todos.map(todo => todo.id === id ? completed : todo));
    return { ...completed };
  }

  /** Completed items can be removed; open items must first be marked done. */
  delete(sessionId: string, id: string): boolean {
    const todos = this.current(sessionId);
    const current = todos.find(todo => todo.id === id);
    if (!current) return false;
    if (current.status !== 'done') throw new Error('Cannot delete an open todo. Mark it done first.');
    this.write(sessionId, todos.filter(todo => todo.id !== id));
    return true;
  }

  clear(sessionId: string): number {
    const count = this.current(sessionId).length;
    if (count > 0) this.write(sessionId, []);
    return count;
  }

  /** A session removed permanently takes its checklist with it. */
  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.store.remove(sessionId);
  }

  /** Startup reclamation after a crash: keep only live and recycle-bin sessions. */
  pruneOrphans(keep: ReadonlySet<string>): string[] {
    const pruned = this.store.list().filter(sessionId => !keep.has(sessionId));
    for (const sessionId of pruned) this.clearSession(sessionId);
    if (pruned.length) logger.info(`[Todos] Pruned ${pruned.length} orphaned todo list(s)`);
    return pruned;
  }

  private current(sessionId: string): SessionTodo[] {
    let todos = this.bySession.get(sessionId);
    if (!todos) {
      todos = this.store.load(sessionId) ?? [];
      this.bySession.set(sessionId, todos);
    }
    return todos;
  }

  private ordered(todos: SessionTodo[]): SessionTodo[] {
    return orderSessionTodos(todos);
  }

  private write(sessionId: string, todos: SessionTodo[]): void {
    const next = this.ordered(todos);
    this.bySession.set(sessionId, next);
    if (next.length) this.store.save(sessionId, next.map(todo => ({ ...todo })));
    else this.store.remove(sessionId);
    const event: SessionTodosChanged = { sessionId, todos: next.map(todo => ({ ...todo })) };
    this.emit('todos:changed', event);
  }
}
