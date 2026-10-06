/**
 * AppModalHost.vue — prompt-tree picker callback wiring.
 *
 * Regression for PT-4 bug 1: onPromptTreeSelect must invoke the callback
 * registered via showPromptTree(onSelect) with the selected templateId.
 * The earlier bug called hidePromptTree() (which clears the stored callback)
 * BEFORE reading it, so the caller's onSelect never fired.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AppModalHost from '../../../renderer/components/app/AppModalHost.vue';
import {
  promptTree,
  setPromptTreeCallback,
  getPromptTreeCallback,
} from '../../../renderer/stores/modal-bridge.js';
import type { TreeNode } from '../../../src/session/prompt-template-manager.js';

const BASE_PROPS = {
  cliTypes: ['claude'],
  contextMenuTargetSessionId: null,
  contextMenuSelectedText: '',
  contextMenuHasSelection: false,
  contextMenuPosition: null,
  contextMenuIsSnappedOut: false,
  bindingEditorVisible: false,
  bindingEditorButton: '',
  bindingEditorProfileName: '',
  bindingEditorBinding: null,
  schedulerPopupVisible: false,
  schedulerPopupTaskId: null,
};

// Stub teleport and the unrelated child modals/components whose onMounted
// hooks touch IPC clients not present in the test env. PromptTreeModal stays
// real so the select event flows through the genuine handler wiring.
const STUBS = {
  teleport: true,
  ToastNotification: true,
  EditorPopup: true,
  ScheduledTasksTab: true,
} as const;

function makeTree(): TreeNode {
  return {
    id: '__root__', name: '', order: -1, kind: 'folder',
    children: [
      { id: 't1', name: 'Template 1', order: 0, kind: 'template', children: [] },
    ],
  };
}

describe('AppModalHost.vue — prompt tree picker callback', () => {
  beforeEach(() => {
    promptTree.visible = false;
  });

  it('invokes the showPromptTree callback with the selected templateId', async () => {
    // Open the picker as showPromptTree() would: register the caller's onSelect
    // and populate the reactive bridge state (skips the IPC list round-trip).
    const onSelect = vi.fn();
    promptTree.tree = makeTree();
    promptTree.visible = true;
    setPromptTreeCallback(onSelect);
    expect(promptTree.visible).toBe(true);

    const w = mount(AppModalHost, { props: BASE_PROPS, global: { stubs: STUBS } });
    await flushPromises();

    // Simulate the child PromptTreeModal emitting select for a template.
    const child = w.findComponent({ name: 'PromptTreeModal' });
    child.vm.$emit('select', 't1');
    await flushPromises();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('t1');
    // Callback is cleared after firing.
    expect(getPromptTreeCallback()).toBeNull();
    expect(promptTree.visible).toBe(false);
    w.unmount();
  });
});
