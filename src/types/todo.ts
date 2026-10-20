/** One LLM-maintained checklist item belonging to a single Helm session. */
export interface SessionTodo {
  id: string;
  text: string;
  /** waiting = parked on a user answer: listed, but never nags the LLM at Stop. */
  status: 'open' | 'waiting' | 'done';
  createdAt: number;
  doneAt?: number;
}

export interface SessionTodosChanged {
  sessionId: string;
  todos: SessionTodo[];
}

export interface SessionTodoCount {
  done: number;
  total: number;
}

export function countSessionTodos(todos: readonly SessionTodo[]): SessionTodoCount {
  return { done: todos.filter(todo => todo.status === 'done').length, total: todos.length };
}

export function orderSessionTodos(todos: readonly SessionTodo[]): SessionTodo[] {
  return [...todos].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done'));
}
