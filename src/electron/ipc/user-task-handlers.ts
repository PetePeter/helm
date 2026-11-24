import { ipcMain, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UserTaskManager } from '../../session/user-task-manager.js';
import type { UserTaskPatch } from '../../types/user-task.js';
import { logger } from '../../utils/logger.js';

/**
 * The desktop acts as the user: tasks added here are authored by "you". AI
 * authors only arrive through user_task_add, where identity is authenticated.
 */
export function setupUserTaskHandlers(manager: UserTaskManager, tempDir: string): void {
  ipcMain.handle('userTask:list', () => manager.list());

  ipcMain.handle('userTask:add', (_event, input: { title: string; body?: string; urgent?: boolean; projectId?: string }) => {
    if (!input || typeof input !== 'object') throw new Error('input is required');
    return manager.add(
      { title: input.title, body: input.body, urgent: input.urgent === true, projectId: input.projectId },
      { kind: 'user' },
    );
  });

  ipcMain.handle('userTask:update', (_event, id: string, patch: UserTaskPatch) => {
    if (typeof id !== 'string' || !id) throw new Error('id is required');
    return manager.update(id, patch ?? {});
  });

  ipcMain.handle('userTask:delete', (_event, id: string) => {
    if (typeof id !== 'string' || !id) throw new Error('id is required');
    manager.delete(id);
    return true;
  });

  /** Text comes back as a string for the contained viewer; binaries as base64. */
  ipcMain.handle('userTask:readAttachment', (_event, taskId: string, attachmentId: string) => {
    const { attachment, content } = manager.readAttachment(taskId, attachmentId);
    const text = attachment.contentType.startsWith('text/') || attachment.contentType === 'application/json';
    return { attachment, encoding: text ? 'utf8' : 'base64', content: content.toString(text ? 'utf8' : 'base64') };
  });

  /** Binary copies (PDF, other files) open in the OS viewer from a private temp copy. */
  ipcMain.handle('userTask:openAttachment', async (_event, taskId: string, attachmentId: string) => {
    const { attachment, content } = manager.readAttachment(taskId, attachmentId);
    const safeName = attachment.title.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 80) || 'attachment';
    const folder = join(tempDir, 'user-task-attachments', randomUUID());
    mkdirSync(folder, { recursive: true });
    const file = join(folder, safeName);
    writeFileSync(file, content, { mode: 0o600 });
    const failure = await shell.openPath(file);
    if (failure) throw new Error(failure);
    return true;
  });

  logger.info('[IPC] User task handlers registered');
}
