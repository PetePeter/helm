import { ipcMain } from 'electron';
import type { ConfigLoader } from '../../config/loader.js';
import type { SilentRunner } from '../../session/silent-model-runner.js';
import type { AutoMemorySettings, AutoMemoryState } from '../../types/auto-memory.js';
import { logger } from '../../utils/logger.js';

/** The smallest request that proves the picked model answers. */
const TEST_PROMPT = 'Reply with the single word OK.';

/** Settings · Auto memory: the recording model, the two switches, and a silent test run. */
export function setupAutoMemoryHandlers(configLoader: ConfigLoader, runner: SilentRunner): void {
  const state = (): AutoMemoryState => ({
    success: true,
    settings: configLoader.getAutoMemoryConfig(),
    models: configLoader.getRecordingModelOptions(),
  });

  ipcMain.handle('config:getAutoMemory', () => {
    try {
      return state();
    } catch (error) {
      logger.error(`[IPC] Failed to read auto memory settings: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:setAutoMemory', (_event, updates: Partial<AutoMemorySettings>) => {
    try {
      configLoader.setAutoMemoryConfig(updates && typeof updates === 'object' ? updates : {});
      return state();
    } catch (error) {
      logger.warn(`[IPC] Auto memory settings refused: ${error}`);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('config:testAutoMemoryModel', () => runner.runSilently({ prompt: TEST_PROMPT }));
}
