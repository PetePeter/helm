/** One LLM-maintained checklist item belonging to a single Helm session. Done items are removed, not kept. */
export interface SessionTodo {
  id: string;
  text: string;
  /** waiting = parked on a user answer: listed, but never nags the LLM at Stop. */
  status: 'open' | 'waiting';
  createdAt: number;
}

/** What session_todo_done hands back: the item as it left the list. */
export type CompletedSessionTodo = Omit<SessionTodo, 'status'> & { status: 'done'; doneAt: number };

export interface SessionTodosChanged {
  sessionId: string;
  todos: SessionTodo[];
}
