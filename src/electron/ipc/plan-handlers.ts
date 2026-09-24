import { ipcMain, shell, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlanManager } from '../../session/plan-manager.js';
import type { IncomingPlansWatcher } from '../../session/incoming-plans-watcher.js';
import type { ContextManager } from '../../session/context-manager.js';
import { PlanAttachmentManager } from '../../session/plan-attachment-manager.js';
import { logger } from '../../utils/logger.js';
import type { PlanItem, PlanDependency } from '../../types/plan.js';
import type { WindowManager } from '../window-manager.js';
import { getRendererHtmlPath, getTempDir } from '../../utils/app-paths.js';
import { applyNavigationPolicy } from '../navigation-policy.js';
import { resolveWindowIconPath } from '../window-icon.js';
import { getDisplayTitle } from '../../types/plan.js';


export function setupPlanHandlers(
  planManager: PlanManager,
  contextManager?: ContextManager,
  windowManagerOrWatcher?: WindowManager | IncomingPlansWatcher,
  incomingWatcherArg?: IncomingPlansWatcher,
  moduleDirname?: string,
): void {
  const windowManager = isWindowManagerLike(windowManagerOrWatcher) ? windowManagerOrWatcher : undefined;
  const incomingWatcher = isIncomingWatcherLike(windowManagerOrWatcher)
    ? windowManagerOrWatcher
    : incomingWatcherArg;
  const getTargetWindows = () => windowManager?.getAllWindows() ?? BrowserWindow.getAllWindows();
  const attachmentManager = new PlanAttachmentManager(planManager);
  const plannerWindowIds = new Map<string, number>();

  const getFolderLabel = (dirPath: string): string => {
    const parts = dirPath.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || dirPath;
  };

  const formatPlannerWindowTitle = (dirPath: string): string => `Planner - ${getFolderLabel(dirPath)}`;

  // Forward plan:changed events to all windows (PlanManager self-saves to disk)
  planManager.on('plan:changed', (dirPath: string) => {
    for (const win of getTargetWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('plan:changed', dirPath);
      }
    }
  });
  contextManager?.on('context:changed', (projectId: string) => {
    const dirPath = planManager.getDirectoryForProject(projectId) ?? projectId;
    for (const win of getTargetWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('plan:changed', dirPath);
      }
    }
  });

  // Forward incoming-watcher events to all windows
  if (incomingWatcher) {
    incomingWatcher.on('incoming-imported', (event) => {
      for (const win of getTargetWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('plan:incoming-imported', event);
        }
      }
    });
    incomingWatcher.on('incoming-error', (event) => {
      for (const win of getTargetWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('plan:incoming-error', event);
        }
      }
    });
    incomingWatcher.on('incoming-error-cleared', (event) => {
      for (const win of getTargetWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('plan:incoming-error-cleared', event);
        }
      }
    });
  }

  ipcMain.handle('plan:list', (_event, dirPath: string) => {
    return planManager.getForDirectory(dirPath);
  });

  ipcMain.handle('plan:create', (_event, dirPath: string, title: string, description: string, type?: 'bug' | 'feature' | 'research', autoImplement?: boolean, completionRecap?: boolean) => {
    return planManager.createWithType(dirPath, title, description, type, autoImplement, completionRecap);
  });

  ipcMain.handle('plan:update', (_event, id: string, updates: { title?: string; description?: string; type?: 'bug' | 'feature' | 'research'; autoImplement?: boolean; completionRecap?: boolean }) => {
    return planManager.updateWithType(id, updates);
  });

  ipcMain.handle('plan:delete', (_event, id: string) => {
    const result = planManager.delete(id);
    if (result) {
      attachmentManager.deletePlanAttachments(id);
      contextManager?.removeBindingsForTarget('plan', id);
    }
    return result;
  });

  ipcMain.handle('plan:clearCompleted', (_event, dirPath: string) => {
    const doneItems = planManager.getForDirectory(dirPath).filter(i => i.status === 'done');
    const count = planManager.deleteCompletedForDirectory(dirPath);
    for (const item of doneItems) {
      attachmentManager.deletePlanAttachments(item.id);
      contextManager?.removeBindingsForTarget('plan', item.id);
    }
    return count;
  });

  // Bulk cleanup (P-0805). Sequences go first: deleting one releases its
  // context bindings, which is what makes those contexts unreferenced.
  ipcMain.handle('plan:cleanup-counts', (_event, dirPath: string) => {
    const projectId = planManager.getProjectIdForDirectory(dirPath);
    const emptySequenceIds = new Set(planManager.getEmptySequencesForDirectory(dirPath).map(s => s.id));
    const contexts = projectId && contextManager ? contextManager.listForProject(projectId) : [];
    const bindingsOf = (id: string) => contextManager?.getBindingsForContext(id) ?? [];
    return {
      donePlans: planManager.getForDirectory(dirPath).filter(i => i.status === 'done').length,
      emptySequences: emptySequenceIds.size,
      unreferencedContexts: contexts.filter(c => bindingsOf(c.id).length === 0).length,
      // What "Clear unused" will delete: also contexts bound only to empty sequences.
      unusedContexts: contexts.filter(c => bindingsOf(c.id).every(
        b => b.targetType === 'sequence' && emptySequenceIds.has(b.targetId),
      )).length,
    };
  });

  ipcMain.handle('plan:clear-empty-sequences', (_event, dirPath: string) => {
    const deleted = planManager.deleteEmptySequencesForDirectory(dirPath);
    for (const sequence of deleted) contextManager?.removeBindingsForTarget('sequence', sequence.id);
    return deleted.length;
  });

  ipcMain.handle('plan:clear-unreferenced-contexts', (_event, dirPath: string) => {
    const projectId = planManager.getProjectIdForDirectory(dirPath);
    return projectId ? contextManager?.deleteUnreferencedForProject(projectId) ?? 0 : 0;
  });

  ipcMain.handle('plan:addDep', (_event, fromId: string, toId: string) => {
    return planManager.addDependency(fromId, toId);
  });

  ipcMain.handle('plan:removeDep', (_event, fromId: string, toId: string) => {
    return planManager.removeDependency(fromId, toId);
  });

  ipcMain.handle('plan:apply', (_event, id: string) => {
    return planManager.applyItem(id);
  });

  ipcMain.handle('plan:complete', (_event, id: string, completionNotes?: string) => {
    return planManager.completeItem(id, completionNotes);
  });

  ipcMain.handle('plan:reopen', (_event, id: string) => {
    return planManager.reopenItem(id);
  });

  ipcMain.handle(
    'plan:setState',
    (_event, id: string, status: 'planning' | 'ready' | 'coding' | 'review' | 'blocked', stateInfo?: string) => {
      return planManager.setState(id, status, stateInfo);
    },
  );

  ipcMain.handle('plan:startableForDir', (_event, dirPath: string) => {
    return planManager.getStartableForDirectory(dirPath);
  });

  ipcMain.handle('plan:doingForSession', (_event, sessionId: string) => {
    return planManager.getDoingForSession(sessionId);
  });

  ipcMain.handle('plan:getAllDoingForDir', (_event, dirPath: string) => {
    return planManager.getAllDoingForDirectory(dirPath);
  });

  ipcMain.handle('plan:deps', (_event, dirPath: string) => {
    const exported = planManager.exportDirectory(dirPath);
    return exported?.dependencies ?? [];
  });

  ipcMain.handle('plan:getItem', (_event, id: string) => {
    return planManager.getItem(id);
  });

  ipcMain.handle('plan:sequence-list', (_event, dirPath: string) => {
    return planManager.getSequencesForDirectory(dirPath).map((sequence) => ({
      ...sequence,
      ...(contextManager ? { contextIds: contextManager.getContextsForSequence(sequence.id).map((context) => context.id) } : {}),
    }));
  });

  ipcMain.handle(
    'plan:sequence-create',
    (_event, dirPath: string, title: string, missionStatement = '', sharedMemory = '') => {
      return planManager.createSequence(dirPath, title, missionStatement, sharedMemory);
    },
  );

  ipcMain.handle(
    'plan:sequence-update',
    (_event, id: string, updates: { title?: string; missionStatement?: string; sharedMemory?: string; order?: number }) => {
      return planManager.updateSequence(id, updates);
    },
  );

  ipcMain.handle('plan:sequence-delete', (_event, id: string) => {
    const result = planManager.deleteSequence(id);
    if (result) contextManager?.removeBindingsForTarget('sequence', id);
    return result;
  });

  ipcMain.handle('plan:sequence-delete-with-plans', (_event, id: string) => {
    const sequence = planManager.getSequence(id);
    const memberPlanIds = sequence
      ? planManager.getForDirectory(sequence.dirPath).filter((p) => p.sequenceId === id).map((p) => p.id)
      : [];
    const result = planManager.deleteSequenceWithPlans(id);
    if (result) {
      contextManager?.removeBindingsForTarget('sequence', id);
      for (const planId of memberPlanIds) contextManager?.removeBindingsForTarget('plan', planId);
    }
    return result;
  });

  ipcMain.handle('plan:sequence-assign', (_event, planId: string, sequenceId: string | null) => {
    return planManager.assignSequence(planId, sequenceId);
  });

  ipcMain.handle('plan:bulkAssignSequence', (_event, planIds: string[], sequenceId: string | null) => {
    return planManager.bulkAssignSequence(planIds, sequenceId);
  });

  ipcMain.handle('plan:context-list', (_event, dirPath: string) => {
    const projectId = planManager.getProjectIdForDirectory(dirPath);
    if (!projectId) return [];
    return contextManager?.listForProject(projectId).map((context) => ({
      ...context,
      sequenceIds: contextManager.getSequenceIdsForContext(context.id),
      planIds: contextManager.getPlanIdsForContext(context.id),
    })) ?? [];
  });

  ipcMain.handle(
    'plan:context-create',
    (_event, dirPath: string, input: { title: string; type?: string; permission?: 'readonly' | 'writable'; content?: string; x?: number | null; y?: number | null }) => {
      const projectId = planManager.getProjectIdForDirectory(dirPath);
      return projectId ? contextManager?.create(projectId, input) ?? null : null;
    },
  );

  ipcMain.handle(
    'plan:context-update',
    (_event, id: string, updates: { title?: string; type?: string; permission?: 'readonly' | 'writable'; content?: string; x?: number | null; y?: number | null }) =>
      contextManager?.update(id, updates) ?? null,
  );

  ipcMain.handle('plan:context-delete', (_event, id: string) => {
    return contextManager?.delete(id) ?? false;
  });

  ipcMain.handle('plan:context-get', (_event, id: string) => {
    const context = contextManager?.get(id) ?? null;
    if (!context || !contextManager) return null;
    return {
      ...context,
      sequenceIds: contextManager.getSequenceIdsForContext(id),
      planIds: contextManager.getPlanIdsForContext(id),
    };
  });

  ipcMain.handle('plan:context-set-position', (_event, id: string, x: number | null, y: number | null) => {
    return contextManager?.setPosition(id, x, y) ?? null;
  });

  ipcMain.handle('plan:context-bind', (_event, id: string, targetTypeOrTargetId: string, maybeTargetId?: string) => {
    const targetType = maybeTargetId ? targetTypeOrTargetId as 'sequence' | 'plan' : 'sequence';
    const targetId = maybeTargetId ?? targetTypeOrTargetId;
    return contextManager?.bind(id, targetType, targetId) ?? false;
  });

  ipcMain.handle('plan:context-unbind', (_event, id: string, targetTypeOrTargetId: string, maybeTargetId?: string) => {
    const targetType = maybeTargetId ? targetTypeOrTargetId as 'sequence' | 'plan' : 'sequence';
    const targetId = maybeTargetId ?? targetTypeOrTargetId;
    return contextManager?.unbind(id, targetType, targetId) ?? false;
  });

  ipcMain.handle('plan:attachment-list', (_event, planId: string) => {
    return attachmentManager.list(planId);
  });

  ipcMain.handle('plan:attachment-has-any', (_event, planIds: string[]) => {
    return attachmentManager.hasAnyForPlanIds(planIds);
  });

  ipcMain.handle('plan:attachment-add-file', (_event, planId: string, filePath: string) => {
    try {
      const content = readFileSync(filePath);
      const attachment = attachmentManager.add(planId, {
        filename: basename(filePath),
        content,
      });
      planManager.emit('plan:changed', planManager.getItem(planId)?.dirPath ?? '');
      return attachment;
    } catch (error) {
      logger.warn(`[plan:attachment-add-file] Failed to attach ${filePath}: ${error}`);
      return null;
    }
  });

  ipcMain.handle('plan:attachment-delete', (_event, planId: string, attachmentId: string) => {
    try {
      const deleted = attachmentManager.delete(planId, attachmentId);
      if (deleted) {
        planManager.emit('plan:changed', planManager.getItem(planId)?.dirPath ?? '');
      }
      return deleted;
    } catch (error) {
      logger.warn(`[plan:attachment-delete] Failed to delete ${attachmentId}: ${error}`);
      return false;
    }
  });

  ipcMain.handle('plan:attachment-open', async (_event, planId: string, attachmentId: string) => {
    try {
      const { tempPath } = attachmentManager.getToTempFile(planId, attachmentId);
      const errorMessage = await shell.openPath(tempPath);
      if (errorMessage) {
        logger.warn(`[plan:attachment-open] Failed to open ${tempPath}: ${errorMessage}`);
        return false;
      }
      return true;
    } catch (error) {
      logger.warn(`[plan:attachment-open] Failed to open ${attachmentId}: ${error}`);
      return false;
    }
  });

  // ─── Incoming plans ────────────────────────────────────────────────────────

  ipcMain.handle('plan:incoming-list', () => {
    return incomingWatcher?.listFiles() ?? [];
  });

  ipcMain.handle('plan:incoming-delete', (_event, filename: string) => {
    return incomingWatcher?.deleteFile(filename) ?? false;
  });

  ipcMain.handle('plan:incoming-open', async (_event, filename: string) => {
    if (!incomingWatcher) return false;
    const safeName = basename(filename);
    const filePath = join(incomingWatcher.getIncomingDir(), safeName);
    const errorMessage = await shell.openPath(filePath);
    if (errorMessage) {
      logger.warn(`[plan:incoming-open] Failed to open ${safeName}: ${errorMessage}`);
      return false;
    }
    return true;
  });

  // ─── Export ───────────────────────────────────────────────────────────────

  ipcMain.handle('plan:export-item', (_event, planId: string) => {
    const result = planManager.exportItem(planId);
    return result ? JSON.stringify(result, null, 2) : null;
  });

  ipcMain.handle('plan:export-directory', (_event, dirPath: string) => {
    const result = planManager.exportDirectory(dirPath);
    return result ? JSON.stringify(result, null, 2) : null;
  });

  /** Read a file from the local filesystem and return its contents. */
  ipcMain.handle('plan:read-file', (_event, filePath: string): string | null => {
    try {
      return readFileSync(filePath, 'utf8');
    } catch (err) {
      logger.warn(`[plan:read-file] Failed to read ${filePath}: ${err}`);
      return null;
    }
  });

  /** Write content to a local file. Creates parent directories as needed. */
  ipcMain.handle('plan:write-file', (_event, filePath: string, content: string): boolean => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf8');
      return true;
    } catch (err) {
      logger.warn(`[plan:write-file] Failed to write ${filePath}: ${err}`);
      return false;
    }
  });

  ipcMain.handle('plan:open-external', async (_event, planId: string) => {
    try {
      const result = planManager.exportItem(planId);
      if (!result) return { success: false, error: 'Plan not found' };

      const { item, dependencies } = result;
      const safeTitle = item.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
      const tmpDir = getTempDir(moduleDirname ?? '');
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const tmpPath = join(tmpDir, `helm-plan-export-${safeTitle}-${Date.now()}.md`);
      const sequence = item.sequenceId ? planManager.getSequence(item.sequenceId) : null;

      const depLabels = dependencies.length > 0
        ? dependencies.map((d) => {
            const dep = planManager.getItem(d.fromId === planId ? d.toId : d.fromId);
            return dep ? `  - ${dep.humanId ?? dep.id} - ${dep.title}` : null;
          }).filter(Boolean).join('\n')
        : null;

      const md = [
        `<!-- auto-generated by Helm - read-only -->`,
        ``,
        `# ${getDisplayTitle(item.title, item.type)}`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| **ID** | ${item.humanId ?? item.id} |`,
        `| **Status** | ${item.status} |`,
        item.type ? `| **Type** | ${item.type} |` : null,
        item.stateInfo ? `| **State Info** | ${item.stateInfo} |` : null,
        item.sessionId ? `| **Session** | ${item.sessionId.slice(0, 8)}... |` : null,
        `| **Created** | ${new Date(item.createdAt).toISOString().slice(0, 10)} |`,
        item.stateUpdatedAt ? `| **State Changed** | ${new Date(item.stateUpdatedAt).toISOString().slice(0, 10)} |` : null,
        ``,
        `## Description`,
        ``,
        item.description,
        ``,
        sequence ? `## Sequence\n\n- ${sequence.title} (${sequence.id})\n` : null,
        depLabels ? `## Dependencies\n\n${depLabels}\n` : null,
        item.completionNotes ? `## Completion Notes\n\n${item.completionNotes}\n` : null,
      ].filter(Boolean).join('\n') + '\n';

      writeFileSync(tmpPath, md, 'utf8');
      try {
        chmodSync(tmpPath, 0o444);
      } catch (err) {
        logger.warn(`[plan:open-external] Could not mark ${tmpPath} read-only: ${err}`);
      }
      logger.info(`[plan:open-external] Exported plan ${item.humanId ?? planId} to ${tmpPath}`);

      const openErr = await shell.openPath(tmpPath);
      if (openErr) {
        logger.warn(`[plan:open-external] Failed to open: ${openErr}`);
        return { success: false, error: openErr };
      }
      return { success: true, path: tmpPath };
    } catch (err) {
      logger.error(`[plan:open-external] ${err}`);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('plan:popOut', async (_event, dirPath: string) => {
    try {
      if (!dirPath) {
        return { success: false, error: 'Directory path is required' };
      }

      const existingWindowId = plannerWindowIds.get(dirPath);
      if (existingWindowId !== undefined) {
        const existingWindow = windowManager?.getWindow(existingWindowId);
        if (existingWindow && !existingWindow.isDestroyed()) {
          if (existingWindow.isMinimized()) existingWindow.restore();
          existingWindow.show();
          existingWindow.focus();
          return { success: true, windowId: existingWindow.id, reused: true };
        }
        plannerWindowIds.delete(dirPath);
      }

      const __dirname = dirname(fileURLToPath(import.meta.url));
      const preloadPath = join(__dirname, 'preload.cjs');
      const rendererPath = getRendererHtmlPath(__dirname);
      const windowIcon = resolveWindowIconPath(__dirname);
      const childWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 640,
        title: formatPlannerWindowTitle(dirPath),
        icon: windowIcon,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });

      applyNavigationPolicy(childWindow);
      childWindow.loadFile(rendererPath, {
        query: { plannerPopOut: '1', dirPath },
      });

      windowManager?.registerWindow(childWindow.id, childWindow);
      plannerWindowIds.set(dirPath, childWindow.id);

      childWindow.on('closed', () => {
        plannerWindowIds.delete(dirPath);
        windowManager?.unregisterWindow(childWindow.id);
      });

      logger.info(`[Plan] Popped out planner for ${dirPath} to window ${childWindow.id}`);
      return { success: true, windowId: childWindow.id, reused: false };
    } catch (error) {
      logger.error(`[Plan] Pop-out failed: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  logger.info('[IPC] Plan handlers registered');
}

function isWindowManagerLike(value: unknown): value is WindowManager {
  return typeof value === 'object'
    && value !== null
    && typeof (value as WindowManager).getAllWindows === 'function';
}

function isIncomingWatcherLike(value: unknown): value is IncomingPlansWatcher {
  return typeof value === 'object'
    && value !== null
    && typeof (value as IncomingPlansWatcher).listFiles === 'function';
}

