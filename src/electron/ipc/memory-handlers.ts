/** Renderer-only memory IPC. Ownership is derived from the sending window. */
import { BrowserWindow, ipcMain, shell } from 'electron';
import type { SessionManager } from '../../session/manager.js';
import type { MemoryAttachmentManager } from '../../session/memory-attachment-manager.js';
import type { MemoryManager } from '../../session/memory-manager.js';
import type { ArtifactTempRegistry } from '../../session/artifact-temp-registry.js';
import { HelmMemoryService } from '../../mcp/services/helm-memory-service.js';
import type { MemoryExportFormat, MemorySearchOptions } from '../../types/memory.js';
import type { WindowManager } from '../window-manager.js';

/**
 * Pure owner rule kept separate so the security boundary is directly testable.
 *
 * `requestedSessionId` is the renderer's explicit statement of which session's
 * memories it is rendering. Honouring it — instead of re-resolving "whatever is
 * active now" at handle time — is what stops project B's memories from landing
 * in a view that project A opened. It never grants authority: a window pinned to
 * one session may only ask for that session, and the main window may only ask
 * for a session that exists (checked by the caller).
 */
export function resolveRendererMemorySession(
  senderWindowId: number,
  mainWindowId: number | null | undefined,
  mappedSessionIds: readonly string[],
  activeSessionId: string | null | undefined,
  requestedSessionId?: string | null,
): string | null {
  if (mappedSessionIds.length === 1) {
    const owned = mappedSessionIds[0];
    if (requestedSessionId && requestedSessionId !== owned) return null;
    return owned;
  }
  if (mappedSessionIds.length !== 0) return null;
  if (mainWindowId === senderWindowId) return requestedSessionId ?? activeSessionId ?? null;
  return null;
}

function validateId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  return value;
}

/** Renderer callers may omit the session id; anything else must be a real id. */
function validateOptionalSessionId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return validateId(value, 'sessionId');
}

function validateGraphDepth(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error('graphDepth must be a nonnegative integer no greater than 100');
  }
  return value;
}

function validateFormat(value: unknown): MemoryExportFormat {
  if (value !== 'markdown' && value !== 'json') throw new Error('format must be markdown or json');
  return value;
}

function ownerResolver(sessionManager: SessionManager, windowManager: WindowManager) {
  return (event: Electron.IpcMainInvokeEvent, requestedSessionId?: unknown): string | null => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) return null;
    const requested = validateOptionalSessionId(requestedSessionId);
    // A requested id is only a narrowing of existing authority, never a grant:
    // it has to name a live session before it can be resolved as the owner.
    if (requested && !sessionManager.getSession(requested)) return null;
    return resolveRendererMemorySession(
      senderWindow.id,
      windowManager.getMainWindow()?.id,
      windowManager.getSessionsInWindow(senderWindow.id),
      sessionManager.getActiveSession()?.id,
      requested,
    );
  };
}

/** Register the intentionally read-only renderer surface for durable memories. */
export function setupMemoryHandlers(
  memoryManager: MemoryManager,
  attachmentManager: MemoryAttachmentManager,
  sessionManager: SessionManager,
  windowManager: WindowManager,
  tempRegistry: ArtifactTempRegistry,
): void {
  const service = new HelmMemoryService(memoryManager, attachmentManager, tempRegistry);
  const resolveOwner = ownerResolver(sessionManager, windowManager);
  const requireOwner = (event: Electron.IpcMainInvokeEvent, requestedSessionId?: unknown): string => {
    const sessionId = resolveOwner(event, requestedSessionId);
    if (!sessionId) throw new Error('Renderer memory access requires an owning session window');
    return sessionId;
  };

  ipcMain.handle('memory:list', (event, sessionId?: unknown) =>
    service.listMemorySummaries(requireOwner(event, sessionId)));
  ipcMain.handle('memory:get', (event, id: unknown, sessionId?: unknown) =>
    service.getMemoryRecord(requireOwner(event, sessionId), validateId(id, 'memoryId')));
  ipcMain.handle('memory:search', (event, query: unknown, options?: MemorySearchOptions, sessionId?: unknown) => {
    if (typeof query !== 'string') throw new Error('query must be a string');
    const safeOptions = options ?? {};
    if (safeOptions.regex !== undefined && typeof safeOptions.regex !== 'boolean') throw new Error('regex must be boolean');
    return service.searchMemories(requireOwner(event, sessionId), query, {
      regex: safeOptions.regex,
      graphDepth: validateGraphDepth(safeOptions.graphDepth),
    });
  });
  ipcMain.handle('memory:graph-all', (event, sessionId?: unknown) =>
    service.graphAllMemories(requireOwner(event, sessionId)));
  ipcMain.handle('memory:graph', (event, rootId: unknown, graphDepth?: unknown, sessionId?: unknown) =>
    service.graphMemory(requireOwner(event, sessionId), validateId(rootId, 'rootId'), validateGraphDepth(graphDepth)));
  ipcMain.handle('memory:export', (event, format: unknown, rootId?: unknown, graphDepth?: unknown, sessionId?: unknown) =>
    service.exportMemories(
      requireOwner(event, sessionId),
      validateFormat(format),
      rootId === undefined || rootId === null ? undefined : validateId(rootId, 'rootId'),
      validateGraphDepth(graphDepth),
    ));
  ipcMain.handle('memory:delete', (event, id: unknown, sessionId?: unknown) =>
    service.deleteMemory(requireOwner(event, sessionId), validateId(id, 'memoryId')));

  ipcMain.handle('memory:attachment-list', (event, memoryId: unknown, sessionId?: unknown) =>
    service.listMemoryAttachments(requireOwner(event, sessionId), validateId(memoryId, 'memoryId')));
  ipcMain.handle('memory:attachment-open', async (event, memoryId: unknown, attachmentId: unknown, ownerSessionId?: unknown) => {
    const sessionId = requireOwner(event, ownerSessionId);
    const memory = validateId(memoryId, 'memoryId');
    const attachment = validateId(attachmentId, 'attachmentId');
    try {
      const { tempPath } = service.getMemoryAttachment(sessionId, memory, attachment);
      const error = await shell.openPath(tempPath);
      return error ? { success: false, error } : { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
  ipcMain.handle('memory:attachment-delete', (event, memoryId: unknown, attachmentId: unknown, sessionId?: unknown) =>
    service.deleteMemoryAttachment(
      requireOwner(event, sessionId),
      validateId(memoryId, 'memoryId'),
      validateId(attachmentId, 'attachmentId'),
    ));
}
