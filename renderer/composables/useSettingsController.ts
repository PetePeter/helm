import { computed, ref, toRaw } from 'vue';
import { configClient, skillsClient, telegramClient, toolsClient } from '../ipc/clients.js';
import { initConfigCache } from '../bindings.js';
import { sessionsState } from '../screens/sessions-state.js';
import { state } from '../state.js';
import { getCliDisplayName, logEvent, showFormModal } from '../utils.js';
import { sortBindingEntries, type BindingSortField, type SortDirection } from '../sort-logic.js';
import { CONTROLLER_BUTTONS } from '../controller-buttons.js';
import {
  buildToolEditorOptions,
  setToolEditorCallback,
  toolEditor,
  type ToolEditorBridgeData,
} from '../stores/modal-bridge.js';
import { useChipBarStore } from '../stores/chip-bar.js';
import { useToast } from './useToast.js';

export interface SettingsToolItem {
  key: string;
  name: string;
  command: string;
  hasInitialPrompt: boolean;
  initialPromptCount: number;
}

export interface SettingsDirectoryItem {
  name: string;
  path: string;
}

export interface SettingsChipbarAction {
  label: string;
  sequence: string;
}

export interface SettingsTelegramConfig {
  botToken: string;
  chatId: string;
  allowedUsers: string;
  notificationsEnabled: boolean;
  autoStart: boolean;
  openWhisprPath: string;
  piperPath: string;
  piperVoicePath: string;
  ffmpegPath: string;
}

export interface SettingsMcpConfig {
  enabled: boolean;
  port: number;
  authToken: string;
}

export interface SettingsSkillSummary {
  id: string;
  name: string;
  description: string;
  aiAmendable: boolean;
  allProjects: boolean;
  projectIds: string[];
  type?: string;
  source?: 'user' | 'system';
  useCount: number;
  avgRating: number;
  reviewCount: number;
}

export interface SettingsSkillReview {
  stars: number;
  summary: string;
  improvement?: string;
  cliName: string;
  cliType: string;
  timestamp: string;
}

export interface SettingsSkillDraft {
  id: string;
  name: string;
  description: string;
  body: string;
  aiAmendable: boolean;
  allProjects: boolean;
  projectIds: string[];
  type?: string;
  source?: 'user' | 'system';
  useCount: number;
  avgRating: number;
  reviewCount: number;
  reviews: SettingsSkillReview[];
}

export interface SettingsBindingEntry {
  button: string;
  action: string;
  label: string;
  detail: string;
}

const NON_CLI_SETTINGS_TABS = new Set(['tools', 'chipbar-actions', 'directories', 'projects', 'skills', 'telegram', 'mcp', 'peers', 'mobile']);

function emptySkillDraft(): SettingsSkillDraft {
  return {
    id: '',
    name: '',
    description: '',
    body: '',
    aiAmendable: false,
    allProjects: true,
    projectIds: [],
    type: undefined,
    source: undefined,
    useCount: 0,
    avgRating: 0,
    reviewCount: 0,
    reviews: [],
  };
}

export function useSettingsController(options: {
  refreshProjects: () => Promise<void>;
  doSpawnShell?: (command: string) => Promise<void>;
  reloadSessions?: () => void;
  closeSettings?: () => void;
  openBindingEditor?: (button: string, cliType: string, binding?: any) => void;
}) {
  const settingsTab = ref(state.settingsTab || 'tools');
  const settingsCliTypes = ref<string[]>([]);
  const settingsTools = ref<SettingsToolItem[]>([]);
  const settingsDirectories = ref<SettingsDirectoryItem[]>([]);
  const settingsProjects = computed(() => state.projects);
  const settingsChipbarActions = ref<SettingsChipbarAction[]>([]);
  const settingsTelegramConfig = ref<SettingsTelegramConfig>({
    botToken: '',
    chatId: '',
    allowedUsers: '',
    notificationsEnabled: false,
    autoStart: false,
    openWhisprPath: '',
    piperPath: '',
    piperVoicePath: '',
    ffmpegPath: '',
  });
  const settingsTelegramBotRunning = ref(false);
  const settingsMcpConfig = ref<SettingsMcpConfig>({ enabled: false, port: 47373, authToken: '' });
  const settingsSkills = ref<SettingsSkillSummary[]>([]);
  const settingsSkillDraft = ref<SettingsSkillDraft>(emptySkillDraft());
  const skillBodyCache = ref<Record<string, string>>({});
  const settingsBindings = ref<SettingsBindingEntry[]>([]);
  const settingsBindingSortField = ref<BindingSortField>('button');
  const settingsBindingSortDirection = ref<SortDirection>('asc');

  const settingsAddableButtons = computed(() => {
    const mapped = new Set(settingsBindings.value.map((binding) => binding.button));
    return CONTROLLER_BUTTONS.filter((button) => !mapped.has(button));
  });

  const settingsBindingCopySources = computed(() =>
    settingsCliTypes.value
      .filter((cliType) => cliType !== settingsTab.value)
      .map((cliType) => ({ id: cliType, label: getCliDisplayName(cliType) })),
  );

  async function loadSettingsData(): Promise<void> {
    settingsCliTypes.value = state.cliTypes.length > 0
      ? state.cliTypes
      : (await configClient.configGetCliTypes());

    const validTabs = new Set([
      ...settingsCliTypes.value,
      'tools',
      'chipbar-actions',
      'directories',
      'projects',
      'skills',
      'telegram',
      'mcp',
      'peers',
      'mobile',
    ]);
    if (!validTabs.has(settingsTab.value)) {
      settingsTab.value = 'tools';
    }

    await Promise.all([
      loadTools(),
      loadDirectories(),
      loadChipbarActions(),
      loadTelegramConfig(),
      loadMcpConfig(),
      loadSkills(),
      loadBindingSortPrefs(),
      options.refreshProjects(),
    ]);

    await loadCurrentTabBindings();
  }

  async function loadCurrentTabBindings(): Promise<void> {
    const tab = settingsTab.value;
    if (NON_CLI_SETTINGS_TABS.has(tab)) {
      settingsBindings.value = [];
      return;
    }

    let bindings = state.cliBindingsCache[tab];
    if (!bindings) {
      bindings = await configClient.configGetBindings(tab);
      if (bindings) state.cliBindingsCache[tab] = bindings;
    }

    const sortedEntries = sortBindingEntries(
      Object.entries(bindings || {}),
      settingsBindingSortField.value,
      settingsBindingSortDirection.value,
    );

    settingsBindings.value = sortedEntries.map(([button, binding]: [string, any]) => ({
      button,
      action: binding.action || '',
      label: binding.label || binding.action || '',
      detail: binding.sequence || binding.command || '',
    }));
  }

  function buildSettingsTabs() {
    return [
      ...settingsCliTypes.value.map((cliType) => ({
        id: cliType,
        label: getCliDisplayName(cliType),
      })),
      { id: 'tools', label: '🔧 Tools' },
      { id: 'chipbar-actions', label: '⚡ Quick Actions' },
      { id: 'projects', label: '📁 Projects' },
      { id: 'skills', label: '🧠 Skills' },
      { id: 'telegram', label: '📨 Telegram' },
      { id: 'mcp', label: '🧩 MCP' },
      { id: 'peers', label: '🔗 Fleet' },
      { id: 'mobile', label: '📱 Mobile' },
    ];
  }

  /**
   * A CLI type's display name is the handle humans and MCP callers address it
   * by, so two types sharing one label make resolution ambiguous — the loader
   * throws AmbiguousCliTypeError rather than guessing. Block the collision here,
   * where the user can still fix it, instead of at spawn time.
   *
   * `excludeId` is the type being renamed, so keeping its own name is allowed.
   */
  function validateCliTypeName(rawName: string, excludeId?: string): string | null {
    const trimmed = (rawName ?? '').trim();
    if (!trimmed) return 'Name is required.';
    const clashes = settingsTools.value.some(
      (tool) => tool.key !== excludeId && tool.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    return clashes ? `A CLI type named "${trimmed}" already exists.` : null;
  }

  function makeUniqueCloneName(sourceName: string): string {
    const baseName = sourceName.trim() || 'CLI Type';
    let index = 1;
    while (true) {
      const candidate = index === 1 ? `${baseName} Copy` : `${baseName} Copy ${index}`;
      if (!validateCliTypeName(candidate)) return candidate;
      index++;
    }
  }

  function buildToolEditorData(value: any, fallbackName: string): ToolEditorBridgeData {
    return {
      name: value?.displayName || value?.name || fallbackName,
      env: Array.isArray(value?.env)
        ? value.env.map((i: any) => ({ name: i.name || '', value: i.value || '', mode: i.mode }))
        : [],
      initialPromptDelay: value?.initialPromptDelay ?? 0,
      spawnCommand: value?.spawnCommand || '',
      resumeCommand: value?.resumeCommand || '',
      continueCommand: value?.continueCommand || '',
      renameCommand: value?.renameCommand || '',
      handoffCommand: value?.handoffCommand || '',
      helmPreambleForInterSession: value?.helmPreambleForInterSession !== false,
      largeTextAsTempFile: Boolean(value?.largeTextAsTempFile),
      submitSuffix: value?.submitSuffix ?? '\\r',
      helmActions: {
        clear: value?.helmActions?.clear ?? '',
        compact: value?.helmActions?.compact ?? '',
        export: value?.helmActions?.export ?? '',
      },
      initialPrompt: Array.isArray(value?.initialPrompt)
        ? value.initialPrompt.map((i: any) => ({ label: i.label || '', sequence: i.sequence || '' }))
        : [],
    };
  }

  async function refreshAfterToolChange(nextTab?: string): Promise<void> {
    state.cliTypes = await configClient.configGetCliTypes();
    state.availableSpawnTypes = state.cliTypes;
    if (nextTab) {
      settingsTab.value = nextTab;
      state.settingsTab = nextTab;
    }
    await initConfigCache();
    options.reloadSessions?.();
    await loadSettingsData();
  }

  async function loadTools(): Promise<void> {
    try {
      const toolsData = await toolsClient.toolsGetAll();
      const cliTypes = toolsData?.cliTypes || {};
      settingsTools.value = Object.entries(cliTypes).map(([key, value]: [string, any]) => ({
        key,
        name: value.displayName || value.name || key,
        command: value.spawnCommand || value.resumeCommand || value.continueCommand || '',
        hasInitialPrompt: Array.isArray(value.initialPrompt) && value.initialPrompt.length > 0,
        initialPromptCount: Array.isArray(value.initialPrompt) ? value.initialPrompt.length : 0,
      }));
    } catch {
      settingsTools.value = [];
    }
  }

  async function loadDirectories(): Promise<void> {
    try {
      const dirs = await configClient.configGetWorkingDirs();
      settingsDirectories.value = dirs || [];
      sessionsState.directories = dirs || [];
    } catch {
      settingsDirectories.value = [];
      sessionsState.directories = [];
    }
  }

  async function loadChipbarActions(): Promise<void> {
    try {
      const chipbarData = await configClient.configGetChipbarActions();
      settingsChipbarActions.value = chipbarData?.actions || [];
    } catch {
      settingsChipbarActions.value = [];
    }
  }

  async function loadTelegramConfig(): Promise<void> {
    try {
      const tgConfig = await telegramClient.telegramGetConfig();
      settingsTelegramConfig.value = {
        botToken: tgConfig?.botToken || '',
        chatId: tgConfig?.chatId ? String(tgConfig.chatId) : '',
        allowedUsers: (tgConfig?.allowedUserIds || []).join(', '),
        notificationsEnabled: tgConfig?.enabled || false,
        autoStart: tgConfig?.autoStart || false,
        openWhisprPath: tgConfig?.openWhisprPath || '',
        piperPath: tgConfig?.piperPath || '',
        piperVoicePath: tgConfig?.piperVoicePath || '',
        ffmpegPath: tgConfig?.ffmpegPath || '',
      };
      settingsTelegramBotRunning.value = await telegramClient.telegramIsRunning();
    } catch {
      settingsTelegramConfig.value = {
        botToken: '',
        chatId: '',
        allowedUsers: '',
        notificationsEnabled: false,
        autoStart: false,
        openWhisprPath: '',
        piperPath: '',
        piperVoicePath: '',
        ffmpegPath: '',
      };
      settingsTelegramBotRunning.value = false;
    }
  }

  async function loadMcpConfig(): Promise<void> {
    try {
      const mcpConfig = await configClient.configGetMcpConfig();
      settingsMcpConfig.value = {
        enabled: mcpConfig?.enabled ?? false,
        port: mcpConfig?.port ?? 47373,
        authToken: mcpConfig?.authToken || '',
      };
    } catch {
      settingsMcpConfig.value = { enabled: false, port: 47373, authToken: '' };
    }
  }

  async function loadSkills(): Promise<void> {
    try {
      const skills = await skillsClient.skillList() || [];
      settingsSkills.value = await Promise.all(skills.map(async (skill: SettingsSkillSummary) => {
        const stats = await skillsClient.skillGetStats(skill.id);
        return {
          ...skill,
          useCount: stats?.useCount ?? skill.useCount ?? 0,
          avgRating: stats?.avgRating ?? skill.avgRating ?? 0,
          reviewCount: stats?.reviewCount ?? skill.reviewCount ?? 0,
        };
      }));
      if (settingsSkills.value.length > 0) {
        const currentId = settingsSkillDraft.value.id || settingsSkills.value[0].id;
        await onSkillSelect(currentId);
      } else {
        settingsSkillDraft.value = emptySkillDraft();
      }
    } catch {
      settingsSkills.value = [];
      settingsSkillDraft.value = emptySkillDraft();
    }
  }

  async function loadBindingSortPrefs(): Promise<void> {
    try {
      const prefs = await configClient.configGetSortPrefs('bindings');
      settingsBindingSortField.value = (prefs?.field as BindingSortField) || 'button';
      settingsBindingSortDirection.value = (prefs?.direction as SortDirection) || 'asc';
    } catch {
      settingsBindingSortField.value = 'button';
      settingsBindingSortDirection.value = 'asc';
    }
  }

  function onToolAdd(): void {
    toolEditor.mode = 'add';
    toolEditor.editKey = '';
    toolEditor.validateName = (candidate: string) => validateCliTypeName(candidate);
    toolEditor.initialData = {
      name: '',
      env: [],
      initialPromptDelay: 0,
      spawnCommand: '',
      resumeCommand: '',
      continueCommand: '',
      renameCommand: '',
      handoffCommand: '',
      helmPreambleForInterSession: true,
      largeTextAsTempFile: false,
      submitSuffix: '\\r',
      helmActions: { clear: '', compact: '', export: '' },
      initialPrompt: [],
    };
    setToolEditorCallback(async (values) => {
      const name = values.name?.trim();
      const nameError = validateCliTypeName(name ?? '');
      if (nameError) {
        logEvent(`Add CLI type: ${nameError}`);
        return;
      }
      const validItems = (values._promptItems || []).filter((item: { sequence: string }) => item.sequence.trim());
      const initialPromptDelay = values.initialPromptDelay || 0;
      // The loader mints the uuid identity; there is no slug to invent here.
      const addResult = await toolsClient.toolsAddCliType(
        name,
        name,
        validItems,
        initialPromptDelay,
        buildToolEditorOptions(values),
      );
      if (addResult.success) {
        logEvent(`Added CLI type: ${name}`);
        await refreshAfterToolChange();
        return;
      }
      logEvent(`Failed to add CLI type: ${addResult.error || 'unknown error'}`);
    });
    toolEditor.visible = true;
  }

  async function onToolEdit(key: string): Promise<void> {
    try {
      const toolsData = await toolsClient.toolsGetAll();
      const value = toolsData?.cliTypes?.[key];
      if (!value) return;

      toolEditor.mode = 'edit';
      toolEditor.editKey = key;
      toolEditor.validateName = (candidate: string) => validateCliTypeName(candidate, key);
      toolEditor.initialData = buildToolEditorData(value, key);
      setToolEditorCallback(async (values) => {
        const name = values.name?.trim();
        const nameError = validateCliTypeName(name ?? '', key);
        if (nameError) {
          logEvent(`Update CLI type: ${nameError}`);
          return;
        }
        const validItems = (values._promptItems || []).filter((item: { sequence: string }) => item.sequence.trim());
        const initialPromptDelay = values.initialPromptDelay || 0;
        // `key` is the uuid identity — a rename changes displayName only.
        const updateResult = await toolsClient.toolsUpdateCliType(
          key,
          name,
          validItems,
          initialPromptDelay,
          buildToolEditorOptions(values),
        );
        if (updateResult.success) {
          logEvent(`Updated CLI type: ${key}`);
          await refreshAfterToolChange();
          return;
        }
        logEvent(`Failed to update CLI type: ${updateResult.error || 'unknown error'}`);
      });
      toolEditor.visible = true;
    } catch (error) {
      console.error('Failed to load tool for edit:', error);
    }
  }

  async function onToolClone(key: string): Promise<void> {
    try {
      const toolsData = await toolsClient.toolsGetAll();
      const value = toolsData?.cliTypes?.[key];
      if (!value) return;

      toolEditor.mode = 'clone';
      toolEditor.editKey = key;
      toolEditor.validateName = (candidate: string) => validateCliTypeName(candidate);
      toolEditor.initialData = {
        ...buildToolEditorData(value, key),
        name: makeUniqueCloneName(value.displayName || value.name || key),
      };
      setToolEditorCallback(async (values) => {
        const name = values.name?.trim();
        const nameError = validateCliTypeName(name ?? '');
        if (nameError) {
          logEvent(`Clone CLI type: ${nameError}`);
          return;
        }
        const validItems = (values._promptItems || []).filter((item: { sequence: string }) => item.sequence.trim());
        const initialPromptDelay = values.initialPromptDelay || 0;
        const addResult = await toolsClient.toolsAddCliType(
          name,
          name,
          validItems,
          initialPromptDelay,
          buildToolEditorOptions(values),
        );
        // The clone's bindings are copied onto the uuid the loader just minted.
        if (addResult.success && addResult.id) {
          await configClient.configCopyCliBindings(key, addResult.id);
          logEvent(`Cloned CLI type ${getCliDisplayName(key)} to ${name}`);
          await refreshAfterToolChange(addResult.id);
          return;
        }
        logEvent(`Failed to clone CLI type: ${addResult.error || 'unknown error'}`);
      });
      toolEditor.visible = true;
    } catch (error) {
      console.error('Failed to load tool for clone:', error);
    }
  }

  async function onToolDelete(key: string): Promise<void> {
    try {
      const result = await toolsClient.toolsRemoveCliType(key);
      if (result.success) {
        logEvent(`Deleted CLI type: ${getCliDisplayName(key)}`);
        delete state.cliBindingsCache[key];
        state.cliTypes = await configClient.configGetCliTypes();
        state.availableSpawnTypes = state.cliTypes;
        options.reloadSessions?.();
        void loadSettingsData();
      } else {
        logEvent(`Failed to delete: ${result.error || 'unknown error'}`);
      }
    } catch (error) {
      console.error('Delete CLI type failed:', error);
    }
  }

  async function onToolReorder(key: string, direction: 'up' | 'down'): Promise<void> {
    try {
      const index = state.cliTypes.indexOf(key);
      if (index < 0) return;
      const result = await toolsClient.toolsReorderCliType(index, direction);
      if (result.success) {
        state.cliTypes = await configClient.configGetCliTypes();
        state.availableSpawnTypes = state.cliTypes;
        await initConfigCache();
        options.reloadSessions?.();
        void loadSettingsData();
        logEvent(`Reordered CLI type: ${getCliDisplayName(key)} (${direction})`);
      } else {
        logEvent(`Failed to reorder: ${result.error || 'unknown error'}`);
      }
    } catch (error) {
      console.error('Reorder CLI type failed:', error);
    }
  }


  // Strip Vue reactivity before crossing the IPC boundary. Reactive proxies
  // cannot be structured-cloned, so passing them to configSetChipbarActions
  // throws DataCloneError and the save fails silently. See onChipbarActionEdit.
  function toPlainActions(actions: SettingsChipbarAction[]): SettingsChipbarAction[] {
    return actions.map((action) => ({ label: action.label, sequence: action.sequence }));
  }

  async function onChipbarActionAdd(): Promise<void> {
    const result = await showFormModal('Add Chip Bar Action', [
      {
        key: 'label',
        label: 'Label',
        required: true,
        placeholder: 'e.g. 💾 Save Plan',
        help: 'Button label shown in the chipbar (emojis recommended)',
      },
      {
        key: 'sequence',
        label: 'Sequence',
        type: 'textarea',
        required: true,
        placeholder: 'e.g. Write exactly one JSON file into {inboxDir}/ and do not write it anywhere else.{Enter}',
        help: 'Sequence to send when clicked. Use {Enter}, {Ctrl+C}, and template expansions.',
      },
    ]);
    if (!result) return;

    const label = result.label?.trim();
    const sequence = result.sequence?.trim();
    if (!label || !sequence) {
      logEvent('Add chip bar action: label and sequence are required');
      return;
    }

    try {
      const chipbarData = await configClient.configGetChipbarActions();
      const updatedActions = [...(chipbarData?.actions || []), { label, sequence }];
      const saveResult = await configClient.configSetChipbarActions(updatedActions);
      if (saveResult.success) {
        settingsChipbarActions.value = updatedActions;
        useChipBarStore().invalidateActions();
        void useChipBarStore().refresh();
        logEvent(`Added chip bar action: ${label}`);
      } else {
        throw new Error(saveResult.error || 'Failed to add chip bar action');
      }
    } catch (error) {
      console.error('Add chip bar action failed:', error);
      logEvent(`Failed to add action: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  async function onChipbarActionEdit(index: number): Promise<void> {
    const action = settingsChipbarActions.value[index];
    if (!action) return;

    const result = await showFormModal(`Edit Chip Bar Action: ${action.label}`, [
      { key: 'label', label: 'Label', required: true, defaultValue: action.label, help: 'Button label shown in the chipbar' },
      { key: 'sequence', label: 'Sequence', type: 'textarea', required: true, defaultValue: action.sequence, help: 'Sequence to send when clicked.' },
    ]);
    if (!result) return;

    const label = result.label?.trim() || action.label;
    const sequence = result.sequence?.trim() || action.sequence;
    if (!label || !sequence) {
      logEvent('Edit chip bar action: label and sequence are required');
      return;
    }

    try {
      const updatedActions = [...settingsChipbarActions.value];
      updatedActions[index] = { label, sequence };
      const saveResult = await configClient.configSetChipbarActions(toPlainActions(updatedActions));
      if (saveResult.success) {
        settingsChipbarActions.value = updatedActions;
        useChipBarStore().invalidateActions();
        void useChipBarStore().refresh();
        logEvent(`Updated chip bar action: ${label}`);
      } else {
        throw new Error(saveResult.error || 'Failed to update chip bar action');
      }
    } catch (error) {
      console.error('Update chip bar action failed:', error);
      logEvent(`Failed to update action: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  async function onChipbarActionDelete(index: number): Promise<void> {
    const action = settingsChipbarActions.value[index];
    if (!action) return;

    try {
      const updatedActions = settingsChipbarActions.value.filter((_, i) => i !== index);
      const result = await configClient.configSetChipbarActions(toPlainActions(updatedActions));
      if (result.success) {
        settingsChipbarActions.value = updatedActions;
        useChipBarStore().invalidateActions();
        void useChipBarStore().refresh();
        logEvent(`Deleted chip bar action: ${action.label}`);
      } else {
        throw new Error(result.error || 'Failed to delete chip bar action');
      }
    } catch (error) {
      console.error('Delete chip bar action failed:', error);
      logEvent(`Failed to delete action: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  async function onChipbarActionMove(fromIndex: number, toIndex: number): Promise<void> {
    const actions = [...settingsChipbarActions.value];
    const [moved] = actions.splice(fromIndex, 1);
    actions.splice(toIndex, 0, moved);

    try {
      const result = await configClient.configSetChipbarActions(toPlainActions(actions));
      if (result.success) {
        settingsChipbarActions.value = actions;
        useChipBarStore().invalidateActions();
        void useChipBarStore().refresh();
        logEvent(`Moved chip bar action from position ${fromIndex + 1} to ${toIndex + 1}`);
      } else {
        throw new Error(result.error || 'Failed to reorder chip bar action');
      }
    } catch (error) {
      console.error('Move chip bar action failed:', error);
    }
  }

  async function onTelegramUpdateField(field: string, value: string | boolean): Promise<void> {
    try {
      if (field === 'notificationsEnabled') {
        await telegramClient.telegramSetConfig({ enabled: Boolean(value) });
        settingsTelegramConfig.value.notificationsEnabled = Boolean(value);
      } else if (field === 'autoStart') {
        await telegramClient.telegramSetConfig({ autoStart: Boolean(value) });
        settingsTelegramConfig.value.autoStart = Boolean(value);
      } else if (field === 'botToken') {
        await telegramClient.telegramSetConfig({ botToken: String(value) });
        settingsTelegramConfig.value.botToken = String(value);
      } else if (field === 'chatId') {
        await telegramClient.telegramSetConfig({ chatId: Number(value) || null });
        settingsTelegramConfig.value.chatId = String(value);
      } else if (field === 'allowedUsers') {
        const ids = String(value).split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
        await telegramClient.telegramSetConfig({ allowedUserIds: ids });
        settingsTelegramConfig.value.allowedUsers = String(value);
      } else if (field === 'openWhisprPath') {
        await telegramClient.telegramSetConfig({ openWhisprPath: String(value) });
        settingsTelegramConfig.value.openWhisprPath = String(value);
      } else if (field === 'piperPath') {
        await telegramClient.telegramSetConfig({ piperPath: String(value) });
        settingsTelegramConfig.value.piperPath = String(value);
      } else if (field === 'piperVoicePath') {
        await telegramClient.telegramSetConfig({ piperVoicePath: String(value) });
        settingsTelegramConfig.value.piperVoicePath = String(value);
      } else if (field === 'ffmpegPath') {
        await telegramClient.telegramSetConfig({ ffmpegPath: String(value) });
        settingsTelegramConfig.value.ffmpegPath = String(value);
      }
      // Voice capabilities are detected at MCP-connect time, so a path change here
      // won't reach already-connected CLI clients until they reconnect.
      const capabilityFields = ['ffmpegPath', 'piperPath', 'piperVoicePath', 'openWhisprPath', 'openWhisprModelPath'];
      if (capabilityFields.includes(field)) {
        useToast().addToast({
          message: 'Voice capability changed — reconnect MCP clients (or restart Helm) to apply.',
          type: 'info',
          key: 'voice-capability-changed',
        });
      }
    } catch (error) {
      console.error('Failed to update Telegram config:', error);
    }
  }

  async function onTelegramStartBot(): Promise<void> {
    try {
      await telegramClient.telegramStart();
      settingsTelegramBotRunning.value = true;
    } catch (error) {
      console.error('Failed to start Telegram bot:', error);
    }
  }

  async function onTelegramStopBot(): Promise<void> {
    try {
      await telegramClient.telegramStop();
      settingsTelegramBotRunning.value = false;
    } catch (error) {
      console.error('Failed to stop Telegram bot:', error);
    }
  }

  async function onMcpUpdate(updates: Partial<{ enabled: boolean; port: number; authToken: string }>): Promise<void> {
    try {
      const result = await configClient.configSetMcpConfig(updates);
      if (result?.success === false) {
        throw new Error(result.error || 'MCP config update failed');
      }
      const saved = await configClient.configGetMcpConfig();
      settingsMcpConfig.value = {
        enabled: saved?.enabled ?? false,
        port: saved?.port ?? 47373,
        authToken: saved?.authToken || '',
      };
    } catch (error) {
      console.error('Failed to update MCP config:', error);
    }
  }

  async function onMcpGenerateToken(): Promise<void> {
    try {
      const result = await configClient.configGenerateMcpToken();
      if (result?.success && typeof result.token === 'string') {
        const saved = await configClient.configGetMcpConfig();
        settingsMcpConfig.value = {
          enabled: saved?.enabled ?? settingsMcpConfig.value.enabled,
          port: saved?.port ?? settingsMcpConfig.value.port,
          authToken: saved?.authToken || result.token,
        };
      }
    } catch (error) {
      console.error('Failed to generate MCP token:', error);
    }
  }

  async function onMcpRunInShell(command: string): Promise<void> {
    options.closeSettings?.();
    await options.doSpawnShell?.(command);
  }

  async function onSkillSelect(id: string): Promise<void> {
    const skill = await skillsClient.skillGet(id);
    if (!skill) return;
    const stats = await skillsClient.skillGetStats(id);
    settingsSkillDraft.value = {
      id: skill.id,
      name: skill.name || '',
      description: skill.description || '',
      body: skill.body || '',
      aiAmendable: skill.aiAmendable === true,
      allProjects: skill.allProjects !== false,
      projectIds: Array.isArray(skill.projectIds) ? skill.projectIds : [],
      type: skill.type,
      source: skill.source,
      useCount: stats?.useCount ?? 0,
      avgRating: stats?.avgRating ?? 0,
      reviewCount: stats?.reviewCount ?? 0,
      reviews: Array.isArray(stats?.reviews) ? stats.reviews : [],
    };
  }

  function onSkillNew(): void {
    settingsSkillDraft.value = emptySkillDraft();
  }

  async function onSkillClone(id: string): Promise<void> {
    const skill = await skillsClient.skillGet(id);
    if (!skill || !skill.type) return;
    const result = await skillsClient.skillClone(id);
    if (result?.success === false) {
      logEvent(`Failed to clone skill: ${result.error || 'unknown error'}`);
      return;
    }
    await loadSkills();
    const savedId = result?.skill?.id;
    if (savedId) await onSkillSelect(savedId);
    logEvent(`Cloned skill: ${skill.name}`);
  }

  async function onSkillSave(draft: SettingsSkillDraft): Promise<void> {
    const name = draft.name.trim();
    if (!name) {
      logEvent('Skill name is required');
      return;
    }
    const payload = toRaw({
      name,
      description: draft.description,
      body: draft.body,
      aiAmendable: draft.aiAmendable,
      allProjects: draft.allProjects,
      projectIds: draft.allProjects ? [] : [...toRaw(draft.projectIds)],
      type: draft.type,
    });
    const result = draft.id
      ? await skillsClient.skillUpdate(draft.id, payload)
      : await skillsClient.skillCreate(payload);
    if (result?.success === false) {
      logEvent(`Failed to save skill: ${result.error || 'unknown error'}`);
      return;
    }
    await loadSkills();
    const savedId = result?.skill?.id;
    if (savedId) await onSkillSelect(savedId);
    logEvent(`Saved skill: ${name}`);
  }

  async function onSkillDelete(id: string): Promise<void> {
    if (!id) return;
    const result = await skillsClient.skillDelete(id);
    if (result?.success === false) {
      logEvent(`Failed to delete skill: ${result.error || 'unknown error'}`);
      return;
    }
    await loadSkills();
    logEvent('Deleted skill');
  }

  async function onSkillClearReviews(id: string): Promise<void> {
    if (!id) return;
    const result = await skillsClient.skillClearReviews(id);
    if (result?.success === false) {
      logEvent(`Failed to clear skill reviews: ${result.error || 'unknown error'}`);
      return;
    }
    await loadSkills();
    await onSkillSelect(id);
    logEvent('Cleared skill reviews');
  }

  async function onSkillResetUseCount(id: string): Promise<void> {
    if (!id) return;
    const result = await skillsClient.skillResetUseCount(id);
    if (result?.success === false) {
      logEvent(`Failed to reset skill use count: ${result.error || 'unknown error'}`);
      return;
    }
    await loadSkills();
    await onSkillSelect(id);
    logEvent('Reset skill use count');
  }

  async function onSkillResetAllCounts(): Promise<void> {
    const result = await skillsClient.skillResetAllCounts();
    if (result?.success === false) {
      logEvent(`Failed to reset skill use counts: ${result.error || 'unknown error'}`);
      return;
    }
    await loadSkills();
    logEvent('Reset all skill use counts');
  }

  async function onSkillLoadBodies(): Promise<void> {
    const ids = settingsSkills.value.map((s) => s.id).filter((id) => !(id in skillBodyCache.value));
    await Promise.all(ids.map(async (id) => {
      const skill = await skillsClient.skillGet(id);
      if (skill) skillBodyCache.value[id] = skill.body ?? '';
    }));
  }

  function onBindingAdd(button?: string): void {
    const targetButton = button || settingsAddableButtons.value[0];
    if (!targetButton) {
      logEvent('All buttons already have bindings');
      return;
    }
    options.openBindingEditor?.(targetButton, settingsTab.value);
  }

  async function onBindingDelete(button: string): Promise<void> {
    try {
      const result = await configClient.configSetBinding(button, settingsTab.value, null);
      if (result.success) {
        await initConfigCache();
        void loadCurrentTabBindings();
        logEvent(`Deleted binding for ${button}`);
      }
    } catch (error) {
      console.error('Failed to delete binding:', error);
    }
  }

  async function onBindingCopyFrom(sourceCli: string): Promise<void> {
    try {
      const result = await configClient.configCopyCliBindings(sourceCli, settingsTab.value);
      if (result.success) {
        await initConfigCache();
        void loadCurrentTabBindings();
        logEvent(`Copied bindings from ${getCliDisplayName(sourceCli)}`);
      } else {
        logEvent(`Failed to copy bindings: ${result.error || 'unknown error'}`);
      }
    } catch (error) {
      console.error('Failed to copy bindings:', error);
    }
  }

  async function onBindingSortChange(field: string, direction: 'asc' | 'desc'): Promise<void> {
    settingsBindingSortField.value = field as BindingSortField;
    settingsBindingSortDirection.value = direction;
    try {
      await configClient.configSetSortPrefs('bindings', { field, direction });
    } catch (error) {
      console.error('Failed to save binding sort prefs:', error);
    }
    await loadCurrentTabBindings();
  }

  return {
    settingsTab,
    settingsCliTypes,
    settingsTools,
    settingsDirectories,
    settingsProjects,
    settingsChipbarActions,
    settingsTelegramConfig,
    settingsTelegramBotRunning,
    settingsMcpConfig,
    settingsSkills,
    settingsSkillDraft,
    skillBodyCache,
    settingsBindings,
    settingsBindingSortField,
    settingsBindingSortDirection,
    settingsAddableButtons,
    settingsBindingCopySources,
    loadSettingsData,
    loadCurrentTabBindings,
    buildSettingsTabs,
    validateCliTypeName,
    onToolAdd,
    onToolEdit,
    onToolClone,
    onToolDelete,
    onToolReorder,
    onChipbarActionAdd,
    onChipbarActionEdit,
    onChipbarActionDelete,
    onChipbarActionMove,
    onTelegramUpdateField,
    onTelegramStartBot,
    onTelegramStopBot,
    onMcpUpdate,
    onMcpGenerateToken,
    onMcpRunInShell,
    onSkillSelect,
    onSkillNew,
    onSkillSave,
    onSkillDelete,
    onSkillClone,
    onSkillClearReviews,
    onSkillResetUseCount,
    onSkillResetAllCounts,
    onSkillLoadBodies,
    onBindingAdd,
    onBindingDelete,
    onBindingCopyFrom,
    onBindingSortChange,
  };
}
