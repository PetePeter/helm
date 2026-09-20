/**
 * Configuration IPC Handlers
 *
 * Exposes configuration read/write operations including
 * bindings, CLI types, and working directory CRUD.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { type ConfigLoader, type PlanFilterConfig, type EditorPrefs, type FleetConfig, type WorkspaceLayoutProfile, type CliHooksIntegration } from '../../config/loader.js';
import type { LocalhostMcpServer } from '../../mcp/localhost-mcp-server.js';
import type { ProjectStore } from '../../session/project-store.js';
import type { FleetStatus } from '../../mcp/peer/fleet-controller.js';
import type { HookInstallerDeps, HookIntegrationStatus } from '../../session/hooks/hook-installer.js';
import { installCliHooks, readHookIntegrationStatus, uninstallCliHooks } from '../../session/hooks/hook-installer.js';
import { PROMPT_INJECTION_PROVIDERS } from '../../session/hooks/context-injector.js';
import { REMINDER_IDS, isReminderDeliveryMode, type ReminderDeliveryMode, type ReminderId } from '../../session/reminder-delivery.js';
import { summarizeSuggestionUsage, type SuggestionUsageStore } from '../../session/hooks/suggestion-usage-store.js';
import { normalizeProjectPath, dirDisplayNameFromPath } from '../../session/project-identity.js';
import { logger } from '../../utils/logger.js';

export function setupConfigHandlers(
  configLoader: ConfigLoader,
  localhostMcpServer?: LocalhostMcpServer,
  projectStore?: ProjectStore,
  applyFleetConfig?: (config: FleetConfig) => Promise<void>,
  getFleetStatus?: () => FleetStatus,
  hookDeps?: HookInstallerDeps,
  suggestionUsage?: SuggestionUsageStore,
): void {
  ipcMain.handle('config:getAll', () => {
    try {
      configLoader.load();
      return {
        cliTypes: configLoader.getCliTypes(),
      };
    } catch (error) {
      logger.error(`[IPC] Failed to get all config: ${error}`);
      return { cliTypes: [] };
    }
  });

  ipcMain.handle('config:getBindings',(_event, cliType: string) => {
    try {
      return configLoader.getBindings(cliType);
    } catch (error) {
      logger.error(`[IPC] Failed to get bindings for ${cliType}: ${error}`);
      return null;
    }
  });

  ipcMain.handle('config:getCliTypes', () => {
    try {
      return configLoader.getCliTypes();
    } catch (error) {
      logger.error(`[IPC] Failed to get CLI types: ${error}`);
      return [];
    }
  });

  ipcMain.handle('config:getChipbarActions', () => {
    try {
      return configLoader.getChipbarActions();
    } catch (error) {
      logger.error(`[IPC] Failed to get chipbar actions: ${error}`);
      return { actions: [], inboxDir: '' };
    }
  });

  ipcMain.handle('config:setSequenceGroup', (_event, cliType: string, groupId: string, items: any[]) => {
    try {
      configLoader.setSequenceGroup(cliType, groupId, items);
      logger.info(`[IPC] Set sequence group: ${groupId} for ${cliType} (${items.length} items)`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set sequence group: ${groupId} ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:removeSequenceGroup', (_event, cliType: string, groupId: string) => {
    try {
      configLoader.removeSequenceGroup(cliType, groupId);
      logger.info(`[IPC] Removed sequence group: ${groupId} from ${cliType}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to remove sequence group: ${groupId} ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:setBinding', (_event, button: string, cliType: string, binding: any) => {
    try {
      configLoader.setBinding(button, cliType, binding);
      logger.info(`[IPC] Set binding: ${button} for ${cliType} ${JSON.stringify(binding)}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set binding: ${button} ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:removeBinding', (_event, button: string, cliType: string) => {
    try {
      configLoader.removeBinding(button, cliType);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:copyCliBindings', (_event, sourceCli: string, targetCli: string) => {
    try {
      const count = configLoader.copyCliBindings(sourceCli, targetCli);
      logger.info(`[IPC] Copied ${count} bindings from ${sourceCli} to ${targetCli}`);
      return { success: true, count };
    } catch (error) {
      logger.error(`[IPC] Failed to copy bindings: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:getWorkingDirs', () => {
    try {
      type DirItem = { name: string; path: string; projectId?: string; projectName?: string; isCanonical?: boolean };
      const yielded = new Set<string>();
      const items: DirItem[] = [];

      if (projectStore) {
        for (const record of projectStore.list()) {
          const canonicalKey = normalizeProjectPath(record.canonicalPath);
          if (!yielded.has(canonicalKey)) {
            yielded.add(canonicalKey);
            items.push({ name: dirDisplayNameFromPath(record.canonicalPath), path: record.canonicalPath, projectId: record.id, projectName: record.name, isCanonical: true });
          }
          for (const altPath of record.alternatePaths ?? []) {
            const altKey = normalizeProjectPath(altPath);
            if (!yielded.has(altKey)) {
              yielded.add(altKey);
              items.push({ name: dirDisplayNameFromPath(altPath), path: altPath, projectId: record.id, projectName: record.name, isCanonical: false });
            }
          }
        }
      }

      // Include configured dirs not already covered by any project
      for (const dir of configLoader.getWorkingDirectories()) {
        const key = normalizeProjectPath(dir.path);
        if (!yielded.has(key)) {
          yielded.add(key);
          items.push({ name: dir.name, path: dir.path });
        }
      }

      return items;
    } catch (error) {
      logger.error(`[IPC] Failed to get working dirs: ${error}`);
      return [];
    }
  });

  ipcMain.handle('config:getHapticFeedback', () => {
    try {
      return configLoader.getHapticFeedback();
    } catch (error) {
      logger.error(`[IPC] Failed to get haptic feedback setting: ${error}`);
      return true; // Default to enabled
    }
  });

  ipcMain.handle('config:setHapticFeedback', (_event, enabled: boolean) => {
    try {
      configLoader.setHapticFeedback(enabled);
      logger.info(`[IPC] Haptic feedback set to: ${enabled}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set haptic feedback: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:getNotifications', () => {
    try {
      return configLoader.getNotifications();
    } catch (error) {
      logger.error(`[IPC] Failed to get notifications setting: ${error}`);
      return true;
    }
  });

  ipcMain.handle('config:setNotifications', (_event, enabled: boolean) => {
    try {
      configLoader.setNotifications(enabled);
      logger.info(`[IPC] Notifications set to: ${enabled}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set notifications: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:getMcpConfig', () => {
    try {
      return configLoader.getMcpConfig();
    } catch (error) {
      logger.error(`[IPC] Failed to get MCP config: ${error}`);
      return { enabled: false, port: 47373, authToken: '' };
    }
  });

  ipcMain.handle('config:setMcpConfig', async (_event, updates: { enabled?: boolean; port?: number; authToken?: string }) => {
    try {
      configLoader.setMcpConfig(updates);
      logger.info(`[IPC] MCP config updated: ${JSON.stringify({ enabled: updates.enabled, port: updates.port, authToken: updates.authToken ? '[redacted]' : undefined })}`);
      if (localhostMcpServer) {
        try {
          await localhostMcpServer.applyConfig(configLoader.getMcpConfig());
        } catch (applyErr) {
          logger.warn(`[IPC] MCP server hot-apply failed after config update: ${applyErr}`);
        }
      }
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set MCP config: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  /**
   * Live status, not just persisted config. The UI must be able to distinguish
   * "running, nobody out there" from "the stack failed to start" — conflating
   * those is what made the mDNS startup crash invisible for so long.
   */
  ipcMain.handle('config:getFleetStatus', () => {
    const cfg = configLoader.getFleetConfig();
    const fallback: FleetStatus = {
      enabled: cfg.enabled, running: false, error: null, addresses: [], allInterfaces: false,
    };
    try {
      return getFleetStatus ? getFleetStatus() : fallback;
    } catch (error) {
      logger.error(`[IPC] Failed to get fleet status: ${error}`);
      return { ...fallback, error: String(error) };
    }
  });

  ipcMain.handle('config:getFleetConfig', () => {
    try {
      return configLoader.getFleetConfig();
    } catch (error) {
      logger.error(`[IPC] Failed to get fleet config: ${error}`);
      return { enabled: false, host: '0.0.0.0', port: 47474 };
    }
  });

  // Mirrors config:setMcpConfig exactly: persist first, then HOT-APPLY the live
  // fleet stack (start/stop/restart the transport + discovery) without an app
  // restart. Apply errors are logged + swallowed — the config WAS persisted, so we
  // still report success (identical to the MCP server contract).
  ipcMain.handle('config:setFleetConfig', async (_event, updates: { enabled?: boolean; host?: string; port?: number }) => {
    try {
      configLoader.setFleetConfig(updates);
      logger.info(`[IPC] Fleet config updated: ${JSON.stringify(updates)}`);
      if (applyFleetConfig) {
        try {
          await applyFleetConfig(configLoader.getFleetConfig());
        } catch (applyErr) {
          logger.warn(`[IPC] Fleet hot-apply failed after config update: ${applyErr}`);
        }
      }
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set fleet config: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:generateMcpToken', async () => {
    try {
      const token = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
      configLoader.setMcpConfig({ authToken: token });
      logger.info('[IPC] Generated new MCP auth token');
      // Hot-apply to running server — don't let failure prevent token from being returned
      if (localhostMcpServer) {
        try {
          await localhostMcpServer.applyConfig(configLoader.getMcpConfig());
        } catch (applyErr) {
          logger.warn(`[IPC] MCP server hot-apply failed after token generation: ${applyErr}`);
        }
      }
      return { success: true, token };
    } catch (error) {
      logger.error(`[IPC] Failed to generate MCP auth token: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:getEscProtectionEnabled', () => {
    try {
      return configLoader.getEscProtectionEnabled();
    } catch (error) {
      logger.error(`[IPC] Failed to get ESC protection setting: ${error}`);
      return true;
    }
  });

  ipcMain.handle('config:setEscProtectionEnabled', (_event, enabled: boolean) => {
    try {
      configLoader.setEscProtectionEnabled(enabled);
      logger.info(`[IPC] ESC protection set to: ${enabled}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set ESC protection: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:getSortPrefs', (_event, area: string) => {
    try {
      return configLoader.getSortPrefs(area as 'sessions' | 'bindings');
    } catch (error) {
      logger.error(`[IPC] Failed to get sort prefs for ${area}: ${error}`);
      return { field: area === 'sessions' ? 'state' : 'button', direction: 'asc' };
    }
  });

  ipcMain.handle('config:setSortPrefs', (_event, area: string, prefs: { field?: string; direction?: 'asc' | 'desc' }) => {
    try {
      configLoader.setSortPrefs(area as 'sessions' | 'bindings', prefs);
      logger.info(`[IPC] Sort prefs for ${area} set to: ${JSON.stringify(prefs)}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set sort prefs for ${area}: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:getPlanFilters', () => {
    try {
      return configLoader.getPlanFilters();
    } catch (error) {
      logger.error(`[IPC] Failed to get plan filters: ${error}`);
      return {
        types: { bug: 'either', feature: 'either', research: 'either', untyped: 'either' },
        statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'either' },
        hasAttachment: { yes: 'either', no: 'either' },
        auto: 'either',
      };
    }
  });

  ipcMain.handle('config:setPlanFilters', (_event, filters: Partial<PlanFilterConfig>) => {
    try {
      configLoader.setPlanFilters(filters);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set plan filters: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:getSessionGroupPrefs', () => {
    try {
      return configLoader.getSessionGroupPrefs();
    } catch (error) {
      logger.error(`[IPC] Failed to get session group prefs: ${error}`);
      return { order: [], collapsed: [] };
    }
  });

  ipcMain.handle('config:setSessionGroupPrefs', (_event, prefs: {
    order: string[];
    collapsed: string[];
    bookmarked?: string[];
    overviewHidden?: string[];
  }) => {
    try {
      configLoader.setSessionGroupPrefs(prefs);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set session group prefs: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:removeBookmarkedDir', (_event, dirPath: string) => {
    try {
      configLoader.removeBookmarkedDir(dirPath);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to remove bookmarked dir: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:getSpawnCommand', (_event, cliType: string) => {
    try {
      const entry = configLoader.getCliTypeEntry(cliType);
      if (!entry) return null;
      return configLoader.getSpawnConfig(cliType);
    } catch (error) {
      logger.error(`[IPC] Failed to get spawn command for ${cliType}: ${error}`);
      return null;
    }
  });

  ipcMain.handle('config:getCliTypeEnv', (_event, cliType: string) => {
    try {
      return configLoader.getCliTypeEntry(cliType)?.env ?? [];
    } catch (error) {
      logger.error(`[IPC] Failed to get CLI type env for ${cliType}: ${error}`);
      return [];
    }
  });

  ipcMain.handle('config:getDpadConfig', () => {
    try {
      return configLoader.getDpadConfig();
    } catch (error) {
      logger.error(`[IPC] Failed to get dpad config: ${error}`);
      return { initialDelay: 400, repeatRate: 120 };
    }
  });

  ipcMain.handle('config:getStickConfig', (_event, stick: string) => {
    try {
      return configLoader.getStickConfig(stick as 'left' | 'right');
    } catch (error) {
      logger.error(`[IPC] Failed to get stick config for ${stick}: ${error}`);
      return { mode: 'disabled', deadzone: 0.25, repeatRate: 100 };
    }
  });

  ipcMain.handle('dialog:openFolder', async (_event) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const options = { properties: ['openDirectory' as const], title: 'Select Working Directory' };
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // The dock schema belongs to the renderer's layout model. Main deliberately
  // treats it as an opaque settings value so an older build can still load
  // settings written by a newer renderer; the renderer validates and falls
  // back before using it.
  ipcMain.handle('config:getWorkspaceLayout', (_event, profile?: WorkspaceLayoutProfile) => {
    try {
      return configLoader.getWorkspaceLayout(profile);
    } catch (error) {
      logger.error(`[IPC] Failed to get workspace layout: ${error}`);
      return undefined;
    }
  });

  ipcMain.handle('config:setWorkspaceLayout', (_event, layout: unknown, profile?: WorkspaceLayoutProfile) => {
    try {
      configLoader.setWorkspaceLayout(layout, profile);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set workspace layout: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:getEditorPrefs', () => {
    try {
      return configLoader.getEditorPrefs();
    } catch (error) {
      logger.error(`[IPC] Failed to get editor prefs: ${error}`);
      return {};
    }
  });

  ipcMain.handle('config:setEditorPrefs', (_event, prefs: Partial<EditorPrefs>) => {
    try {
      configLoader.setEditorPrefs(prefs);
      logger.info(`[IPC] Editor prefs updated: ${JSON.stringify(prefs)}`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set editor prefs: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('dialog:showOpenFile', async (_event, filters?: Electron.FileFilter[]) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: 'Open Plan File',
      filters: filters ?? [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
    };
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:showSaveFile', async (_event, defaultFilename?: string, filters?: Electron.FileFilter[]) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const options: Electron.SaveDialogOptions = {
      title: 'Save Plan File',
      defaultPath: defaultFilename,
      filters: filters ?? [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
    };
    const result = focusedWindow
      ? await dialog.showSaveDialog(focusedWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle('config:setChipbarActions', (_event, actions: Array<{ label: string; sequence: string }>) => {
    try {
      configLoader.setChipbarActions(actions);
      logger.info(`[IPC] Updated chipbar actions: ${actions.length} actions`);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to set chipbar actions: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  // ========================================================================
  // CLI hook integrations (G1: transport only — install/remove/observe)
  // ========================================================================

  /** Resolve a CLI type's hooks block, or null when it has none. */
  const resolveHooks = (cliTypeId: string): { id: string; label: string; hooks: CliHooksIntegration } | null => {
    const entry = configLoader.getCliTypeEntry(cliTypeId);
    if (!entry?.hooks) return null;
    return { id: cliTypeId, label: entry.displayName ?? entry.name, hooks: entry.hooks };
  };

  ipcMain.handle('hooks:getStatus', async () => {
    if (!hookDeps) return { success: false, error: 'Hook installer not wired' };
    try {
      const items: Array<{
        cliTypeId: string;
        label: string;
        status: HookIntegrationStatus;
        provider: string;
        /** G9: false = this CLI can never receive injected reminders on
         *  UserPromptSubmit (Copilot drops that event's output) — the pane
         *  shows the fallback instead of pretending 'hook' is available. */
        canInject: boolean;
      }> = [];
      for (const cliTypeId of configLoader.getCliTypes()) {
        const resolved = resolveHooks(cliTypeId);
        if (!resolved) continue;
        items.push({
          cliTypeId: resolved.id,
          label: resolved.label,
          status: await readHookIntegrationStatus(resolved.hooks, hookDeps),
          provider: resolved.hooks.provider,
          canInject: PROMPT_INJECTION_PROVIDERS.has(resolved.hooks.provider),
        });
      }
      return { success: true, items };
    } catch (error) {
      logger.error(`[IPC] Failed to read hook integration status: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('hooks:install', async (_event, cliTypeId: string) => {
    if (!hookDeps) return { success: false, error: 'Hook installer not wired' };
    try {
      const resolved = resolveHooks(cliTypeId);
      if (!resolved) return { success: false, error: `CLI type has no hooks config: ${cliTypeId}` };
      const result = await installCliHooks(resolved.hooks, hookDeps);
      logger.info(`[IPC] Hook install for ${resolved.label}: ${result.status} (written=${result.written})`);
      return { success: true, ...result };
    } catch (error) {
      logger.error(`[IPC] Failed to install hooks for ${cliTypeId}: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('hooks:uninstall', (_event, cliTypeId: string) => {
    if (!hookDeps) return { success: false, error: 'Hook installer not wired' };
    try {
      const resolved = resolveHooks(cliTypeId);
      if (!resolved) return { success: false, error: `CLI type has no hooks config: ${cliTypeId}` };
      const result = uninstallCliHooks(resolved.hooks, hookDeps);
      logger.info(`[IPC] Hook uninstall for ${resolved.label}: changed=${result.changed}`);
      return { success: true, ...result };
    } catch (error) {
      logger.error(`[IPC] Failed to uninstall hooks for ${cliTypeId}: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  // G5 suggester usage feedback — inspectable and resettable from the pane.
  // The summary is ids and term counts only, by construction of the store.

  // ========================================================================
  // Reminder delivery (G9): per-reminder hook / pty / off, visible and
  // settable from the CLI Integrations pane.
  // ========================================================================

  ipcMain.handle('config:getReminderDelivery', () => {
    try {
      return { success: true, modes: configLoader.getReminderDelivery() };
    } catch (error) {
      logger.error(`[IPC] Failed to read reminder delivery: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('config:setReminderDelivery', (_event, updates: Record<string, unknown>) => {
    try {
      const validated: Partial<Record<ReminderId, ReminderDeliveryMode>> = {};
      for (const id of REMINDER_IDS) {
        const value = updates?.[id];
        if (isReminderDeliveryMode(value)) validated[id] = value;
      }
      configLoader.setReminderDelivery(validated);
      return { success: true, modes: configLoader.getReminderDelivery() };
    } catch (error) {
      logger.error(`[IPC] Failed to set reminder delivery: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('hooks:getSuggestionUsage', () => {
    if (!suggestionUsage) return { success: false, error: 'Suggestion usage store not wired' };
    try {
      return { success: true, usage: summarizeSuggestionUsage(suggestionUsage.snapshot()) };
    } catch (error) {
      logger.error(`[IPC] Failed to read suggestion usage: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('hooks:resetSuggestionUsage', () => {
    if (!suggestionUsage) return { success: false, error: 'Suggestion usage store not wired' };
    try {
      suggestionUsage.reset();
      logger.info('[IPC] Suggestion usage store reset');
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to reset suggestion usage: ${error}`);
      return { success: false, error: String(error) };
    }
  });
}
