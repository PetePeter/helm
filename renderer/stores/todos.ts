import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { eventsClient, sessionsClient } from '../ipc/clients.js';
import { countSessionTodos, orderSessionTodos, type SessionTodo, type SessionTodosChanged } from '../../src/types/todo.js';

/** Renderer mirror used by both the read-only Todos pane and session-row counts. */
export const useTodosStore = defineStore('todos', () => {
  const bySession = reactive(new Map<string, SessionTodo[]>());
  const errors = reactive(new Map<string, string>());
  const loaded = new Set<string>();
  const versions = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  function apply(change: SessionTodosChanged): void {
    versions.set(change.sessionId, (versions.get(change.sessionId) ?? 0) + 1);
    bySession.set(change.sessionId, orderSessionTodos(change.todos.map(todo => ({ ...todo }))));
    errors.delete(change.sessionId);
    loaded.add(change.sessionId);
  }

  const stopListening = eventsClient.onTodosChanged?.(apply);
  // Keep a reference to the disposer on the store for tests and window teardown.
  function stop(): void { stopListening?.(); }

  async function loadSession(sessionId: string): Promise<void> {
    if (!sessionId || loaded.has(sessionId)) return;
    const existing = inFlight.get(sessionId);
    if (existing) return existing;
    const version = versions.get(sessionId) ?? 0;
    const request = Promise.resolve().then(() => sessionsClient.todoList(sessionId))
      .then(todos => {
        if ((versions.get(sessionId) ?? 0) !== version) return;
        bySession.set(sessionId, orderSessionTodos(todos.map(todo => ({ ...todo }))));
        errors.delete(sessionId);
        loaded.add(sessionId);
      })
      .catch(error => {
        if ((versions.get(sessionId) ?? 0) === version) {
          errors.set(sessionId, error instanceof Error ? error.message : String(error));
          loaded.add(sessionId);
        }
      })
      .finally(() => { inFlight.delete(sessionId); });
    inFlight.set(sessionId, request);
    return request;
  }

  async function loadSessions(sessionIds: readonly string[]): Promise<void> {
    await Promise.all([...new Set(sessionIds)].map(loadSession));
  }

  function todosFor(sessionId: string): SessionTodo[] {
    return bySession.get(sessionId) ?? [];
  }

  function countFor(sessionId: string) {
    return countSessionTodos(todosFor(sessionId));
  }

  function errorFor(sessionId: string): string {
    return errors.get(sessionId) ?? '';
  }

  return { bySession, loadSession, loadSessions, todosFor, countFor, errorFor, stop };
});
