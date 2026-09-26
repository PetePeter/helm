/**
 * Operator IPC Handlers — the Settings → Operator panel (docs/voice-operator.md).
 *
 * `config:getOperatorConfig` / `config:setOperatorConfig`. A save persists, then
 * re-runs ensure() so enabling (or switching CLI type on a fresh install) takes
 * effect at once. ensure() never closes anything, so disabling is persist-only.
 */
import { ipcMain } from 'electron';
import { logger } from '../../utils/logger.js';
import type { ConfigLoader, OperatorConfig } from '../../config/loader.js';
import type { OperatorSessionManager } from '../../session/operator-session-manager.js';

export function setupOperatorHandlers(configLoader: ConfigLoader, operator: OperatorSessionManager): void {
  ipcMain.handle('config:getOperatorConfig', () => configLoader.getOperatorConfig());

  ipcMain.handle('config:setOperatorConfig', (_event, updates: Partial<OperatorConfig>) => {
    try {
      configLoader.setOperatorConfig(updates);
      operator.ensure();
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set operator config: ${error}`);
      return { success: false, error: String(error) };
    }
  });
}
