import { ipcMain } from 'electron';
import type { ConfigLoader } from '../../config/loader.js';
import type { DreamingConfigResult, DreamingSettings } from '../../types/dreaming.js';
import { logger } from '../../utils/logger.js';

/** Settings · Dreaming: one global prompt shared by every project's daily dream. */
export function setupDreamingHandlers(configLoader: ConfigLoader): void {
  const state = (): DreamingConfigResult => ({
    success: true,
    settings: configLoader.getDreamingConfig(),
  });

  ipcMain.handle('config:getDreaming', () => {
    try {
      return state();
    } catch (error) {
      logger.error(`[IPC] Failed to read dreaming settings: ${error}`);
      return { success: false, error: String(error) } satisfies DreamingConfigResult;
    }
  });

  ipcMain.handle('config:setDreaming', (_event, updates: Partial<DreamingSettings>) => {
    try {
      configLoader.setDreamingConfig(updates && typeof updates === 'object' ? updates : {});
      return state();
    } catch (error) {
      logger.warn(`[IPC] Dreaming settings refused: ${error}`);
      return { success: false, error: error instanceof Error ? error.message : String(error) } satisfies DreamingConfigResult;
    }
  });
}
