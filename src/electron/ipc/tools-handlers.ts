/**
 * Tools IPC Handlers
 *
 * CLI type tool management — list, add, update, remove.
 */

import { ipcMain } from 'electron';
import type { CliTypeOptions, ConfigLoader, PatternRule, SequenceListItem } from '../../config/loader.js';
import { logger } from '../../utils/logger.js';
import { MCP_TOOLS } from '../../mcp/tools/definitions.js';
import { listAvailableApiTools } from '../../session/api/api-prompt.js';

/** First sentence, capped — the tick list shows a hint, not the full tool manual. */
function shortDescription(text: string): string {
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

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

  /** Every tool an API tool can be ticked for (native + Helm MCP), for the tool editor's tick list. */
  ipcMain.handle('tools:apiToolCatalog', () => listAvailableApiTools(MCP_TOOLS)
    .map(({ name, description, source }) => ({ name, description: shortDescription(description), source })));

  ipcMain.handle('tools:addCliType', (
    _event, key: string, name: string,
    initialPrompt: SequenceListItem[], initialPromptDelay: number,
    options?: CliTypeOptions,
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
    options?: CliTypeOptions,
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
