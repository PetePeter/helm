/**
 * Modal bridge — reactive state shared between legacy show*() callers and Vue modal components.
 *
 * Legacy modules set bridge state instead of manipulating DOM.
 * App.vue binds to bridge state in its template.
 * Vue modal components push/pop useModalStack() when visibility changes.
 *
 * Callbacks are stored separately from reactive state to avoid Vue proxy overhead.
 */

import { reactive } from 'vue';
import { getTerminalManager } from '../runtime/terminal-provider.js';
import { useEscProtection } from '../composables/useEscProtection.js';
import { useEditorPopupStore } from './editor-popup.js';

// ============================================================================
// Close Confirm
// ============================================================================

export const closeConfirm = reactive({
  visible: false,
  sessionId: '',
  sessionName: '',
  draftCount: 0,
  /** Sessions about to be closed together (folder mode only). */
  count: 0,
  mode: 'session' as 'session' | 'app' | 'folder',
});

let _closeConfirmOnConfirm: ((sessionId: string) => void) | null = null;
export function setCloseConfirmCallback(cb: ((sessionId: string) => void) | null): void { _closeConfirmOnConfirm = cb; }
export function getCloseConfirmCallback(): ((sessionId: string) => void) | null { return _closeConfirmOnConfirm; }

export function showAppCloseConfirm(onConfirm: () => void, onCancel?: () => void): void {
  closeConfirm.visible = true;
  closeConfirm.sessionId = '';
  closeConfirm.sessionName = 'Helm';
  closeConfirm.draftCount = 0;
  closeConfirm.mode = 'app';
  setCloseConfirmCallback(() => onConfirm());
  _closeConfirmOnCancel = onCancel ?? null;
}

/**
 * Confirm closing every session in a directory (project/folder) group.
 *
 * Runtime groups have their own 3-way dialog; a directory group has no entity
 * to keep, so this is a plain yes/no — but it must exist, because the header's
 * ✕ otherwise kills every session in the folder on a single click.
 */
export function showFolderCloseConfirm(folderName: string, count: number, onConfirm: () => void, onCancel?: () => void): void {
  closeConfirm.visible = true;
  closeConfirm.sessionId = '';
  closeConfirm.sessionName = folderName;
  closeConfirm.draftCount = 0;
  closeConfirm.count = count;
  closeConfirm.mode = 'folder';
  setCloseConfirmCallback(() => onConfirm());
  _closeConfirmOnCancel = onCancel ?? null;
}

let _closeConfirmOnCancel: (() => void) | null = null;
export function setCloseConfirmCancelCallback(cb: (() => void) | null): void { _closeConfirmOnCancel = cb; }
export function getCloseConfirmCancelCallback(): (() => void) | null { return _closeConfirmOnCancel; }

// ============================================================================
// Context Menu
// ============================================================================

export const contextMenu = reactive({
  visible: false,
  selectedText: '',
  hasSelection: false,
  sourceSessionId: '',
});

export function showContextMenu(
  sessionId: string,
  preCapturedText?: string, preCapturedHasSelection?: boolean,
): void {
  let selectedText: string;
  let hasSelection: boolean;
  if (preCapturedText !== undefined && preCapturedHasSelection !== undefined) {
    selectedText = preCapturedText;
    hasSelection = preCapturedHasSelection;
  } else {
    const tm = getTerminalManager();
    const view = tm?.getActiveView() ?? null;
    selectedText = view?.getSelection() ?? '';
    hasSelection = view?.hasSelection() ?? false;
  }
  contextMenu.visible = true;
  contextMenu.selectedText = selectedText;
  contextMenu.hasSelection = hasSelection;
  contextMenu.sourceSessionId = sessionId;
}

export function hideContextMenu(): void {
  contextMenu.visible = false;
}

// ============================================================================
// Plan Delete Confirm
// ============================================================================

export const planDeleteConfirm = reactive({
  visible: false,
  planTitle: '',
  itemKind: 'plan item',
  title: 'Delete Plan Item',
  message: '',
  confirmLabel: 'Delete',
});

let _planDeleteOnConfirm: (() => void) | null = null;
export function setPlanDeleteCallback(cb: (() => void) | null): void { _planDeleteOnConfirm = cb; }
export function getPlanDeleteCallback(): (() => void) | null { return _planDeleteOnConfirm; }

export function showPlanDeleteConfirm(
  planTitle: string,
  onConfirm: () => void,
  options: Partial<{ itemKind: string; title: string; message: string; confirmLabel: string }> = {},
): void {
  planDeleteConfirm.visible = true;
  planDeleteConfirm.planTitle = planTitle;
  planDeleteConfirm.itemKind = options.itemKind ?? 'plan item';
  planDeleteConfirm.title = options.title ?? 'Delete Plan Item';
  planDeleteConfirm.message = options.message ?? '';
  planDeleteConfirm.confirmLabel = options.confirmLabel ?? 'Delete';
  setPlanDeleteCallback(onConfirm);
}

export function hidePlanDeleteConfirm(): void {
  planDeleteConfirm.visible = false;
  planDeleteConfirm.planTitle = '';
  planDeleteConfirm.itemKind = 'plan item';
  planDeleteConfirm.title = 'Delete Plan Item';
  planDeleteConfirm.message = '';
  planDeleteConfirm.confirmLabel = 'Delete';
  setPlanDeleteCallback(null);
}

// ============================================================================
// Clear Done Plans Confirm
// ============================================================================

export const clearDonePlans = reactive({
  visible: false,
  count: 0,
  dirName: '',
});

let _clearDonePlansOnConfirm: (() => void) | null = null;
export function setClearDonePlansCallback(cb: (() => void) | null): void { _clearDonePlansOnConfirm = cb; }
export function getClearDonePlansCallback(): (() => void) | null { return _clearDonePlansOnConfirm; }


// ============================================================================
// Prompt Tree Picker
// ============================================================================

import type { TreeNode } from '../../src/session/prompt-template-manager.js';
import { promptTemplatesClient } from '../ipc/clients.js';

export const promptTree = reactive({
  visible: false,
  tree: { id: '__root__', name: '', order: -1, kind: 'folder', children: [] } as TreeNode,
});

let _promptTreeOnSelect: ((templateId: string) => void) | null = null;
export function setPromptTreeCallback(cb: ((templateId: string) => void) | null): void { _promptTreeOnSelect = cb; }
export function getPromptTreeCallback(): ((templateId: string) => void) | null { return _promptTreeOnSelect; }

export async function showPromptTree(onSelect: (templateId: string) => void): Promise<void> {
  try {
    const tree = await promptTemplatesClient.promptTemplateList();
    if (!tree || tree.children.length === 0) return;
    promptTree.visible = true;
    promptTree.tree = tree;
    setPromptTreeCallback(onSelect);
  } catch {
    // IPC failed — silently skip opening the modal
  }
}

export function hidePromptTree(): void {
  promptTree.visible = false;
  promptTree.tree = { id: '__root__', name: '', order: -1, kind: 'folder', children: [] };
  setPromptTreeCallback(null);
}

// ============================================================================
// Quick Spawn
// ============================================================================

export const quickSpawn = reactive({
  visible: false,
  preselectedCliType: undefined as string | undefined,
});

let _quickSpawnOnSelect: ((cliType: string) => void) | null = null;
export function setQuickSpawnCallback(cb: ((cliType: string) => void) | null): void { _quickSpawnOnSelect = cb; }
export function getQuickSpawnCallback(): ((cliType: string) => void) | null { return _quickSpawnOnSelect; }
export function openQuickSpawn(
  onSelect: (cliType: string) => void,
  preselectedCliType?: string,
): void {
  quickSpawn.visible = true;
  quickSpawn.preselectedCliType = preselectedCliType;
  setQuickSpawnCallback(onSelect);
}
export function closeQuickSpawn(): void {
  quickSpawn.visible = false;
  quickSpawn.preselectedCliType = undefined;
  setQuickSpawnCallback(null);
}

// ============================================================================
// Dir Picker
// ============================================================================

export const dirPicker = reactive({
  visible: false,
  cliType: '',
  items: [] as Array<{ name: string; path: string; projectId?: string; projectName?: string }>,
  preselectedPath: undefined as string | undefined,
});
export function openDirPicker(
  cliType: string,
  items: Array<{ name: string; path: string; projectId?: string; projectName?: string }>,
  preselectedPath?: string,
): void {
  dirPicker.visible = true;
  dirPicker.cliType = cliType;
  dirPicker.items = [...items];
  dirPicker.preselectedPath = preselectedPath;
}
export function closeDirPicker(): void {
  dirPicker.visible = false;
  dirPicker.cliType = '';
  dirPicker.items = [];
  dirPicker.preselectedPath = undefined;
}

// ============================================================================
// Draft Submenu
// ============================================================================

export const draftSubmenu = reactive({
  visible: false,
  items: [] as Array<{ id: string; label: string; text: string }>,
});

// ============================================================================
// Form Modal
// ============================================================================

export const formModal = reactive({
  visible: false,
  title: '',
  fields: [] as Array<{
    key: string;
    label: string;
    defaultValue?: string;
    placeholder?: string;
    type?: 'text' | 'select' | 'textarea' | 'checkbox';
    options?: Array<{ label: string; value: string }>;
    browse?: boolean;
    showLabels?: boolean;
  }>,
});

let _formModalResolve: ((values: Record<string, string> | null) => void) | null = null;
export function setFormModalResolve(cb: ((values: Record<string, string> | null) => void) | null): void { _formModalResolve = cb; }
export function getFormModalResolve(): ((values: Record<string, string> | null) => void) | null { return _formModalResolve; }

// ============================================================================
// Tool Editor
// ============================================================================

export interface ToolEditorEnvEntry {
  name: string;
  value: string;
  mode?: 'replace' | 'append' | 'prepend';
}

export interface ToolEditorBridgeData {
  name: string;
  env: Array<ToolEditorEnvEntry>;
  initialPromptDelay: number;
  spawnCommand: string;
  resumeCommand: string;
  continueCommand: string;
  renameCommand: string;
  handoffCommand: string;
  helmPreambleForInterSession?: boolean;
  largeTextAsTempFile: boolean;
  messReminders?: boolean;
  submitSuffix: string;
  helmActions: { clear: string; compact: string; export: string };
  initialPrompt: Array<{ label: string; sequence: string }>;
}

const EMPTY_TOOL_DATA: ToolEditorBridgeData = {
  name: '', env: [], initialPromptDelay: 2000,
  spawnCommand: '', resumeCommand: '', continueCommand: '',
  renameCommand: '', handoffCommand: '', helmPreambleForInterSession: true,
  largeTextAsTempFile: false, messReminders: true,
  submitSuffix: '\\r', helmActions: { clear: '', compact: '', export: '' }, initialPrompt: [],
};

export const toolEditor = reactive({
  visible: false,
  mode: 'add' as 'add' | 'edit' | 'clone',
  editKey: '',
  /** Inline name check owned by the settings controller (blocks duplicate labels). */
  validateName: null as ((name: string) => string | null) | null,
  initialData: { ...EMPTY_TOOL_DATA } as ToolEditorBridgeData,
});

let _toolEditorOnSave: ((values: any) => void) | null = null;
export function setToolEditorCallback(cb: ((values: any) => void) | null): void { _toolEditorOnSave = cb; }
export function getToolEditorCallback(): ((values: any) => void) | null { return _toolEditorOnSave; }

// Deep-copy the nested/array fields so callers never share (and mutate) the frozen default.
export function resetToolEditorData(): ToolEditorBridgeData {
  return { ...EMPTY_TOOL_DATA, env: [], initialPrompt: [], helmActions: { clear: '', compact: '', export: '' } };
}

export function buildToolEditorOptions(values: Record<string, any>): {
  env?: ToolEditorEnvEntry[];
  handoffCommand?: string;
  renameCommand?: string;
  spawnCommand?: string;
  resumeCommand?: string;
  continueCommand?: string;
  helmPreambleForInterSession?: boolean;
  largeTextAsTempFile?: boolean;
  messReminders?: boolean;
  submitSuffix?: string;
  helmActions?: { clear?: string; compact?: string; export?: string };
} {
  const fields = ['handoffCommand', 'renameCommand', 'spawnCommand', 'resumeCommand', 'continueCommand'] as const;
  const options: Record<string, string> = {};
  for (const field of fields) {
    options[field] = typeof values[field] === 'string' ? values[field].trim() : '';
  }
  const ha = values.helmActions ?? {};
  const helmActions = {
    clear: typeof ha.clear === 'string' ? ha.clear.trim() : '',
    compact: typeof ha.compact === 'string' ? ha.compact.trim() : '',
    export: typeof ha.export === 'string' ? ha.export.trim() : '',
  };
  const env = Array.isArray(values.env)
    ? values.env
        .map((item: any) => ({
          name: typeof item?.name === 'string' ? item.name.trim() : '',
          value: typeof item?.value === 'string' ? item.value : '',
          ...(item.mode === 'append' || item.mode === 'prepend' ? { mode: item.mode } : {}),
        }))
        .filter((item: ToolEditorEnvEntry) => item.name.length > 0)
    : [];
  return {
    ...options,
    env,
    helmPreambleForInterSession: values.helmPreambleForInterSession !== false,
    largeTextAsTempFile: Boolean(values.largeTextAsTempFile),
    messReminders: values.messReminders !== false,
    submitSuffix: typeof values.submitSuffix === 'string' ? values.submitSuffix : '\\r',
    helmActions,
  };
}

// ============================================================================
// Plan Help Modal
// ============================================================================

export const planHelp = reactive({ visible: false });

const _showedForDir = new Set<string>();

export function showPlanHelpModal(dir: string): void {
  if (_showedForDir.has(dir)) return;
  _showedForDir.add(dir);
  planHelp.visible = true;
}

export function hidePlanHelpModal(): void {
  planHelp.visible = false;
}

export function isPlanHelpVisible(): boolean {
  return planHelp.visible;
}

// ============================================================================
// Runtime Group Name (create / rename)
// ============================================================================

export const runtimeGroupName = reactive({
  visible: false,
  mode: 'create' as 'create' | 'rename',
  /** Prefilled name (rename mode). */
  initialName: '',
});

/** Called with the entered name when the user confirms. */
let _runtimeGroupNameOnSubmit: ((name: string) => void) | null = null;
export function getRuntimeGroupNameCallback(): ((name: string) => void) | null { return _runtimeGroupNameOnSubmit; }

export function openRuntimeGroupNameModal(
  mode: 'create' | 'rename',
  onSubmit: (name: string) => void,
  initialName = '',
): void {
  runtimeGroupName.visible = true;
  runtimeGroupName.mode = mode;
  runtimeGroupName.initialName = initialName;
  _runtimeGroupNameOnSubmit = onSubmit;
}

export function closeRuntimeGroupNameModal(): void {
  runtimeGroupName.visible = false;
  runtimeGroupName.initialName = '';
  _runtimeGroupNameOnSubmit = null;
}

// ============================================================================
// Runtime Group Move Submenu (context-menu "Move to group ▸")
// ============================================================================

export const runtimeGroupMove = reactive({
  visible: false,
  /** Session being moved. */
  sessionId: '',
  /** Runtime group id the session is currently in (for the ✓ marker), or ''. */
  currentGroupId: '',
  /** Groups to list: { id, name }. */
  groups: [] as Array<{ id: string; name: string }>,
});

export function openRuntimeGroupMoveSubmenu(
  sessionId: string,
  currentGroupId: string | null,
  groups: Array<{ id: string; name: string }>,
): void {
  runtimeGroupMove.visible = true;
  runtimeGroupMove.sessionId = sessionId;
  runtimeGroupMove.currentGroupId = currentGroupId ?? '';
  runtimeGroupMove.groups = [...groups];
}

export function closeRuntimeGroupMoveSubmenu(): void {
  runtimeGroupMove.visible = false;
  runtimeGroupMove.sessionId = '';
  runtimeGroupMove.currentGroupId = '';
  runtimeGroupMove.groups = [];
}

// ============================================================================
// Runtime Group Close (3-way dialog)
// ============================================================================

export const runtimeGroupClose = reactive({
  visible: false,
  groupId: '',
  groupName: '',
  memberCount: 0,
});

/** mode is 'keep' (dissolve, keep sessions) or 'closeAll' (close sessions too). */
let _runtimeGroupCloseOnConfirm: ((mode: 'keep' | 'closeAll') => void) | null = null;
export function getRuntimeGroupCloseCallback(): ((mode: 'keep' | 'closeAll') => void) | null { return _runtimeGroupCloseOnConfirm; }

export function openRuntimeGroupCloseModal(
  groupId: string,
  groupName: string,
  memberCount: number,
  onConfirm: (mode: 'keep' | 'closeAll') => void,
): void {
  runtimeGroupClose.visible = true;
  runtimeGroupClose.groupId = groupId;
  runtimeGroupClose.groupName = groupName;
  runtimeGroupClose.memberCount = memberCount;
  _runtimeGroupCloseOnConfirm = onConfirm;
}

export function closeRuntimeGroupCloseModal(): void {
  runtimeGroupClose.visible = false;
  runtimeGroupClose.groupId = '';
  runtimeGroupClose.groupName = '';
  runtimeGroupClose.memberCount = 0;
  _runtimeGroupCloseOnConfirm = null;
}

// ============================================================================
// Guard helper — check if ANY bridge modal is visible (for race condition guard)
// ============================================================================

export function isAnyBridgeModalVisible(): boolean {
  const escProtection = useEscProtection();
  const editorPopupStore = useEditorPopupStore();

  return closeConfirm.visible || contextMenu.visible || planDeleteConfirm.visible ||
    clearDonePlans.visible || quickSpawn.visible || dirPicker.visible ||
    draftSubmenu.visible || formModal.visible || editorPopupStore.visible || toolEditor.visible ||
    planHelp.visible || promptTree.visible || runtimeGroupName.visible || runtimeGroupClose.visible ||
    runtimeGroupMove.visible || escProtection.isProtecting.value;
}

