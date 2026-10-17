import { ipcMain } from 'electron';
import type { TodoManager } from '../../session/todo-manager.js';
import { logger } from '../../utils/logger.js';

/** The dock reads session checklists here; only the session's MCP tools mutate them. */
export function setupTodoHandlers(
  todoManager: TodoManager,
  isKnownSession: (sessionId: string) => boolean,
): void {
  ipcMain.handle('todo:list', (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    if (!isKnownSession(sessionId)) throw new Error('Session not found');
    return todoManager.list(sessionId);
  });

  logger.info('[IPC] Todo handlers registered');
}
