import type { HookInjectionOverrides } from './hooks/hook-injections.js';
import { renderHookInjection } from './hooks/hook-injections.js';
import type { SessionTodo } from '../types/todo.js';

export function renderSessionTodoContext(
  todos: readonly SessionTodo[],
  overrides?: HookInjectionOverrides,
): string {
  const items = todos
    .filter(todo => todo.status !== 'done')
    .map(todo => `- ${todo.id}: ${todo.text}${todo.status === 'waiting' ? ' (waiting on user)' : ''}`);
  return [
    renderHookInjection('todosPrompt', { items: items.length ? items.join('\n') : '- (none)' }, overrides),
    renderHookInjection('etaPrompt', {}, overrides),
  ].join('\n');
}

/** Put the current checklist beside persistent manifesto text on API reset paths. */
export function appendSessionTodoContext(
  manifestoContext: string,
  todos: readonly SessionTodo[],
  overrides?: HookInjectionOverrides,
): string {
  return [manifestoContext.trim(), renderSessionTodoContext(todos, overrides)].filter(Boolean).join('\n\n');
}
