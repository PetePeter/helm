/**
 * Project IPC Handlers
 *
 * Exposes project record CRUD operations for the renderer.
 * Mutating handlers call projectStore.save() to persist changes immediately.
 */

import { ipcMain } from 'electron';
import type { ProjectStore } from '../../session/project-store.js';
import type { PlanManager } from '../../session/plan-manager.js';
import type { ContextManager } from '../../session/context-manager.js';
import { PlanAttachmentManager } from '../../session/plan-attachment-manager.js';
import { validateProjectDirectory, validateProjectPath } from '../../session/validation.js';
import { logger } from '../../utils/logger.js';
import type { WindowManager } from '../window-manager.js';

export function setupProjectHandlers(
  projectStore: ProjectStore,
  planManager?: PlanManager,
  contextManager?: ContextManager,
  windowManager?: WindowManager,
): void {
  const attachmentManager = planManager ? new PlanAttachmentManager(planManager) : null;

  projectStore.onChanged((projects) => {
    for (const win of windowManager?.getAllWindows() ?? []) {
      win.webContents.send('project:changed', projects);
    }
  });

  ipcMain.handle('project:list', () => {
    try {
      return projectStore.list();
    } catch (error) {
      logger.error(`[IPC] Failed to list projects: ${error}`);
      return [];
    }
  });

  ipcMain.handle('project:get', (_event, id: string) => {
    try {
      return projectStore.getById(id) ?? null;
    } catch (error) {
      logger.error(`[IPC] Failed to get project ${id}: ${error}`);
      return null;
    }
  });

  ipcMain.handle('project:update', (_event, id: string, patch: { name: string }) => {
    try {
      projectStore.rename(id, patch.name);
      projectStore.save();
      logger.info(`[IPC] Renamed project ${id} to "${patch.name}"`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to update project ${id}: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('project:create', (_event, dirPath: string, name?: string) => {
    try {
      validateProjectDirectory(dirPath);
      const project = projectStore.resolveForPath(dirPath);
      if (name?.trim()) {
        projectStore.rename(project.id, name);
      }
      projectStore.save();
      logger.info(`[IPC] Created/resolved project ${project.id} for "${dirPath}"`);
      return { success: true, project };
    } catch (error) {
      logger.error(`[IPC] Failed to create project for ${dirPath}: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('project:delete', (_event, id: string) => {
    try {
      const project = projectStore.getById(id);
      if (!project) {
        return { success: false, error: `Project not found: ${id}` };
      }
      const deletedPlans = planManager?.deleteForProject(id) ?? { plansDeleted: 0, sequencesDeleted: 0, planIds: [], sequenceIds: [] };
      for (const planId of deletedPlans.planIds) {
        attachmentManager?.deletePlanAttachments(planId);
        contextManager?.removeBindingsForTarget('plan', planId);
      }
      for (const sequenceId of deletedPlans.sequenceIds) {
        contextManager?.removeBindingsForTarget('sequence', sequenceId);
      }
      projectStore.delete(id);
      projectStore.save();
      logger.info(`[IPC] Deleted project ${id} with ${deletedPlans.plansDeleted} plan(s)`);
      return { success: true, plansDeleted: deletedPlans.plansDeleted, sequencesDeleted: deletedPlans.sequencesDeleted };
    } catch (error) {
      logger.error(`[IPC] Failed to delete project ${id}: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('project:addDir', (_event, id: string, dirPath: string) => {
    try {
      validateProjectDirectory(dirPath);
      projectStore.addDirectory(id, dirPath);
      projectStore.save();
      logger.info(`[IPC] Added directory "${dirPath}" to project ${id}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to add directory to project ${id}: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('project:removeDir', (_event, id: string, dirPath: string) => {
    try {
      // Removing a stale alternate path must remain possible after its folder
      // disappears from disk. Keep the non-empty path check, but do not stat it.
      validateProjectPath(dirPath);
      projectStore.removeDirectory(id, dirPath);
      projectStore.save();
      logger.info(`[IPC] Removed directory "${dirPath}" from project ${id}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to remove directory from project ${id}: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('project:setMainDir', (_event, id: string, dirPath: string) => {
    try {
      validateProjectDirectory(dirPath);
      projectStore.setMainDirectory(id, dirPath);
      projectStore.save();
      logger.info(`[IPC] Set main directory "${dirPath}" for project ${id}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set main directory for project ${id}: ${error}`);
      return { success: false, error: String(error) };
    }
  });
}
