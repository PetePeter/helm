import { ipcRenderer } from 'electron';
import type { PtyWriteOptions } from '../../session/delivery-context.js';
import type { DraftPrompt } from '../../types/session.js';
import type { ScheduledTaskHistoryEntry } from '../../types/scheduled-task.js';
import type { RecycleBinEntry } from '../../types/recycle-bin.js';
import type { RuntimeGroup } from '../../types/runtime-group.js';
import type { Artifact } from '../../types/artifact.js';
import type { MessEntry } from '../../types/mess.js';
import type { WorkspaceLayoutProfile } from '../../config/loader.js';
import type { MessHistoryOptions, MessHistoryResult } from '../../session/mess-manager.js';
import {
  createPreloadDomains,
  type HelmPreloadApi,
} from './domain-builders.js';

export const PRELOAD_METHOD_IMPLEMENTATIONS = {
  // ========================================================================
  // Session Management
  // ========================================================================

  /**
   * Set the active session
   */
  sessionSetActive: (id: string) => ipcRenderer.invoke('session:setActive', id),

  /**
   * Get the active session
   */
  sessionGetActive: () => ipcRenderer.invoke('session:getActive'),

  /**
   * Remove a session
   */
  sessionRemove: (id: string) => ipcRenderer.invoke('session:remove', id),

  /**
   * Close a session (kill process and remove)
   */
  sessionClose: (id: string) => ipcRenderer.invoke('session:close', id),

  /**
   * Snap out a session to a child window
   */
  sessionSnapOut: (id: string) => ipcRenderer.invoke('session:snapOut', id),

  /**
   * Snap back a session to the main window
   */
  sessionSnapBack: (id: string) => ipcRenderer.invoke('session:snapBack', id),

  /**
   * Rename a session
   */
  sessionRename: (id: string, newName: string) => ipcRenderer.invoke('session:rename', id, newName),

  /** Set or clear the closure lock. Returns the resulting lock state. */
  sessionSetLocked: (id: string, locked: boolean): Promise<{ success: boolean; locked?: boolean; error?: string }> =>
    ipcRenderer.invoke('session:setLocked', id, locked),

  /**
   * From a snapped-out window: ask the main window to resolve a Ctrl+<n>
   * display slot and focus the owning session's window.
   */
  sessionRequestFocusSlot: (slot: number) => ipcRenderer.invoke('session:requestFocusSlot', slot),

  /**
   * Raise the window that owns a session (main or a child popout).
   */
  sessionFocusWindow: (id: string) => ipcRenderer.invoke('session:focusWindow', id),

  // ========================================================================
  // Configuration
  // ========================================================================

  /**
   * Get all configuration data
   */
  configGetAll: () => ipcRenderer.invoke('config:getAll'),

  /**
   * Get bindings for a specific CLI type
   */
  configGetBindings: (cliType: string) => ipcRenderer.invoke('config:getBindings', cliType),

  /**
   * Get available CLI types
   */
  configGetCliTypes: () => ipcRenderer.invoke('config:getCliTypes'),

/**
   * Get chipbar quick-action buttons for the current profile
   */
  configGetChipbarActions: () => ipcRenderer.invoke('config:getChipbarActions') as Promise<{
    actions: Array<{ label: string; sequence: string }>;
    inboxDir: string;
  }>,

  /**
   * Update chipbar quick-action buttons for the current profile
   */
  configSetChipbarActions: (actions: Array<{ label: string; sequence: string }>) =>
    ipcRenderer.invoke('config:setChipbarActions', actions),

  /**
   * Create or update a named sequence group for a CLI type
   */
  configSetSequenceGroup: (cliType: string, groupId: string, items: Array<{ label: string; sequence: string }>) =>
    ipcRenderer.invoke('config:setSequenceGroup', cliType, groupId, items),

  /**
   * Remove a named sequence group for a CLI type
   */
  configRemoveSequenceGroup: (cliType: string, groupId: string) =>
    ipcRenderer.invoke('config:removeSequenceGroup', cliType, groupId),

  /**
   * Set a binding (for settings screen)
   */
  configSetBinding: (button: string, cliType: string, binding: any) =>
    ipcRenderer.invoke('config:setBinding', button, cliType, binding),

  configRemoveBinding: (button: string, cliType: string) =>
    ipcRenderer.invoke('config:removeBinding', button, cliType),

  configCopyCliBindings: (sourceCli: string, targetCli: string) =>
    ipcRenderer.invoke('config:copyCliBindings', sourceCli, targetCli),

  /**
   * Get haptic feedback setting
   */
  configGetHapticFeedback: () => ipcRenderer.invoke('config:getHapticFeedback'),

  /**
   * Set haptic feedback setting
   */
  configSetHapticFeedback: (enabled: boolean) => ipcRenderer.invoke('config:setHapticFeedback', enabled),

  /**
   * Get notifications setting
   */
  configGetNotifications: () => ipcRenderer.invoke('config:getNotifications'),

  /**
   * Set notifications setting
   */
  configSetNotifications: (enabled: boolean) => ipcRenderer.invoke('config:setNotifications', enabled),

  /**
   * Get localhost MCP server settings
   */
  configGetMcpConfig: () => ipcRenderer.invoke('config:getMcpConfig'),

  /**
   * Update localhost MCP server settings
   */
  configSetMcpConfig: (updates: { enabled?: boolean; port?: number; authToken?: string }) =>
    ipcRenderer.invoke('config:setMcpConfig', updates),

  /**
   * Get cross-machine fleet transport settings (enabled/host/port).
   */
  configGetFleetConfig: () => ipcRenderer.invoke('config:getFleetConfig'),

  /**
   * Live fleet status: whether the stack is actually running, why not if it
   * failed, and the addresses another machine can pair against.
   */
  configGetFleetStatus: () => ipcRenderer.invoke('config:getFleetStatus'),

  /**
   * Update fleet transport settings; the main process persists then hot-applies
   * the live fleet stack (start/stop/restart) without an app restart.
   */
  configSetFleetConfig: (updates: { enabled?: boolean; host?: string; port?: number }) =>
    ipcRenderer.invoke('config:setFleetConfig', updates),

  /**
   * Generate and persist a new localhost MCP auth token
   */
  configGenerateMcpToken: () => ipcRenderer.invoke('config:generateMcpToken'),

  /**
   * Get ESC protection setting
   */
  configGetEscProtectionEnabled: () => ipcRenderer.invoke('config:getEscProtectionEnabled'),

  /**
   * Set ESC protection setting
   */
  configSetEscProtectionEnabled: (enabled: boolean) => ipcRenderer.invoke('config:setEscProtectionEnabled', enabled),

  /**
   * Get sort preferences for an area (sessions or bindings)
   */
  configGetSortPrefs: (area: string) => ipcRenderer.invoke('config:getSortPrefs', area),

  /**
   * Set sort preferences for an area (sessions or bindings)
   */
  configSetSortPrefs: (area: string, prefs: { field?: string; direction?: string }) =>
    ipcRenderer.invoke('config:setSortPrefs', area, prefs),

  /**
   * Get plan filter preferences
   */
  configGetPlanFilters: () =>
    ipcRenderer.invoke('config:getPlanFilters'),

  /**
   * Set plan filter preferences
   */
  configSetPlanFilters: (filters: {
    types?: { bug?: 'either' | 'yes' | 'no'; feature?: 'either' | 'yes' | 'no'; research?: 'either' | 'yes' | 'no'; untyped?: 'either' | 'yes' | 'no' };
    statuses?: { planning?: 'either' | 'yes' | 'no'; ready?: 'either' | 'yes' | 'no'; coding?: 'either' | 'yes' | 'no'; review?: 'either' | 'yes' | 'no'; blocked?: 'either' | 'yes' | 'no'; done?: 'either' | 'yes' | 'no' };
    hasAttachment?: { yes?: 'either' | 'yes' | 'no'; no?: 'either' | 'yes' | 'no' };
    auto?: 'either' | 'yes' | 'no';
  }) =>
    ipcRenderer.invoke('config:setPlanFilters', filters),

  configGetSessionGroupPrefs: () =>
    ipcRenderer.invoke('config:getSessionGroupPrefs') as Promise<{
      order: string[];
      collapsed: string[];
      bookmarked?: string[];
      overviewHidden?: string[];
    }>,

  configSetSessionGroupPrefs: (prefs: {
    order: string[];
    collapsed: string[];
    bookmarked?: string[];
    overviewHidden?: string[];
  }) =>
    ipcRenderer.invoke('config:setSessionGroupPrefs', prefs),

  editorGetHistory: (): Promise<string[]> => ipcRenderer.invoke('editor:getHistory'),
  editorSetHistory: (entries: string[]) => ipcRenderer.invoke('editor:setHistory', entries),

  configRemoveBookmarkedDir: (dirPath: string) =>
    ipcRenderer.invoke('config:removeBookmarkedDir', dirPath),

  /**
   * Get the raw spawn command for a CLI type (for embedded PTY — no terminal wrapper)
   */
  configGetSpawnCommand: (cliType: string) => ipcRenderer.invoke('config:getSpawnCommand', cliType),

  configGetCliTypeEnv: (cliType: string) => ipcRenderer.invoke('config:getCliTypeEnv', cliType),

  configGetDpadConfig: () => ipcRenderer.invoke('config:getDpadConfig'),

  configGetStickConfig: (stick: string) => ipcRenderer.invoke('config:getStickConfig', stick),



  /**
   * Get the renderer-owned versioned dock workspace for a window profile.
   * Omitting the profile keeps the main window's original storage key.
   */
  configGetWorkspaceLayout: (profile?: WorkspaceLayoutProfile) =>
    ipcRenderer.invoke('config:getWorkspaceLayout', profile) as Promise<unknown>,

  /** Persist the renderer-owned versioned dock workspace for a window profile. */
  configSetWorkspaceLayout: (layout: unknown, profile?: WorkspaceLayoutProfile) =>
    ipcRenderer.invoke('config:setWorkspaceLayout', layout, profile),

  configGetEditorPrefs: () => ipcRenderer.invoke('config:getEditorPrefs') as Promise<{
    draftEditorHeight?: number;
    contextEditorHeight?: number;
    planEditorHeight?: number;
    editorPopupWidth?: number;
    editorPopupHeight?: number;
    sequenceModalWidth?: number;
    sequenceModalHeight?: number;
    sequenceModalBounds?: { left: number; top: number; right: number; bottom: number };
  }>,

  configSetEditorPrefs: (prefs: { draftEditorHeight?: number; contextEditorHeight?: number; planEditorHeight?: number; editorPopupWidth?: number; editorPopupHeight?: number; sequenceModalWidth?: number; sequenceModalHeight?: number; sequenceModalBounds?: { left: number; top: number; right: number; bottom: number } }) =>
    ipcRenderer.invoke('config:setEditorPrefs', prefs),

  // ========================================================================
  // PTY Terminal Management
  // ========================================================================

  /** Claim the current renderer as the terminal owner and return PTY replay. */
  terminalAttach: (sessionId: string) =>
    ipcRenderer.invoke('terminal:attach', sessionId) as Promise<{ success: boolean; replay?: string; error?: string }>,

  /** Release the current renderer before a terminal moves to another window. */
  terminalDetach: (sessionId: string) =>
    ipcRenderer.invoke('terminal:detach', sessionId) as Promise<{ success: boolean; error?: string }>,

  /** Spawn a new embedded PTY terminal */
  ptySpawn: (sessionId: string, command: string, args: string[], cwd?: string, cliType?: string, contextText?: string, resumeSessionName?: string) =>
    ipcRenderer.invoke('pty:spawn', sessionId, command, args, cwd, cliType, contextText, resumeSessionName),

  /** Write data to a PTY terminal's stdin */
  ptyWrite: (sessionId: string, data: string, options?: PtyWriteOptions) =>
    ipcRenderer.invoke('pty:write', sessionId, data, options),

  /** Write scroll keys to a PTY without triggering AIAGENT keyword detection */
  ptyScrollInput: (sessionId: string, data: string) =>
    ipcRenderer.invoke('pty:scrollInput', sessionId, data),

  /** Resize a PTY terminal */
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', sessionId, cols, rows),

  /** Suppress activity promotion before terminal switch */
  ptyMarkSwitching: (sessionId: string) =>
    ipcRenderer.invoke('pty:markSwitching', sessionId),

  /** Kill a PTY terminal */
  ptyKill: (sessionId: string) =>
    ipcRenderer.invoke('pty:kill', sessionId),

  /** Subscribe to PTY output data */
  onPtyData: (callback: (sessionId: string, data: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },

  /** Subscribe to PTY exit events */
  onPtyExit: (callback: (sessionId: string, exitCode: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string, exitCode: number) => callback(sessionId, exitCode);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.removeListener('pty:exit', listener);
  },

  /** Subscribe to question detected events */
  onPtyQuestionDetected: (callback: (event: { sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('pty:question-detected', listener);
    return () => ipcRenderer.removeListener('pty:question-detected', listener);
  },

  /** Subscribe to question cleared events */
  onPtyQuestionCleared: (callback: (event: { sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('pty:question-cleared', listener);
    return () => ipcRenderer.removeListener('pty:question-cleared', listener);
  },

  /** Subscribe to activity change events */
  onPtyActivityChange: (callback: (event: { sessionId: string; level: string; lastOutputAt?: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('pty:activity-change', listener);
    return () => ipcRenderer.removeListener('pty:activity-change', listener);
  },

  // ========================================================================
  // Compaction Handover
  // ========================================================================

  /** Drop a pending handover instead of waiting for it to be pasted back */
  handoverCancel: (sessionId: string) => ipcRenderer.invoke('handover:cancel', sessionId),

  /** Whether a session has a handover waiting, and its text */
  handoverPending: (sessionId: string) => ipcRenderer.invoke('handover:pending', sessionId),

  /** Subscribe to a handover becoming pending (terminal should lock) */
  onHandoverArmed: (callback: (event: { sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('handover:armed', listener);
    return () => ipcRenderer.removeListener('handover:armed', listener);
  },

  /** Subscribe to a handover being pasted back (terminal released) */
  onHandoverDelivered: (callback: (event: { sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('handover:delivered', listener);
    return () => ipcRenderer.removeListener('handover:delivered', listener);
  },

  /** Subscribe to a handover being dropped undelivered */
  onHandoverLost: (callback: (event: { sessionId: string; reason: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('handover:lost', listener);
    return () => ipcRenderer.removeListener('handover:lost', listener);
  },

  // ========================================================================
  // Pipeline Queue
  // ========================================================================

  /** Enqueue a session for auto-implementation */
  pipelineEnqueue: (sessionId: string) => ipcRenderer.invoke('pipeline:enqueue', sessionId),

  /** Remove a session from the waiting queue */
  pipelineDequeue: (sessionId: string) => ipcRenderer.invoke('pipeline:dequeue', sessionId),

  /** Get all sessions in the waiting queue */
  pipelineGetQueue: () => ipcRenderer.invoke('pipeline:getQueue'),

  /** Get a session's position in the queue (1-based, 0 if not queued) */
  pipelineGetPosition: (sessionId: string) => ipcRenderer.invoke('pipeline:getPosition', sessionId),

  /** Manually set a session's pipeline state */
  sessionSetState: (sessionId: string, state: string) => ipcRenderer.invoke('session:setState', sessionId, state),

  /** Subscribe to auto-handoff events */
  onPtyHandoff: (callback: (event: { fromSessionId: string; toSessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('pty:handoff', listener);
    return () => ipcRenderer.removeListener('pty:handoff', listener);
  },

  /** Subscribe to notification click events (focus + switch to session) */
  onNotificationClick: (callback: (event: { sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('notification:click', listener);
    return () => ipcRenderer.removeListener('notification:click', listener);
  },

  /** Subscribe to LLM-directed notification bubbles */
  onLlmNotify: (callback: (data: { sessionId: string; title: string; content: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId: string; title: string; content: string }) => callback(data);
    ipcRenderer.on('notification:llmNotify', listener);
    return () => ipcRenderer.removeListener('notification:llmNotify', listener);
  },

  /** Subscribe to flash-attention requests (flash a session/group in the sidebar) */
  onFlashAttention: (callback: (data: { sessionId: string; accentColor: string | null; textColor: string | null }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId: string; accentColor: string | null; textColor: string | null }) => callback(data);
    ipcRenderer.on('session:flashAttention', listener);
    return () => ipcRenderer.removeListener('session:flashAttention', listener);
  },

  /** Subscribe to externally-spawned session events (e.g. from Telegram) */
  onSessionSpawned: (callback: (session: { id: string; name: string; cliType: string; processId: number; workingDir?: string; cliSessionName?: string; lastOutputAt?: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('session:spawned-externally', listener);
    return () => ipcRenderer.removeListener('session:spawned-externally', listener);
  },

  /** Subscribe to session metadata updates such as renames. */
  onSessionUpdated: (callback: (session: { id: string; name: string; cliType: string; workingDir?: string; title?: string; windowId?: number; state?: string; aiagentState?: 'planning' | 'implementing' | 'completed' | 'idle'; lastOutputAt?: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('session:updated', listener);
    return () => ipcRenderer.removeListener('session:updated', listener);
  },

  /** Subscribe to snap-out events */
  onSnapOut: (callback: (sessionId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on('session:snapOut', listener);
    return () => ipcRenderer.removeListener('session:snapOut', listener);
  },

  /** Subscribe to snap-back events */
  onSnapBack: (callback: (sessionId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on('session:snapBack', listener);
    return () => ipcRenderer.removeListener('session:snapBack', listener);
  },

  /** Subscribe to Ctrl+<n> focus-slot requests forwarded from popout windows. */
  onFocusSlot: (callback: (slot: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, slot: number) => callback(slot);
    ipcRenderer.on('session:focusSlot', listener);
    return () => ipcRenderer.removeListener('session:focusSlot', listener);
  },

  /**
   * Get working directory presets from config
   */
  configGetWorkingDirs: () => ipcRenderer.invoke('config:getWorkingDirs'),

  // ========================================================================
  // Project Management
  // ========================================================================

  /** List all project records */
  projectList: () => ipcRenderer.invoke('project:list'),

  /** Get a single project record by ID */
  projectGet: (id: string) => ipcRenderer.invoke('project:get', id),

  /** Create or resolve a project from a canonical directory path */
  projectCreate: (dirPath: string, name?: string) =>
    ipcRenderer.invoke('project:create', dirPath, name),

  /** Update a project's display name */
  projectUpdate: (id: string, patch: { name: string }) =>
    ipcRenderer.invoke('project:update', id, patch),

  /** Delete a project record */
  projectDelete: (id: string) => ipcRenderer.invoke('project:delete', id),

  /** No-op: retained for API compatibility; projects are single-path records. */
  projectAddDir: (id: string, dirPath: string) =>
    ipcRenderer.invoke('project:addDir', id, dirPath),

  /** No-op: retained for API compatibility; projects are single-path records. */
  projectRemoveDir: (id: string, dirPath: string) =>
    ipcRenderer.invoke('project:removeDir', id, dirPath),

  /** No-op: retained for API compatibility; projects are single-path records. */
  projectSetMainDir: (id: string, dirPath: string) =>
    ipcRenderer.invoke('project:setMainDir', id, dirPath),

  /** Read bounded project Mess history without changing any session cursor. */
  messHistory: (projectId: string, options?: MessHistoryOptions): Promise<MessHistoryResult> =>
    ipcRenderer.invoke('mess:history', projectId, options),

  /** Subscribe to project-scoped Mess appends. */
  onMessAppended: (callback: (event: { projectId: string; entry: MessEntry }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { projectId: string; entry: MessEntry }) => callback(data);
    ipcRenderer.on('mess:appended', listener);
    return () => ipcRenderer.removeListener('mess:appended', listener);
  },

  // ========================================================================
  // Skills
  // ========================================================================

  skillList: () => ipcRenderer.invoke('skill:list'),
  skillGet: (id: string) => ipcRenderer.invoke('skill:get', id),
  skillGetStats: (id: string) => ipcRenderer.invoke('skill:getStats', id),
  skillSubmitFeedback: (id: string, stars: number, summary: string, improvement?: string) =>
    ipcRenderer.invoke('skill:submitFeedback', id, stars, summary, improvement),
  skillClearReviews: (id: string) => ipcRenderer.invoke('skill:clearReviews', id),
  skillResetUseCount: (id: string) => ipcRenderer.invoke('skill:resetUseCount', id),
  skillResetAllCounts: () => ipcRenderer.invoke('skill:resetAllCounts'),
  skillCreate: (input: { name: string; description?: string; body?: string; aiAmendable?: boolean; allProjects?: boolean; projectIds?: string[] }) =>
    ipcRenderer.invoke('skill:create', input),
  skillUpdate: (id: string, updates: { name?: string; description?: string; body?: string; aiAmendable?: boolean; allProjects?: boolean; projectIds?: string[] }) =>
    ipcRenderer.invoke('skill:update', id, updates),
  skillDelete: (id: string) => ipcRenderer.invoke('skill:delete', id),
  skillClone: (id: string) => ipcRenderer.invoke('skill:clone', id),

  // ========================================================================
  // Tools CRUD
  // ========================================================================

  toolsGetAll: () => ipcRenderer.invoke('tools:getAll'),
  toolsAddCliType: (
    key: string, name: string,
    initialPrompt: Array<{label: string; sequence: string}>, initialPromptDelay: number,
    options?: {
      env?: Array<{ name: string; value: string }>;
      handoffCommand?: string;
      renameCommand?: string;
      spawnCommand?: string;
      resumeCommand?: string;
      continueCommand?: string;
      helmPreambleForInterSession?: boolean;
      largeTextAsTempFile?: boolean;
      submitSuffix?: string;
      helmActions?: { clear?: string; compact?: string; export?: string };
    },
  ) => ipcRenderer.invoke('tools:addCliType', key, name, initialPrompt, initialPromptDelay, options),
  toolsUpdateCliType: (
    key: string, name: string,
    initialPrompt: Array<{label: string; sequence: string}>, initialPromptDelay: number,
    options?: {
      env?: Array<{ name: string; value: string }>;
      handoffCommand?: string;
      renameCommand?: string;
      spawnCommand?: string;
      resumeCommand?: string;
      continueCommand?: string;
      helmPreambleForInterSession?: boolean;
      largeTextAsTempFile?: boolean;
      submitSuffix?: string;
      helmActions?: { clear?: string; compact?: string; export?: string };
    },
  ) => ipcRenderer.invoke('tools:updateCliType', key, name, initialPrompt, initialPromptDelay, options),
  toolsRemoveCliType: (key: string) => ipcRenderer.invoke('tools:removeCliType', key),
  toolsReorderCliType: (index: number, direction: 'up' | 'down') =>
    ipcRenderer.invoke('tools:reorderCliType', index, direction),
  toolsGetPatterns: (cliType: string) => ipcRenderer.invoke('tools:getPatterns', cliType),
  toolsAddPattern: (cliType: string, rule: object) => ipcRenderer.invoke('tools:addPattern', cliType, rule),
  toolsUpdatePattern: (cliType: string, index: number, rule: object) => ipcRenderer.invoke('tools:updatePattern', cliType, index, rule),
  toolsRemovePattern: (cliType: string, index: number) => ipcRenderer.invoke('tools:removePattern', cliType, index),
  patternCancelSchedule: (sessionId: string) => ipcRenderer.invoke('pattern:cancelSchedule', sessionId),

  // ========================================================================
  // Voice Keyboard (OS-level key events for voice bindings)
  // ========================================================================

  /**
   * Tap a single key (voice binding tap mode)
   */
  keyboardKeyTap: (key: string) => ipcRenderer.invoke('keyboard:keyTap', key),

  /**
   * Tap a key combo (voice binding tap mode with modifiers)
   */
  keyboardSendKeyCombo: (keys: string[]) => ipcRenderer.invoke('keyboard:sendKeyCombo', keys),

  /**
   * Hold keys down (for hold bindings)
   */
  keyboardComboDown: (keys: string[]) => ipcRenderer.invoke('keyboard:comboDown', keys),

  /**
   * Release held keys
   */
  keyboardComboUp: (keys: string[]) => ipcRenderer.invoke('keyboard:comboUp', keys),

  // ========================================================================
  // System
  // ========================================================================

  systemOpenLogsFolder: () => ipcRenderer.invoke('system:openLogsFolder'),
  systemOpenHelp: () => ipcRenderer.invoke('help:open'),
  systemOpenExternalUrl: (url: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('system:openExternalUrl', url),

  /** Get app version from package.json via Electron */
  appGetVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

  /** Notify the main process that the renderer has finished startup. */
  appStartupReady: (): Promise<void> => {
    ipcRenderer.send('app:startupReady');
    return Promise.resolve();
  },

  /** Confirm or cancel a main-process close request. */
  appConfirmClose: (confirmed: boolean): Promise<void> => {
    ipcRenderer.send('app:close-confirm-response', confirmed);
    return Promise.resolve();
  },

  /** Open external editor (Notepad) for prompt composition */
  editorOpenExternal: (): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('editor:openExternal'),

  /** Write text to a temp file for draft/plan apply — returns file path on success */
  writeTempContent: (content: string): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('temp:writeContent', content),

  /** Delete a temp file (best-effort cleanup after apply) */
  deleteTemp: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('temp:deleteContent', filePath),

  // ========================================================================
  // Dialog
  // ========================================================================

  /** Open a native OS folder picker and return the selected path (or null if cancelled) */
  dialogOpenFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),

  // ========================================================================
  // Telegram Bot
  // ========================================================================

  /** Get telegram bot configuration */
  telegramGetConfig: () => ipcRenderer.invoke('telegram:getConfig'),

  /** Update telegram bot configuration (partial merge) */
  telegramSetConfig: (updates: Record<string, unknown>) => ipcRenderer.invoke('telegram:setConfig', updates),

  /** Start the telegram bot */
  telegramStart: () => ipcRenderer.invoke('telegram:start'),

  /** Stop the telegram bot */
  telegramStop: () => ipcRenderer.invoke('telegram:stop'),

  /** Check if telegram bot is running */
  telegramIsRunning: () => ipcRenderer.invoke('telegram:isRunning'),

  /** Test telegram bot connection (validates token) */
  telegramTestConnection: () => ipcRenderer.invoke('telegram:testConnection'),

  // ========================================================================
  // Draft Prompts
  // ========================================================================

  /** Create a new draft prompt for a session */
  draftCreate: (sessionId: string, label: string, text: string) =>
    ipcRenderer.invoke('draft:create', sessionId, label, text) as Promise<DraftPrompt>,

  /** Update an existing draft */
  draftUpdate: (draftId: string, updates: { label?: string; text?: string }) =>
    ipcRenderer.invoke('draft:update', draftId, updates) as Promise<DraftPrompt | null>,

  /** Delete a draft */
  draftDelete: (draftId: string) =>
    ipcRenderer.invoke('draft:delete', draftId),

  /** Get all drafts for a session */
  draftList: (sessionId: string) =>
    ipcRenderer.invoke('draft:list', sessionId),

  /** Get draft count for a session */
  draftCount: (sessionId: string) =>
    ipcRenderer.invoke('draft:count', sessionId),

  // ─── Directory Plans ────────────────────────────────────

  /** Get all plan items for a directory */
  planList: (dirPath: string) =>
    ipcRenderer.invoke('plan:list', dirPath),

  /** Create a new plan item */
  planCreate: (dirPath: string, title: string, description: string, type?: 'bug' | 'feature' | 'research', autoImplement?: boolean) =>
    ipcRenderer.invoke('plan:create', dirPath, title, description, type, autoImplement),

  /** Update a plan item's title, description, and/or type */
  planUpdate: (id: string, updates: { title?: string; description?: string; type?: 'bug' | 'feature' | 'research'; autoImplement?: boolean }) =>
    ipcRenderer.invoke('plan:update', id, updates),

  /** Delete a plan item */
  planDelete: (id: string) =>
    ipcRenderer.invoke('plan:delete', id),

  /** Delete all completed (done) plan items for a directory */
  planClearCompleted: (dirPath: string): Promise<number> =>
    ipcRenderer.invoke('plan:clearCompleted', dirPath),

  /** Add a dependency edge (fromId must finish before toId can start) */
  planAddDep: (fromId: string, toId: string) =>
    ipcRenderer.invoke('plan:addDep', fromId, toId),

  /** Remove a dependency edge */
  planRemoveDep: (fromId: string, toId: string) =>
    ipcRenderer.invoke('plan:removeDep', fromId, toId),

  /** Apply a ready plan to coding state (ready → coding) */
  planApply: (id: string) =>
    ipcRenderer.invoke('plan:apply', id),

  /** Mark a coding or review plan as complete (coding/review → done) */
  planComplete: (id: string, completionNotes?: string) =>
    ipcRenderer.invoke('plan:complete', id, completionNotes),

  /** Reopen a done plan back to ready or planning */
  planReopen: (id: string) =>
    ipcRenderer.invoke('plan:reopen', id),

  /** Manually set a plan state and optional context */
  planSetState: (
    id: string,
    status: 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done',
    stateInfo?: string,
  ) => ipcRenderer.invoke('plan:setState', id, status, stateInfo),

  /** Get ready plans for a directory */
  planStartableForDir: (dirPath: string) =>
    ipcRenderer.invoke('plan:startableForDir', dirPath),

  /** Get plans claimed by a specific session */
  planDoingForSession: (sessionId: string) =>
    ipcRenderer.invoke('plan:doingForSession', sessionId),

  /** Get all active plans for a directory across sessions */
  planGetAllDoingForDir: (dirPath: string) =>
    ipcRenderer.invoke('plan:getAllDoingForDir', dirPath),

  /** Get all dependencies for a directory */
  planDeps: (dirPath: string) =>
    ipcRenderer.invoke('plan:deps', dirPath),

  /** Get a single plan item by ID */
  planGetItem: (id: string) =>
    ipcRenderer.invoke('plan:getItem', id),

  /** Get plan sequences for a directory */
  planSequenceList: (dirPath: string) =>
    ipcRenderer.invoke('plan:sequence-list', dirPath),

  /** Create a plan sequence */
  planSequenceCreate: (dirPath: string, title: string, missionStatement = '', sharedMemory = '') =>
    ipcRenderer.invoke('plan:sequence-create', dirPath, title, missionStatement, sharedMemory),

  /** Update a plan sequence */
  planSequenceUpdate: (
    id: string,
    updates: { title?: string; missionStatement?: string; sharedMemory?: string; order?: number },
  ) => ipcRenderer.invoke('plan:sequence-update', id, updates),

  /** Delete a plan sequence */
  planSequenceDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:sequence-delete', id),

  /** Assign or unassign a plan from a sequence */
  planSequenceAssign: (planId: string, sequenceId: string | null) =>
    ipcRenderer.invoke('plan:sequence-assign', planId, sequenceId),

  /** Bulk-assign multiple plans to a sequence (or unassign with null) */
  planBulkAssignSequence: (planIds: string[], sequenceId: string | null) =>
    ipcRenderer.invoke('plan:bulkAssignSequence', planIds, sequenceId),

  /** Delete a sequence and hard-delete all its member plan items */
  planSequenceDeleteWithPlans: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:sequence-delete-with-plans', id),

  /** List context nodes for a directory */
  planContextList: (dirPath: string) =>
    ipcRenderer.invoke('plan:context-list', dirPath),

  /** Create a context node */
  planContextCreate: (
    dirPath: string,
    input: { title: string; type?: string; permission?: 'readonly' | 'writable'; content?: string; x?: number | null; y?: number | null },
  ) => ipcRenderer.invoke('plan:context-create', dirPath, input),

  /** Update a context node */
  planContextUpdate: (
    id: string,
    updates: { title?: string; type?: string; permission?: 'readonly' | 'writable'; content?: string; x?: number | null; y?: number | null },
  ) => ipcRenderer.invoke('plan:context-update', id, updates),

  /** Delete a context node */
  planContextDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:context-delete', id),

  /** Get one context node */
  planContextGet: (id: string) =>
    ipcRenderer.invoke('plan:context-get', id),

  /** Persist the X/Y position of a context node */
  planContextSetPosition: (id: string, x: number | null, y: number | null) =>
    ipcRenderer.invoke('plan:context-set-position', id, x, y),

  /** Bind a context node to a sequence or plan */
  planContextBind: (id: string, targetType: 'sequence' | 'plan', targetId: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:context-bind', id, targetType, targetId),

  /** Unbind a context node from a sequence or plan */
  planContextUnbind: (id: string, targetType: 'sequence' | 'plan', targetId: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:context-unbind', id, targetType, targetId),

  /** List files attached to a plan */
  planAttachmentList: (planId: string) =>
    ipcRenderer.invoke('plan:attachment-list', planId),

  /** Check which plan IDs have any attachments */
  planAttachmentHasAny: (planIds: string[]): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('plan:attachment-has-any', planIds),

  /** Copy a local file into plan-owned attachment storage */
  planAttachmentAddFile: (planId: string, filePath: string) =>
    ipcRenderer.invoke('plan:attachment-add-file', planId, filePath),

  /** Delete a stored plan attachment */
  planAttachmentDelete: (planId: string, attachmentId: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:attachment-delete', planId, attachmentId),

  /** Copy an attachment to a temp file and open it with the OS default handler */
  planAttachmentOpen: (planId: string, attachmentId: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:attachment-open', planId, attachmentId),

  /** List files in the incoming plans folder */
  planIncomingList: (): Promise<string[]> =>
    ipcRenderer.invoke('plan:incoming-list'),

  /** Delete a file from the incoming plans folder */
  planIncomingDelete: (filename: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:incoming-delete', filename),

  /** Open an incoming plan file with the OS default handler */
  planIncomingOpen: (filename: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:incoming-open', filename),

  /** Export a single plan item as JSON string */
  planExportItem: (planId: string): Promise<string | null> =>
    ipcRenderer.invoke('plan:export-item', planId),

  /** Export an entire directory's plans as JSON string */
  planExportDirectory: (dirPath: string): Promise<string | null> =>
    ipcRenderer.invoke('plan:export-directory', dirPath),

  /** Open a plan as a read-only Markdown file via the OS default handler */
  planOpenExternal: (planId: string): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('plan:open-external', planId),

  // ========================================================================
  // Renderer-safe durable memories
  //
  // The optional trailing sessionId is the session the caller is rendering. Main
  // still enforces ownership; passing the id only pins the request to the
  // session the view actually asked about, so a session switch mid-flight cannot
  // resolve the answer against a different project.
  // ========================================================================

  memoryList: (sessionId?: string) => ipcRenderer.invoke('memory:list', sessionId),
  memoryGet: (memoryId: string, sessionId?: string) => ipcRenderer.invoke('memory:get', memoryId, sessionId),
  memorySearch: (query: string, options?: { regex?: boolean; graphDepth?: number }, sessionId?: string) =>
    ipcRenderer.invoke('memory:search', query, options, sessionId),
  memoryGraph: (rootId: string, graphDepth?: number, sessionId?: string) =>
    ipcRenderer.invoke('memory:graph', rootId, graphDepth, sessionId),
  /** Whole owned forest — every memory and edge, including unlinked memories. */
  memoryGraphAll: (sessionId?: string) => ipcRenderer.invoke('memory:graph-all', sessionId),
  memoryExport: (format: 'markdown' | 'json', rootId?: string, graphDepth?: number, sessionId?: string) =>
    ipcRenderer.invoke('memory:export', format, rootId, graphDepth, sessionId),
  memoryDelete: (memoryId: string, sessionId?: string): Promise<boolean> =>
    ipcRenderer.invoke('memory:delete', memoryId, sessionId),
  memoryAttachmentList: (memoryId: string, sessionId?: string) =>
    ipcRenderer.invoke('memory:attachment-list', memoryId, sessionId),
  memoryAttachmentOpen: (memoryId: string, attachmentId: string, sessionId?: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('memory:attachment-open', memoryId, attachmentId, sessionId),
  memoryAttachmentDelete: (memoryId: string, attachmentId: string, sessionId?: string): Promise<boolean> =>
    ipcRenderer.invoke('memory:attachment-delete', memoryId, attachmentId, sessionId),

  /** Read a local file and return its content as a string */
  planReadFile: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke('plan:read-file', filePath),

  /** Write content to a local file (creates parent directories) */
  planWriteFile: (filePath: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('plan:write-file', filePath, content),

  /** Open a detached planner window for a directory. */
  planPopOut: (dirPath: string): Promise<{ success: boolean; windowId?: number; reused?: boolean; error?: string }> =>
    ipcRenderer.invoke('plan:popOut', dirPath),

  // ───────────────────────────────────────────────────────────────────────────

  /** Open a file picker dialog and return the chosen path */
  dialogShowOpenFile: (filters?: { name: string; extensions: string[] }[]): Promise<string | null> =>
    ipcRenderer.invoke('dialog:showOpenFile', filters),

  /** Open a save dialog and return the chosen path */
  dialogShowSaveFile: (defaultFilename?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> =>
    ipcRenderer.invoke('dialog:showSaveFile', defaultFilename, filters),

  /** Subscribe to plan change events */
  onPlanChanged: (callback: (dirPath: string) => void) => {
    const listener = (_event: unknown, dirPath: string) => callback(dirPath);
    ipcRenderer.on('plan:changed', listener);
    return () => ipcRenderer.removeListener('plan:changed', listener);
  },

  /** Subscribe to successful incoming plan import notifications */
  onPlanIncomingImported: (callback: (event: { filename: string; title: string; dirPath: string }) => void) => {
    const listener = (_event: unknown, data: { filename: string; title: string; dirPath: string }) => callback(data);
    ipcRenderer.on('plan:incoming-imported', listener);
    return () => ipcRenderer.removeListener('plan:incoming-imported', listener);
  },

  /** Subscribe to incoming plan import error notifications */
  onPlanIncomingError: (callback: (event: { filename: string; error: string; filePath: string }) => void) => {
    const listener = (_event: unknown, data: { filename: string; error: string; filePath: string }) => callback(data);
    ipcRenderer.on('plan:incoming-error', listener);
    return () => ipcRenderer.removeListener('plan:incoming-error', listener);
  },

  /** Subscribe to incoming plan error cleared notifications (file fixed or removed) */
  onPlanIncomingErrorCleared: (callback: (event: { filename: string }) => void) => {
    const listener = (_event: unknown, data: { filename: string }) => callback(data);
    ipcRenderer.on('plan:incoming-error-cleared', listener);
    return () => ipcRenderer.removeListener('plan:incoming-error-cleared', listener);
  },

  /** Subscribe to project registry changes. */
  onProjectChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('project:changed', listener);
    return () => ipcRenderer.removeListener('project:changed', listener);
  },

  onPatternScheduleCreated: (callback: (event: { sessionId: string; scheduledAt: string; ruleIndex: number }) => void) => {
    const listener = (_e: unknown, event: { sessionId: string; scheduledAt: string; ruleIndex: number }) => callback(event);
    ipcRenderer.on('pattern:schedule-created', listener);
    return () => ipcRenderer.removeListener('pattern:schedule-created', listener);
  },

  onPatternScheduleFired: (callback: (event: { sessionId: string }) => void) => {
    const listener = (_e: unknown, event: { sessionId: string }) => callback(event);
    ipcRenderer.on('pattern:schedule-fired', listener);
    return () => ipcRenderer.removeListener('pattern:schedule-fired', listener);
  },

  onPatternScheduleCancelled: (callback: (event: { sessionId: string }) => void) => {
    const listener = (_e: unknown, event: { sessionId: string }) => callback(event);
    ipcRenderer.on('pattern:schedule-cancelled', listener);
    return () => ipcRenderer.removeListener('pattern:schedule-cancelled', listener);
  },

  // ========================================================================
  // Scheduled Tasks
  // ========================================================================

  /** Create a new scheduled task */
  scheduledTaskCreate: (params: {
    title: string;
    description?: string;
    planIds: string[];
    initialPrompt: string;
    cliType: string;
    cliParams?: string;
    scheduledTime: Date;
    scheduleKind?: 'once' | 'interval' | 'cron';
    intervalMs?: number;
    cronExpression?: string;
    endDate?: Date;
    dirPath: string;
    mode?: 'spawn' | 'direct';
    targetSessionId?: string;
  }) => ipcRenderer.invoke('scheduled_task:create', params),

  /** List all scheduled tasks */
  scheduledTaskList: () => ipcRenderer.invoke('scheduled_task:list'),

  /** Get a single scheduled task by ID */
  scheduledTaskGet: (id: string) => ipcRenderer.invoke('scheduled_task:get', id),

  /** Update a pending scheduled task */
  scheduledTaskUpdate: (id: string, updates: {
    title?: string;
    description?: string;
    planIds?: string[];
    initialPrompt?: string;
    cliType?: string;
    cliParams?: string;
    scheduledTime?: Date;
    scheduleKind?: 'once' | 'interval' | 'cron';
    intervalMs?: number;
    cronExpression?: string;
    endDate?: Date;
    dirPath?: string;
    mode?: 'spawn' | 'direct';
    targetSessionId?: string;
    enabled?: boolean;
    userPrompt?: string;
  }) => ipcRenderer.invoke('scheduled_task:update', id, updates),

  /** Fire a pending scheduled task now as an extra run, leaving its schedule intact */
  scheduledTaskRunNow: (id: string): Promise<boolean> => ipcRenderer.invoke('scheduled_task:runNow', id),

  /** Cancel a pending scheduled task */
  scheduledTaskCancel: (id: string) => ipcRenderer.invoke('scheduled_task:cancel', id),

  /** Delete a scheduled task */
  scheduledTaskDelete: (id: string) => ipcRenderer.invoke('scheduled_task:delete', id),

  /** List all scheduled task history entries (newest run first) */
  scheduledTaskListHistory: (): Promise<ScheduledTaskHistoryEntry[]> => ipcRenderer.invoke('scheduled_task:listHistory'),

  /** Remove all scheduled task history entries */
  scheduledTaskClearHistory: (): Promise<void> => ipcRenderer.invoke('scheduled_task:clearHistory'),

  /** Subscribe to scheduled task change events */
  onScheduledTaskChanged: (callback: (task: { id: string; title: string; status: string }) => void) => {
    const listener = (_e: unknown, task: { id: string; title: string; status: string }) => callback(task);
    ipcRenderer.on('scheduled-task:changed', listener);
    return () => ipcRenderer.removeListener('scheduled-task:changed', listener);
  },

  /** Subscribe to scheduled task history change events */
  onScheduledTaskHistoryChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('scheduled-task-history:changed', listener);
    return () => ipcRenderer.removeListener('scheduled-task-history:changed', listener);
  },

  // ========================================================================
  // Recycle Bin (closed recoverable sessions)
  // ========================================================================

  /** List recoverable closed sessions (newest close first) */
  recycleBinList: (): Promise<RecycleBinEntry[]> => ipcRenderer.invoke('recycleBin:list'),

  /** Peek an entry (no removal) so the caller can re-spawn with resume, then commit */
  recycleBinRestore: (id: string): Promise<RecycleBinEntry | null> => ipcRenderer.invoke('recycleBin:restore', id),

  /** Commit a restore: remove the entry after a successful re-spawn (artifacts kept) */
  recycleBinCommitRestore: (id: string): Promise<boolean> => ipcRenderer.invoke('recycleBin:commitRestore', id),

  /** Forget (permanently delete) a single entry */
  recycleBinForget: (id: string): Promise<boolean> => ipcRenderer.invoke('recycleBin:forget', id),

  /** Empty the bin */
  recycleBinEmpty: (): Promise<boolean> => ipcRenderer.invoke('recycleBin:empty'),

  /** Subscribe to recycle-bin change events */
  onRecycleBinChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('recycle-bin:changed', listener);
    return () => ipcRenderer.removeListener('recycle-bin:changed', listener);
  },

  // ========================================================================
  // Artifacts (versioned renderable session outputs; AI-authored via MCP)
  // ========================================================================

  /** List a session's artifacts (newest-updated first) */
  artifactList: (sessionId: string): Promise<Artifact[]> => ipcRenderer.invoke('artifact:list', sessionId),

  /** Version-agnostic artifact count per session (for session-card badges) */
  artifactCounts: (): Promise<Record<string, number>> => ipcRenderer.invoke('artifact:counts'),

  /** Get a single artifact by id (or null if unknown) */
  artifactGet: (artifactId: string): Promise<Artifact | null> => ipcRenderer.invoke('artifact:get', artifactId),

  /** Stage a built HTML artifact document for helm-artifact://; returns its nonce */
  artifactPrepareRender: (html: string): Promise<string> => ipcRenderer.invoke('artifact:prepareRender', html),

  /** Delete a single artifact by id */
  artifactDelete: (artifactId: string): Promise<boolean> => ipcRenderer.invoke('artifact:delete', artifactId),

  /** Delete every artifact owned by a session */
  artifactDeleteAll: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('artifact:deleteAll', sessionId),

  /** Bring an artifact forward in the viewer without mutating it */
  artifactReveal: (artifactId: string): Promise<boolean> => ipcRenderer.invoke('artifact:reveal', artifactId),

  /** Export an artifact's latest version to a user-chosen file; returns the path or null */
  artifactExport: (artifactId: string): Promise<string | null> => ipcRenderer.invoke('artifact:export', artifactId),

  /** Open one artifact version in the OS default app via a read-only temp copy */
  artifactOpenExternal: (artifactId: string, version?: number): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('artifact:openExternal', artifactId, version),

  /** Create a manual text/markdown artifact */
  artifactCreateText: (sessionId: string, title: string, content: string, kind?: 'markdown' | 'html'): Promise<Artifact> =>
    ipcRenderer.invoke('artifact:createText', sessionId, title, content, kind),

  /** Create a manual artifact from a base64-encoded file */
  artifactCreateWithFile: (sessionId: string, input: {
    filename: string;
    contentBase64: string;
    contentType?: string;
  }): Promise<{ artifact: Artifact; attachment: { id: string } }> =>
    ipcRenderer.invoke('artifact:createWithFile', sessionId, input),

  /** Open a native file picker and read the selected file; returns base64 content or null */
  artifactPickAndReadFile: (): Promise<{
    filename: string;
    contentBase64: string;
    contentType?: string;
  } | null> => ipcRenderer.invoke('artifact:pickAndReadFile'),

  /** Rename an artifact */
  artifactRename: (artifactId: string, newTitle: string): Promise<boolean> =>
    ipcRenderer.invoke('artifact:rename', artifactId, newTitle),

  /** Save an edited artifact body as a new version. Null when refused/unknown. */
  artifactUpdate: (artifactId: string, content: string): Promise<Artifact | null> =>
    ipcRenderer.invoke('artifact:update', artifactId, content),

  /** Open an attachment file in the system's default app */
  artifactOpenAttachment: (artifactId: string, attachmentId: string): Promise<boolean> =>
    ipcRenderer.invoke('artifact:openAttachment', artifactId, attachmentId),

  /** Subscribe to artifact mutation events for a session */
  onArtifactChanged: (callback: (event: { sessionId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => callback(data);
    ipcRenderer.on('artifact:changed', listener);
    return () => ipcRenderer.removeListener('artifact:changed', listener);
  },

  /** Subscribe to durable-memory invalidation for the owning session. */
  onMemoryChanged: (callback: (event: { sessionId?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId?: string }) => callback(data);
    ipcRenderer.on('memory:changed', listener);
    return () => ipcRenderer.removeListener('memory:changed', listener);
  },

  /** Subscribe to artifact reveal (bring-forward) events */
  onArtifactReveal: (callback: (event: { sessionId: string; artifactId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { sessionId: string; artifactId: string }) => callback(data);
    ipcRenderer.on('artifact:reveal', listener);
    return () => ipcRenderer.removeListener('artifact:reveal', listener);
  },

  // ========================================================================
  // Runtime Session Groups
  // ========================================================================

  /** List all runtime groups in display order */
  runtimeGroupList: (): Promise<RuntimeGroup[]> => ipcRenderer.invoke('runtimeGroup:list'),

  /** Create a new empty runtime group */
  runtimeGroupCreate: (name: string): Promise<RuntimeGroup | null> =>
    ipcRenderer.invoke('runtimeGroup:create', name),

  /** Rename a runtime group */
  runtimeGroupRename: (id: string, name: string): Promise<RuntimeGroup | null> =>
    ipcRenderer.invoke('runtimeGroup:rename', id, name),

  /** Set a runtime group's collapsed state */
  runtimeGroupSetCollapsed: (id: string, collapsed: boolean): Promise<boolean> =>
    ipcRenderer.invoke('runtimeGroup:setCollapsed', id, collapsed),

  /** Add a session to a group (exclusive membership) */
  runtimeGroupAddSession: (groupId: string, sessionId: string): Promise<RuntimeGroup | null> =>
    ipcRenderer.invoke('runtimeGroup:addSession', groupId, sessionId),

  /** Remove a session from every group */
  runtimeGroupRemoveSession: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('runtimeGroup:removeSession', sessionId),

  /** Delete a runtime group entirely */
  runtimeGroupCloseGroup: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('runtimeGroup:closeGroup', id),

  /** Re-attach a restored session to its original runtime group (recreates if needed) */
  runtimeGroupReattach: (
    entry: { runtimeGroupId?: string; runtimeGroupName?: string },
    sessionId: string,
  ): Promise<boolean> => ipcRenderer.invoke('runtimeGroup:reattach', entry, sessionId),

  /** Subscribe to runtime-group change events */
  onRuntimeGroupChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('runtime-group:changed', listener);
    return () => ipcRenderer.removeListener('runtime-group:changed', listener);
  },

  // ========================================================================
  // Prompt Templates
  // ========================================================================

  /** Get the full prompt-template tree */
  promptTemplateList: () => ipcRenderer.invoke('prompt-template:list'),

  /** Get a single node (folder or template) by id */
  promptTemplateGetNode: (id: string) => ipcRenderer.invoke('prompt-template:getNode', id),

  /** Create a folder (root-level if parentId omitted) */
  promptTemplateCreateFolder: (name: string, parentId?: string | null) =>
    ipcRenderer.invoke('prompt-template:createFolder', name, parentId ?? null),

  /** Create a template (root-level if parentId omitted) */
  promptTemplateCreateTemplate: (name: string, body: string, parentId?: string | null) =>
    ipcRenderer.invoke('prompt-template:createTemplate', name, body, parentId ?? null),

  /** Update a template's name and/or body */
  promptTemplateUpdate: (id: string, changes: { name?: string; body?: string }) =>
    ipcRenderer.invoke('prompt-template:update', id, changes),

  /** Rename any node (folder or template) */
  promptTemplateRename: (id: string, name: string) =>
    ipcRenderer.invoke('prompt-template:rename', id, name),

  /** Delete nodes (cascades for folders) */
  promptTemplateDelete: (ids: string[]) =>
    ipcRenderer.invoke('prompt-template:delete', ids),

  /** Move a node to a new parent folder (or root via null) */
  promptTemplateMove: (id: string, newParentId?: string | null) =>
    ipcRenderer.invoke('prompt-template:move', id, newParentId ?? null),

  /** Reorder a node among its siblings */
  promptTemplateReorder: (id: string, newOrder: number) =>
    ipcRenderer.invoke('prompt-template:reorder', id, newOrder),

  /** Subscribe to prompt-template change events */
  onPromptTemplateChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('prompt-template:changed', listener);
    return () => ipcRenderer.removeListener('prompt-template:changed', listener);
  },

  /** Subscribe to main-process requests to confirm closing the app window. */
  onAppCloseRequest: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('app:close-request', listener);
    return () => ipcRenderer.removeListener('app:close-request', listener);
  },

  // ========================================================================
  // Peers — SAS pairing (discovery + pairing lifecycle). UI in P-0650.
  // The 6-digit SAS is surfaced ONLY for the user to compare on both screens.
  // ========================================================================

  /** LAN peers currently discovered via mDNS (presence only — no access) */
  peerListDiscovered: (): Promise<Array<{ machineId: string; alias: string; address: string }>> =>
    ipcRenderer.invoke('peer:listDiscovered'),

  /** Start a SAS pairing session with a discovered peer (by machineId) */
  peerStartPairing: (machineId: string): Promise<{ ok: boolean; sessionId?: string; reason?: string }> =>
    ipcRenderer.invoke('peer:startPairing', machineId),

  /** Start a SAS pairing session with a typed-in host:port (no mDNS needed) */
  peerStartPairingByAddress: (address: string): Promise<{ ok: boolean; sessionId?: string; reason?: string }> =>
    ipcRenderer.invoke('peer:startPairingByAddress', address),

  /** The user's ONE accept/reject decision (did the two codes match?) */
  peerConfirmPairing: (sessionId: string, accepted: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('peer:confirmPairing', sessionId, accepted),

  /** Cancel the active pairing session */
  peerCancelPairing: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('peer:cancelPairing'),

  /** Whether cross-machine fleet is wired at all (tab renders a hint when off). */
  peerFleetEnabled: (): Promise<boolean> => ipcRenderer.invoke('peer:fleetEnabled'),

  /** Configured peers with live online status + enable flag. Empty when fleet is off. */
  peerList: (): Promise<Array<{
    id: string;
    machineId?: string;
    alias: string;
    address: string;
    direction: 'inbound' | 'outbound' | 'bidirectional';
    allow: string[];
    enabled: boolean;
    online: boolean;
  }>> => ipcRenderer.invoke('peer:list'),

  /** Replace a peer's tool-name allow-list (glob patterns). Persists + re-authorizes. */
  peerSetAllowList: (peerId: string, allow: string[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('peer:setAllowList', peerId, allow),

  /** Toggle whether a peer is dialled by the fleet transport. */
  peerSetEnabled: (peerId: string, enabled: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('peer:setEnabled', peerId, enabled),

  /** Remove a peer entirely — config + secret + pinned cert. */
  peerUnpair: (peerId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('peer:unpair', peerId),

  /** Recent proxied-call audit entries (last 7 days, newest first). */
  peerGetAudit: (): Promise<Array<{
    id: string;
    peerId: string;
    method: string;
    argSummary: string;
    outcome: 'ok' | 'denied' | 'rate-limited' | 'error';
    ranAt: number;
    error?: string;
  }>> => ipcRenderer.invoke('peer:getAudit'),

  /** Subscribe to a peer appearing on the LAN */
  onPeerDiscovered: (callback: (peer: { machineId: string; alias: string; address: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('peer:discovered', listener);
    return () => ipcRenderer.removeListener('peer:discovered', listener);
  },

  /** Subscribe to a peer leaving the LAN */
  onPeerLost: (callback: (data: { machineId: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('peer:lost', listener);
    return () => ipcRenderer.removeListener('peer:lost', listener);
  },

  /** Subscribe to a peer initiating a pairing WITH US (we are the responder) */
  onPeerIncoming: (callback: (data: { sessionId: string; machineId: string; alias: string; address: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('peer:incoming', listener);
    return () => ipcRenderer.removeListener('peer:incoming', listener);
  },

  /** Subscribe to the SAS becoming available for the active session */
  onPeerSas: (callback: (data: { sessionId: string; sas: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('peer:sas', listener);
    return () => ipcRenderer.removeListener('peer:sas', listener);
  },

  /** Subscribe to a completed pairing */
  onPeerPaired: (callback: (data: { sessionId: string; peerId: string; machineId: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('peer:paired', listener);
    return () => ipcRenderer.removeListener('peer:paired', listener);
  },

  /** Subscribe to a failed/aborted pairing */
  onPeerFailed: (callback: (data: { sessionId: string; reason: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('peer:failed', listener);
    return () => ipcRenderer.removeListener('peer:failed', listener);
  },

  /** Subscribe to the configured-peer registry changing (add/remove/allow/enable). */
  onPeerConfigChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('peer-config:changed', listener);
    return () => ipcRenderer.removeListener('peer-config:changed', listener);
  },

  /** Subscribe to a peer link coming online / going offline. */
  onPeerLinkStatus: (callback: (data: { peerId: string; online: boolean }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('peer-link:status', listener);
    return () => ipcRenderer.removeListener('peer-link:status', listener);
  },

  /** Subscribe to the audit log changing. */
  onPeerAuditChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('peer-audit:changed', listener);
    return () => ipcRenderer.removeListener('peer-audit:changed', listener);
  },

} as const;

export type PreloadMethodImplementations = typeof PRELOAD_METHOD_IMPLEMENTATIONS;

export function createHelmPreloadApi(): HelmPreloadApi<PreloadMethodImplementations> {
  return createPreloadDomains(PRELOAD_METHOD_IMPLEMENTATIONS);
}
