/**
 * ToolEditorModal component tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { useModalStack } from '../../../renderer/composables/useModalStack.js';
import ToolEditorModal from '../../../renderer/components/modals/ToolEditorModal.vue';

const GLOBAL_STUBS = { teleport: true } as const;

interface ToolEditorData {
  name: string;
  env: Array<{ name: string; value: string }>;
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
  initialPrompt: Array<{ label: string; sequence: string }>;
}

const DEFAULT_DATA: ToolEditorData = {
  name: '',
  env: [],
  initialPromptDelay: 2000,
  spawnCommand: '',
  resumeCommand: '',
  continueCommand: '',
  renameCommand: '',
  handoffCommand: '',
  helmPreambleForInterSession: true,
  largeTextAsTempFile: false,
  messReminders: true,
  submitSuffix: '\\r',
  initialPrompt: [],
};

describe('ToolEditorModal.vue', () => {
  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Partial<InstanceType<typeof ToolEditorModal>['$props']> = {}) {
    return mount(ToolEditorModal, {
      props: {
        visible: true,
        mode: 'add' as const,
        editKey: '',
        initialData: { ...DEFAULT_DATA },
        ...props,
      },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders when visible', () => {
    const w = factory();
    expect(w.find('.tool-editor-modal').exists()).toBe(true);
    w.unmount();
  });

  it('does not render when not visible', () => {
    const w = factory({ visible: false });
    expect(w.find('.tool-editor-modal').exists()).toBe(false);
    w.unmount();
  });

  it('shows add title in add mode', () => {
    const w = factory({ mode: 'add' });
    expect(w.text()).toContain('Add CLI Type');
    w.unmount();
  });

  it('shows edit title in edit mode', () => {
    const w = factory({ mode: 'edit', editKey: 'my-tool', initialData: { ...DEFAULT_DATA, name: 'My Tool' } });
    expect(w.find('.modal-title').text()).toBe('Edit CLI Type: My Tool');
    w.unmount();
  });

  it('populates fields from initialData', () => {
    const w = factory({
      initialData: {
        ...DEFAULT_DATA,
        name: 'My Tool',
        spawnCommand: 'my-cmd --flag',
        env: [{ name: 'COPILOT_MODEL', value: 'qwen' }],
        initialPromptDelay: 5000,
      },
    });
    const nameInput = w.find('#te-name').element as HTMLInputElement;
    const spawnInput = w.find('#te-spawn').element as HTMLInputElement;
    const envNameInput = w.find('#te-env-name-0').element as HTMLInputElement;
    const envValueInput = w.find('#te-env-value-0').element as HTMLInputElement;
    const delayInput = w.find('#te-delay').element as HTMLInputElement;
    expect(nameInput.value).toBe('My Tool');
    expect(spawnInput.value).toBe('my-cmd --flag');
    expect(envNameInput.value).toBe('COPILOT_MODEL');
    expect(envValueInput.value).toBe('qwen');
    expect(delayInput.value).toBe('5000');
    w.unmount();
  });

  it('shows Helm-managed environment variables as readonly rows', () => {
    const w = factory();
    const readonlyRows = w.findAll('.te-env-item--readonly');
    expect(readonlyRows).toHaveLength(3);
    const readonlyInputs = w.findAll('.te-env-item--readonly input').map((input) => (input.element as HTMLInputElement).value);
    expect(readonlyInputs).toContain('HELM_MCP_TOKEN');
    expect(readonlyInputs).toContain('HELM_SESSION_ID');
    expect(readonlyInputs).toContain('HELM_SESSION_NAME');
    w.unmount();
  });

  it('shows spawn command input in the main launch section', () => {
    const w = factory({
      initialData: { ...DEFAULT_DATA, spawnCommand: 'codex --full-auto' },
    });
    const spawnInput = w.find('#te-spawn').element as HTMLInputElement;
    expect(spawnInput).toBeTruthy();
    expect(spawnInput.value).toBe('codex --full-auto');
    w.unmount();
  });

  it('has two-column layout rows', () => {
    const w = factory();
    expect(w.findAll('.te-grid-2col').length).toBeGreaterThan(0);
    w.unmount();
  });

  it('emits save with field values on save click', async () => {
    const w = factory({
      initialData: {
        ...DEFAULT_DATA,
        name: 'Test',
        spawnCommand: 'test-cmd --arg',
        env: [{ name: 'COPILOT_MODEL', value: 'qwen' }],
        initialPromptDelay: 3000,
        largeTextAsTempFile: true,
        initialPrompt: [{ label: 'greet', sequence: 'hello' }],
      },
    });
    const saveBtn = w.findAll('button').find(b => b.text() === 'Save')!;
    await saveBtn.trigger('click');
    await flushPromises();
    const saved = w.emitted('save')!;
    expect(saved).toHaveLength(1);
    const values = saved[0][0] as Record<string, unknown>;
    expect(values.name).toBe('Test');
    expect(values.spawnCommand).toBe('test-cmd --arg');
    expect(values.env).toEqual([{ name: 'COPILOT_MODEL', value: 'qwen' }]);
    expect(values.initialPromptDelay).toBe(3000);
    expect(values.largeTextAsTempFile).toBe(true);
    expect(values._promptItems).toEqual([{ label: 'greet', sequence: 'hello' }]);
    w.unmount();
  });

  it('appends a Helm session init prompt item via the button', async () => {
    const w = factory({ initialData: { ...DEFAULT_DATA, initialPrompt: [] } });

    const helmBtn = w.findAll('button').find(b => b.text() === '+ Helm session init')!;
    expect(helmBtn).toBeTruthy();
    await helmBtn.trigger('click');

    const saveBtn = w.findAll('button').find(b => b.text() === 'Save')!;
    await saveBtn.trigger('click');
    await flushPromises();

    const values = w.emitted('save')![0][0] as Record<string, unknown>;
    expect(values._promptItems).toEqual([
      { label: 'Helm session init', sequence: 'Call session_info to get Helm MCP initial information.{Enter}' },
    ]);
    w.unmount();
  });

  it('no longer renders the Auto-include Helm session init checkbox', () => {
    const w = factory({ initialData: { ...DEFAULT_DATA } });
    const labels = w.findAll('.te-section--prompts .te-checkbox-row');
    expect(labels.length).toBe(0);
    w.unmount();
  });

  it('round-trips the large text temp file checkbox', async () => {
    const w = factory({
      initialData: { ...DEFAULT_DATA, largeTextAsTempFile: true },
    });
    const checkbox = w.findAll('.te-checkbox-row input')[1];
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);

    await checkbox.setValue(false);
    const saveBtn = w.findAll('button').find(b => b.text() === 'Save')!;
    await saveBtn.trigger('click');
    await flushPromises();

    const values = w.emitted('save')![0][0] as Record<string, unknown>;
    expect(values.largeTextAsTempFile).toBe(false);
    w.unmount();
  });

  it('round-trips the Mess reminders checkbox and omits it when left on', async () => {
    const w = factory({ initialData: { ...DEFAULT_DATA } });
    const checkbox = w.findAll('.te-checkbox-row input')[2];
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);

    const saveBtn = w.findAll('button').find(b => b.text() === 'Save')!;
    await saveBtn.trigger('click');
    await flushPromises();
    // On is the default, so it stays out of the payload entirely.
    expect(w.emitted('save')![0][0] as Record<string, unknown>).not.toHaveProperty('messReminders');

    await checkbox.setValue(false);
    await saveBtn.trigger('click');
    await flushPromises();
    expect((w.emitted('save')![1][0] as Record<string, unknown>).messReminders).toBe(false);
    w.unmount();
  });

  it('emits cancel on cancel click', async () => {
    const w = factory();
    const cancelBtn = w.findAll('button').find(b => b.text() === 'Cancel')!;
    await cancelBtn.trigger('click');
    await flushPromises();
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(w.emitted('update:visible')?.[0]).toEqual([false]);
    w.unmount();
  });

  it('emits cancel on B button', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(w.emitted('update:visible')?.[0]).toEqual([false]);
    w.unmount();
  });

  it('can add prompt items', async () => {
    const w = factory();
    expect(w.findAll('.te-prompt-item').length).toBe(0);
    const addBtn = w.findAll('button').find(b => b.text() === '+ Add Item')!;
    await addBtn.trigger('click');
    await flushPromises();
    expect(w.findAll('.te-prompt-item').length).toBe(1);
    w.unmount();
  });

  it('can remove prompt items', async () => {
    const w = factory({
      initialData: {
        ...DEFAULT_DATA,
        initialPrompt: [
          { label: 'a', sequence: 's1' },
          { label: 'b', sequence: 's2' },
        ],
      },
    });
    expect(w.findAll('.te-prompt-item').length).toBe(2);
    const removeBtn = w.find('.btn--danger');
    await removeBtn.trigger('click');
    await flushPromises();
    expect(w.findAll('.te-prompt-item').length).toBe(1);
    w.unmount();
  });

  it('shows the launch section without an extra collapse step', () => {
    const w = factory();
    expect(w.find('#te-spawn').exists()).toBe(true);
    expect(w.find('#te-resume').exists()).toBe(true);
    w.unmount();
  });

  it('can add environment variable rows', async () => {
    const w = factory();
    expect(w.findAll('.te-env-item:not(.te-env-item--readonly)').length).toBe(0);
    const addBtn = w.findAll('button').find(b => b.text() === '+ Add Variable')!;
    await addBtn.trigger('click');
    await flushPromises();
    expect(w.findAll('.te-env-item:not(.te-env-item--readonly)').length).toBe(1);
    w.unmount();
  });

  it('can remove environment variable rows', async () => {
    const w = factory({
      initialData: {
        ...DEFAULT_DATA,
        env: [
          { name: 'A', value: '1' },
          { name: 'B', value: '2' },
        ],
      },
    });
    expect(w.findAll('.te-env-item:not(.te-env-item--readonly)').length).toBe(2);
    const removeBtn = w.findAll('.te-env-item .btn--danger')[0];
    await removeBtn.trigger('click');
    await flushPromises();
    expect(w.findAll('.te-env-item:not(.te-env-item--readonly)').length).toBe(1);
    w.unmount();
  });

  // The display name is the handle users address a CLI type by; a clash makes
  // resolution ambiguous, so the modal blocks the save inline rather than
  // letting the write fail behind a closed dialog.
  describe('display-name validation', () => {
    it('surfaces the validation error and does not emit save', async () => {
      const w = factory({
        initialData: { ...DEFAULT_DATA, name: 'Codex' },
        validateName: (name: string) => (name.trim() === 'Codex' ? 'A CLI type named "Codex" already exists.' : null),
      });

      await w.find('.btn--primary').trigger('click');
      await flushPromises();

      expect(w.find('.te-error').text()).toContain('already exists');
      expect(w.emitted('save')).toBeUndefined();
      expect(w.emitted('update:visible')).toBeUndefined();
      w.unmount();
    });

    it('clears the error and saves once the name is unique', async () => {
      const w = factory({
        initialData: { ...DEFAULT_DATA, name: 'Codex' },
        validateName: (name: string) => (name.trim() === 'Codex' ? 'A CLI type named "Codex" already exists.' : null),
      });

      await w.find('.btn--primary').trigger('click');
      await flushPromises();
      expect(w.find('.te-error').exists()).toBe(true);

      await w.find('#te-name').setValue('Codex Next');
      await w.find('.btn--primary').trigger('click');
      await flushPromises();

      expect(w.find('.te-error').exists()).toBe(false);
      expect(w.emitted('save')?.[0]?.[0]).toMatchObject({ name: 'Codex Next' });
      w.unmount();
    });
  });

  it('shows the display name as the handle and the id only as diagnostic detail', () => {
    const w = factory({
      mode: 'edit' as const,
      editKey: '11111111-2222-4333-8444-555566667777',
      initialData: { ...DEFAULT_DATA, name: 'Codex' },
    });

    expect(w.find('.modal-title').text()).toBe('Edit CLI Type: Codex');
    expect(w.find('.modal-title').text()).not.toContain('1111');
    expect(w.find('.te-identity').text()).toContain('11111111-2222-4333-8444-555566667777');
    w.unmount();
  });

  it('Tab focus trap wraps within the modal', async () => {
    const w = factory();
    const overlay = w.find('.modal-overlay');
    const nameInput = w.find('#te-name').element as HTMLInputElement;
    const closeButton = w.find('.te-close-btn').element as HTMLButtonElement;

    closeButton.focus();
    await overlay.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(nameInput);

    nameInput.focus();
    await overlay.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(closeButton);
    w.unmount();
  });
});
