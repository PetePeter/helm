/**
 * Settings controller tests.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configGetCliTypes: vi.fn(),
  toolsGetAll: vi.fn(),
  configGetWorkingDirs: vi.fn(),
  configGetChipbarActions: vi.fn(),
  configGetSortPrefs: vi.fn(),
  configGetBindingProfiles: vi.fn(),
  configRemoveBinding: vi.fn(),
  configDeleteBindingProfile: vi.fn(),
  configGetMcpConfig: vi.fn(),
  telegramGetConfig: vi.fn(),
  telegramIsRunning: vi.fn(),
  toolsAddCliType: vi.fn(),
  toolsUpdateCliType: vi.fn(),
  toolsReorderCliType: vi.fn(),
  initConfigCache: vi.fn(),
}));

vi.mock('../../renderer/bindings.js', () => ({
  initConfigCache: mocks.initConfigCache,
}));

vi.mock('../../renderer/ipc/clients.js', () => ({
  configClient: {
    configGetCliTypes: mocks.configGetCliTypes,
    configGetWorkingDirs: mocks.configGetWorkingDirs,
    configGetChipbarActions: mocks.configGetChipbarActions,
    configGetSortPrefs: mocks.configGetSortPrefs,
    configGetBindingProfiles: mocks.configGetBindingProfiles,
    configRemoveBinding: mocks.configRemoveBinding,
    configDeleteBindingProfile: mocks.configDeleteBindingProfile,
    configGetMcpConfig: mocks.configGetMcpConfig,
  },
  toolsClient: {
    toolsGetAll: mocks.toolsGetAll,
    toolsAddCliType: mocks.toolsAddCliType,
    toolsUpdateCliType: mocks.toolsUpdateCliType,
    toolsReorderCliType: mocks.toolsReorderCliType,
  },
  telegramClient: {
    telegramGetConfig: mocks.telegramGetConfig,
    telegramIsRunning: mocks.telegramIsRunning,
  },
}));

import { useSettingsController } from '../../renderer/composables/useSettingsController.js';
import { sessionsState } from '../../renderer/screens/sessions-state.js';
import { state } from '../../renderer/state.js';
import { getToolEditorCallback, toolEditor } from '../../renderer/stores/modal-bridge.js';

const CODEX_ID = '11111111-2222-4333-8444-555566667777';
const CLAUDE_ID = '99999999-8888-4777-8666-555544443333';

/** Two real CLI types, uuid-keyed exactly as tools:getAll returns them post-migration. */
function twoCliTypes(): Record<string, any> {
  return {
    [CODEX_ID]: { id: CODEX_ID, displayName: 'Codex', name: 'Codex', legacyKey: 'codex', spawnCommand: 'codex' },
    [CLAUDE_ID]: { id: CLAUDE_ID, displayName: 'Claude', name: 'Claude', legacyKey: 'claude-code', spawnCommand: 'claude' },
  };
}

describe('useSettingsController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cliTypes = [];
    state.settingsTab = 'tools';
    state.projects = [];
    state.cliBindingsCache = {};
    sessionsState.directories = [];

    mocks.configGetCliTypes.mockResolvedValue(['codex']);
    mocks.toolsGetAll.mockResolvedValue({
      cliTypes: {
        codex: {
          name: 'Codex',
          spawnCommand: 'codex',
          initialPrompt: [{ label: 'hello', sequence: 'hi' }],
        },
      },
    });
    mocks.configGetWorkingDirs.mockResolvedValue([{ name: 'Hub', path: 'X:\\coding\\gamepad-cli-hub' }]);
    mocks.configGetChipbarActions.mockResolvedValue({ actions: [{ label: 'Save', sequence: 'save' }] });
    mocks.configGetSortPrefs.mockResolvedValue({ field: 'button', direction: 'asc' });
    mocks.configGetBindingProfiles.mockResolvedValue([]);
    mocks.configGetMcpConfig.mockResolvedValue({ enabled: true, port: 47400, authToken: 'token' });
    mocks.telegramGetConfig.mockResolvedValue({
      botToken: 'bot',
      chatId: 123,
      allowedUserIds: [1, 2],
      enabled: true,
      autoStart: true,
    });
    mocks.telegramIsRunning.mockResolvedValue(true);
  });

  it('loads settings subsections through one data owner', async () => {
    const refreshProjects = vi.fn().mockResolvedValue(undefined);
    const controller = useSettingsController({ refreshProjects });

    await controller.loadSettingsData();

    expect(mocks.toolsGetAll).toHaveBeenCalled();
    expect(controller.settingsTools.value).toEqual([
      {
        key: 'codex',
        name: 'Codex',
        command: 'codex',
        hasInitialPrompt: true,
        initialPromptCount: 1,
      },
    ]);
    expect(controller.settingsDirectories.value).toEqual([{ name: 'Hub', path: 'X:\\coding\\gamepad-cli-hub' }]);
    expect(controller.settingsChipbarActions.value).toEqual([{ label: 'Save', sequence: 'save' }]);
    expect(controller.settingsTelegramConfig.value.allowedUsers).toBe('1, 2');
    expect(controller.settingsMcpConfig.value.port).toBe(47400);
    expect(refreshProjects).toHaveBeenCalled();
  });

  it('keeps tools loaded when optional Telegram and MCP loading fail', async () => {
    mocks.telegramGetConfig.mockRejectedValue(new Error('telegram down'));
    mocks.configGetMcpConfig.mockRejectedValue(new Error('mcp down'));
    const controller = useSettingsController({ refreshProjects: vi.fn().mockResolvedValue(undefined) });

    await controller.loadSettingsData();

    expect(controller.settingsTools.value).toHaveLength(1);
    expect(controller.settingsTelegramConfig.value).toMatchObject({ botToken: '', chatId: '' });
    expect(controller.settingsMcpConfig.value).toEqual({ enabled: false, port: 47373, authToken: '' });
  });

  // ------------------------------------------------------------------------
  // Display-name uniqueness. Two CLI types sharing a label make the resolver
  // ambiguous (AmbiguousCliTypeError at spawn time), so the UI blocks it.
  // ------------------------------------------------------------------------
  describe('duplicate display names', () => {
    async function loadedController() {
      mocks.configGetCliTypes.mockResolvedValue([CODEX_ID, CLAUDE_ID]);
      mocks.toolsGetAll.mockResolvedValue({ cliTypes: twoCliTypes() });
      const controller = useSettingsController({ refreshProjects: vi.fn().mockResolvedValue(undefined) });
      await controller.loadSettingsData();
      return controller;
    }

    it('rejects a duplicate display name on add, ignoring case and whitespace', async () => {
      const controller = await loadedController();
      await controller.onToolAdd();

      expect(toolEditor.validateName?.('Codex')).toMatch(/already exists/i);
      expect(toolEditor.validateName?.('  cODEx  ')).toMatch(/already exists/i);
      expect(toolEditor.validateName?.('')).toMatch(/required/i);
      expect(toolEditor.validateName?.('Gemini')).toBeNull();
    });

    it('rejects a duplicate display name on clone', async () => {
      const controller = await loadedController();
      await controller.onToolClone(CODEX_ID);

      expect(toolEditor.validateName?.('claude')).toMatch(/already exists/i);
      expect(toolEditor.validateName?.('Codex Copy')).toBeNull();
    });

    it('rejects a rename onto another type but allows a type to keep its own name', async () => {
      const controller = await loadedController();
      await controller.onToolEdit(CODEX_ID);

      expect(toolEditor.validateName?.('Claude')).toMatch(/already exists/i);
      expect(toolEditor.validateName?.('CODEX')).toBeNull();
      expect(toolEditor.validateName?.('Codex Next')).toBeNull();
    });
  });

  it('renames through the uuid identity without re-keying the CLI type', async () => {
    mocks.configGetCliTypes.mockResolvedValue([CODEX_ID, CLAUDE_ID]);
    mocks.toolsGetAll.mockResolvedValue({ cliTypes: twoCliTypes() });
    mocks.toolsUpdateCliType.mockResolvedValue({ success: true });
    const controller = useSettingsController({ refreshProjects: vi.fn().mockResolvedValue(undefined) });
    await controller.loadSettingsData();

    await controller.onToolEdit(CODEX_ID);
    await getToolEditorCallback()?.({
      name: 'Codex Next',
      env: [],
      initialPromptDelay: 0,
      _promptItems: [],
      helmActions: {},
    });

    const [key, name, , , options] = mocks.toolsUpdateCliType.mock.calls[0];
    expect(key).toBe(CODEX_ID);
    expect(name).toBe('Codex Next');
  });

  it('reorders by the uuid-keyed position in state.cliTypes', async () => {
    state.cliTypes = [CODEX_ID, CLAUDE_ID];
    mocks.configGetCliTypes.mockResolvedValue([CODEX_ID, CLAUDE_ID]);
    mocks.toolsGetAll.mockResolvedValue({ cliTypes: twoCliTypes() });
    mocks.toolsReorderCliType.mockResolvedValue({ success: true });
    const controller = useSettingsController({ refreshProjects: vi.fn().mockResolvedValue(undefined) });

    await controller.onToolReorder(CLAUDE_ID, 'up');

    expect(mocks.toolsReorderCliType).toHaveBeenCalledWith(1, 'up');
  });

  it('clone carries the source binding profile into the add call', async () => {
    const cloneId = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';
    const types = twoCliTypes();
    types[CODEX_ID].bindingProfileId = 'p1';
    mocks.configGetCliTypes.mockResolvedValue([CODEX_ID, CLAUDE_ID]);
    mocks.toolsGetAll.mockResolvedValue({ cliTypes: types });
    mocks.configGetBindingProfiles.mockResolvedValue([{ id: 'p1', name: 'Default', bindings: {} }]);
    mocks.toolsAddCliType.mockResolvedValue({ success: true, id: cloneId });
    const controller = useSettingsController({ refreshProjects: vi.fn().mockResolvedValue(undefined) });
    await controller.loadSettingsData();

    await controller.onToolClone(CODEX_ID);
    expect(toolEditor.initialData.bindingProfileId).toBe('p1');
    expect(toolEditor.bindingProfiles).toEqual([{ id: 'p1', name: 'Default' }]);
    await getToolEditorCallback()?.({
      name: 'Codex Copy',
      env: [],
      initialPromptDelay: 0,
      _promptItems: [],
      helmActions: {},
      bindingProfileId: 'p1',
    });

    expect(mocks.toolsAddCliType.mock.calls[0][4].bindingProfileId).toBe('p1');
  });

  it('shows the first profile, and falls back to it when the selected one disappears', async () => {
    const profiles = [
      { id: 'p1', name: 'Default', bindings: { A: { action: 'keyboard', sequence: '{Enter}' } } },
      { id: 'p2', name: 'Codex', bindings: { B: { action: 'context-menu' } } },
    ];
    mocks.configGetBindingProfiles.mockResolvedValue(profiles);
    const controller = useSettingsController({ refreshProjects: vi.fn().mockResolvedValue(undefined) });
    await controller.loadSettingsData();
    expect(controller.settingsBindingProfileId.value).toBe('p1');
    expect(controller.settingsBindings.value.map((b) => b.button)).toEqual(['A']);

    controller.onBindingProfileSelect('p2');
    expect(controller.settingsBindings.value.map((b) => b.button)).toEqual(['B']);

    mocks.configDeleteBindingProfile.mockResolvedValue({ success: true });
    mocks.configGetBindingProfiles.mockResolvedValue([profiles[0]]);
    await controller.onBindingProfileDelete();
    expect(mocks.configDeleteBindingProfile).toHaveBeenCalledWith('p2');
    // Tools that pointed at p2 lost their bindings — the runtime cache must be rebuilt.
    expect(mocks.initConfigCache).toHaveBeenCalled();
    expect(controller.settingsBindingProfileId.value).toBe('p1');
  });

  it('deletes a binding from the selected profile', async () => {
    mocks.configGetBindingProfiles.mockResolvedValue([
      { id: 'p1', name: 'Default', bindings: { A: { action: 'context-menu' } } },
    ]);
    mocks.configRemoveBinding.mockResolvedValue({ success: true });
    const controller = useSettingsController({ refreshProjects: vi.fn().mockResolvedValue(undefined) });
    await controller.loadSettingsData();

    await controller.onBindingDelete('A');

    expect(mocks.configRemoveBinding).toHaveBeenCalledWith('p1', 'A');
    expect(mocks.initConfigCache).toHaveBeenCalled();
  });
});
