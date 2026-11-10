import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import type { CompletedSessionTodo, SessionTodo, SessionTodosChanged } from '../types/todo.js';

/** Persistence is injected so the manager remains usable with an in-memory store in tests. */
export interface TodoStore {
  load(sessionId: string): SessionTodo[] | null;
  save(sessionId: string, todos: SessionTodo[]): void;
  remove(sessionId: string): void | boolean;
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
    return this.current(sessionId).map(todo => ({ ...todo }));
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

  /** A finished item leaves the checklist: only what is still to do is kept. */
  markDone(sessionId: string, id: string): CompletedSessionTodo {
    const todos = this.current(sessionId);
    const current = todos.find(todo => todo.id === id);
    if (!current) throw new Error(`Todo not found: ${id}`);
    this.write(sessionId, todos.filter(todo => todo.id !== id));
    return { ...current, status: 'done', doneAt: this.now() };
  }

  /** Park an unfinished todo on a user answer, or resume it. */
  setWaiting(sessionId: string, id: string, waiting: boolean): SessionTodo {
    const todos = this.current(sessionId);
    const current = todos.find(todo => todo.id === id);
    if (!current) throw new Error(`Todo not found: ${id}`);
    const next: SessionTodo = { ...current, status: waiting ? 'waiting' : 'open' };
    if (next.status !== current.status) this.write(sessionId, todos.map(todo => todo.id === id ? next : todo));
    return { ...next };
  }

  clear(sessionId: string): number {
    const count = this.current(sessionId).length;
    if (count > 0) this.write(sessionId, []);
    return count;
  }

  /** A session removed permanently takes its checklist with it. */
  clearSession(sessionId: string, reportFailure = false): void {
    this.bySession.delete(sessionId);
    if (this.store.remove(sessionId) === false && reportFailure) {
      throw new Error(`Failed to delete todos for ${sessionId}`);
    }
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

  private write(sessionId: string, todos: SessionTodo[]): void {
    this.bySession.set(sessionId, todos);
    if (todos.length) this.store.save(sessionId, todos.map(todo => ({ ...todo })));
    else this.store.remove(sessionId);
    const event: SessionTodosChanged = { sessionId, todos: todos.map(todo => ({ ...todo })) };
    this.emit('todos:changed', event);
  }
}
