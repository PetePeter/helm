/**
 * Tools IPC Handlers
 *
 * CLI type tool management — list, add, update, remove.
 */

import { ipcMain } from 'electron';
import type { ConfigLoader, EnvVarEntry, PatternRule, SequenceListItem } from '../../config/loader.js';
import { logger } from '../../utils/logger.js';

export function setupToolsHandlers(configLoader: ConfigLoader): void {
  ipcMain.handle('tools:getAll', () => {
    try {
      return {
        cliTypes: Object.fromEntries(
          configLoader.getCliTypes().map(key => [key, configLoader.getCliTypeEntry(key)])
        ),
      };
    } catch (error) {
      logger.error(`[IPC] Failed to get tools: ${error}`);
      return { cliTypes: {} };
    }
  });

  ipcMain.handle('tools:addCliType', (
    _event, key: string, name: string,
    initialPrompt: SequenceListItem[], initialPromptDelay: number,
    options?: { env?: EnvVarEntry[]; renameCommand?: string; spawnCommand?: string; resumeCommand?: string; continueCommand?: string; helmPreambleForInterSession?: boolean; largeTextAsTempFile?: boolean; messReminders?: boolean; mouseTracking?: boolean; submitSuffix?: string; helmActions?: { clear?: string; compact?: string; export?: string } },
  ) => {
    try {
      // The minted uuid goes back to the caller — a clone needs it to copy
      // bindings onto the new type, and the renderer keys tabs by it.
      const id = configLoader.addCliType(key, name, initialPrompt, initialPromptDelay, options);
      return { success: true, id };
    } catch (error) {
      logger.error(`[IPC] Failed to add CLI type: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('tools:updateCliType', (
    _event, key: string, name: string,
    initialPrompt: SequenceListItem[], initialPromptDelay: number,
    options?: { env?: EnvVarEntry[]; renameCommand?: string; spawnCommand?: string; resumeCommand?: string; continueCommand?: string; helmPreambleForInterSession?: boolean; largeTextAsTempFile?: boolean; messReminders?: boolean; mouseTracking?: boolean; submitSuffix?: string; helmActions?: { clear?: string; compact?: string; export?: string } },
  ) => {
    try {
      configLoader.updateCliType(key, name, initialPrompt, initialPromptDelay, options);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to update CLI type: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('tools:removeCliType', (_event, key: string) => {
    try {
      configLoader.removeCliType(key);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to remove CLI type: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  /** Which CLI family a tool speaks — the CLI Integrations pane's Tool mapping dropdown. null clears. */
  ipcMain.handle('tools:setCliTypeProvider', (_event, key: string, provider: 'claude' | 'codex' | 'copilot' | null) => {
    try {
      configLoader.setCliTypeProvider(key, provider);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set CLI type provider: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('tools:reorderCliType', (_event, index: number, direction: 'up' | 'down') => {
    try {
      configLoader.reorderCliType(index, direction);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to reorder CLI type: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  // ---------- Pattern rule CRUD -------------------------------------------

  ipcMain.handle('tools:getPatterns', (_event, cliType: string) => {
    try {
      return { patterns: configLoader.getPatterns(cliType) };
    } catch (error) {
      logger.error(`[IPC] Failed to get patterns: ${error}`);
      return { patterns: [] };
    }
  });

  ipcMain.handle('tools:addPattern', (_event, cliType: string, rule: PatternRule) => {
    try {
      configLoader.addPattern(cliType, rule);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to add pattern: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('tools:updatePattern', (_event, cliType: string, index: number, rule: PatternRule) => {
    try {
      configLoader.updatePattern(cliType, index, rule);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to update pattern: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('tools:removePattern', (_event, cliType: string, index: number) => {
    try {
      configLoader.removePattern(cliType, index);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to remove pattern: ${error}`);
      return { success: false, error: String(error) };
    }
  });
}
