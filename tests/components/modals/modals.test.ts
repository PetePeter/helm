/**
 * Vue SFC modal component tests — Phase 3.
 *
 * Tests all 9 modal components using @vue/test-utils mount().
 * Each modal is tested for: rendering, visibility, gamepad navigation,
 * emit events, and modal stack integration.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, VueWrapper, flushPromises } from '@vue/test-utils';
import { useModalStack } from '../../../renderer/composables/useModalStack.js';
import { state } from '../../../renderer/state.js';

// Stub Teleport so content renders inline (not teleported outside wrapper).
const GLOBAL_STUBS = { teleport: true } as const;

// ============================================================================
// ConfirmDialog
// ============================================================================

import ConfirmDialog from '../../../renderer/components/modals/ConfirmDialog.vue';

describe('ConfirmDialog.vue', () => {
  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Record<string, any> = {}) {
    return mount(ConfirmDialog, {
      props: {
        visible: true,
        modalId: 'test-confirm',
        title: 'Confirm Thing',
        ariaLabel: 'Confirm thing',
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'save', label: 'Save', variant: 'primary' },
          { id: 'delete', label: 'Delete', variant: 'danger' },
        ],
        selectedIndex: 0,
        cancelActionId: 'cancel',
        ...props,
      },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
      slots: { default: '<div class="confirm-body">Body text</div>' },
    });
  }

  it('renders title, body, and configured buttons', () => {
    const w = factory();
    expect(w.text()).toContain('Confirm Thing');
    expect(w.text()).toContain('Body text');
    expect(w.findAll('button').map(b => b.text())).toEqual(['Cancel', 'Save', 'Delete']);
    w.unmount();
  });

  it('emits action when a non-cancel button is clicked', async () => {
    const w = factory();
    await w.findAll('button')[1].trigger('click');
    expect(w.emitted('action')?.[0]).toEqual(['save']);
    expect(w.emitted('update:visible')?.[0]).toEqual([false]);
    w.unmount();
  });

  it('emits cancel when the configured cancel button is clicked', async () => {
    const w = factory();
    await w.findAll('button')[0].trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(w.emitted('update:visible')?.[0]).toEqual([false]);
    w.unmount();
  });

  it('handles gamepad selection across three buttons', async () => {
    const w = factory();
    await w.setProps({ selectedIndex: 0 });
    (w.vm as any).handleButton('DPadDown');
    expect(w.emitted('update:selectedIndex')?.[1]).toEqual([1]);
    await w.setProps({ selectedIndex: 1 });
    (w.vm as any).handleButton('DPadDown');
    expect(w.emitted('update:selectedIndex')?.[2]).toEqual([2]);
    w.unmount();
  });

  it('B emits cancel and closes', () => {
    const w = factory();
    (w.vm as any).handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(w.emitted('update:visible')?.[0]).toEqual([false]);
    w.unmount();
  });
});

// ============================================================================
// CloseConfirmModal
// ============================================================================

import CloseConfirmModal from '../../../renderer/components/modals/CloseConfirmModal.vue';

describe('CloseConfirmModal.vue', () => {
  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Partial<InstanceType<typeof CloseConfirmModal>['$props']> = {}) {
    return mount(CloseConfirmModal, {
      props: {
        visible: true,
        sessionName: 'test-session',
        ...props,
      },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders when visible', () => {
    const w = factory();
    expect(w.find('.close-confirm-modal').exists()).toBe(true);
    expect(w.text()).toContain('Close Session');
    expect(w.text()).toContain('test-session');
    w.unmount();
  });

  it('does not render when not visible', () => {
    const w = factory({ visible: false });
    expect(w.find('.close-confirm-modal').exists()).toBe(false);
    w.unmount();
  });

  it('shows draft warning when draftCount > 0', () => {
    const w = factory({ draftCount: 3 });
    expect(w.text()).toContain('3 unsent drafts will be deleted');
    w.unmount();
  });

  it('no draft warning when draftCount is 0', () => {
    const w = factory({ draftCount: 0 });
    expect(w.find('.draft-warning').exists()).toBe(false);
    w.unmount();
  });

  it('pushes onto modal stack when visible', async () => {
    const w = factory();
    expect(modalStack.has('close-confirm')).toBe(true);
    w.unmount();
  });

  it('pops from modal stack when hidden', async () => {
    const w = factory();
    expect(modalStack.has('close-confirm')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('close-confirm')).toBe(false);
    w.unmount();
  });

  it('Cancel button emits cancel + update:visible', async () => {
    const w = factory();
    const cancelBtn = w.findAll('button').find(b => b.text() === 'Cancel')!;
    expect(cancelBtn.attributes('tabindex')).toBe('-1');
    await cancelBtn.trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
    expect(w.emitted('update:visible')?.[0]).toEqual([false]);
    w.unmount();
  });

  it('Close button emits confirm + update:visible', async () => {
    const w = factory();
    const closeBtn = w.findAll('button').find(b => b.text() === 'Close')!;
    expect(closeBtn.attributes('tabindex')).toBe('-1');
    await closeBtn.trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    expect(w.emitted('update:visible')?.[0]).toEqual([false]);
    w.unmount();
  });

  it('renders app close copy when mode is app', () => {
    const w = factory({ mode: 'app' });
    expect(w.text()).toContain('Close Helm');
    expect(w.text()).toContain('Close Helm?');
    expect(w.text()).not.toContain('Close session');
    w.unmount();
  });

  it('gamepad D-pad left/right toggles selection', () => {
    const w = factory();
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(0); // Cancel
    vm.handleButton('DPadRight');
    expect(vm.selectedIndex).toBe(1); // Close
    vm.handleButton('DPadLeft');
    expect(vm.selectedIndex).toBe(0); // Cancel
    w.unmount();
  });

  it('gamepad A on Cancel emits cancel', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.selectedIndex = 0;
    vm.handleButton('A');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad A on Close emits confirm', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.selectedIndex = 1;
    vm.handleButton('A');
    expect(w.emitted('confirm')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad B emits cancel', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('singular draft warning for count 1', () => {
    const w = factory({ draftCount: 1 });
    expect(w.text()).toContain('1 unsent draft will be deleted');
    expect(w.text()).not.toContain('drafts');
    w.unmount();
  });
});

// ============================================================================
// PlanDeleteConfirmModal
// ============================================================================

import PlanDeleteConfirmModal from '../../../renderer/components/modals/PlanDeleteConfirmModal.vue';

describe('PlanDeleteConfirmModal.vue', () => {
  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Partial<InstanceType<typeof PlanDeleteConfirmModal>['$props']> = {}) {
    return mount(PlanDeleteConfirmModal, {
      props: { visible: true, planTitle: 'Fix auth bug', ...props },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders title text', () => {
    const w = factory();
    expect(w.text()).toContain('Delete Plan Item');
    expect(w.text()).toContain('Fix auth bug');
    w.unmount();
  });

  it('does not render when not visible', () => {
    const w = factory({ visible: false });
    expect(w.find('.close-confirm-modal').exists()).toBe(false);
    w.unmount();
  });

  it('pushes/pops modal stack', async () => {
    const w = factory();
    expect(modalStack.has('plan-delete-confirm')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('plan-delete-confirm')).toBe(false);
    w.unmount();
  });

  it('Delete button emits confirm', async () => {
    const w = factory();
    const delBtn = w.findAll('button').find(b => b.text() === 'Delete')!;
    expect(delBtn.attributes('tabindex')).toBe('-1');
    await delBtn.trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    w.unmount();
  });

  it('Cancel button emits cancel', async () => {
    const w = factory();
    const cancelBtn = w.findAll('button').find(b => b.text() === 'Cancel')!;
    expect(cancelBtn.attributes('tabindex')).toBe('-1');
    await cancelBtn.trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad any direction toggles selection', () => {
    const w = factory();
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(0);
    vm.handleButton('DPadDown');
    expect(vm.selectedIndex).toBe(1);
    vm.handleButton('DPadUp');
    expect(vm.selectedIndex).toBe(0);
    w.unmount();
  });

  it('gamepad A on Delete emits confirm', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.selectedIndex = 1;
    vm.handleButton('A');
    expect(w.emitted('confirm')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad B emits cancel', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });
});

// ============================================================================
// BulkCleanupModal
// ============================================================================

import BulkCleanupModal from '../../../renderer/components/modals/BulkCleanupModal.vue';

describe('BulkCleanupModal.vue', () => {
  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Partial<InstanceType<typeof BulkCleanupModal>['$props']> = {}) {
    return mount(BulkCleanupModal, {
      props: { visible: true, title: 'Clear Completed Plans', lines: [{ count: 3, noun: 'completed plan' }], dirName: 'my-project', ...props },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders title text', () => {
    const w = factory();
    expect(w.text()).toContain('Clear Completed Plans');
    expect(w.text()).toContain('my-project');
    w.unmount();
  });

  it('renders every count, pluralized, with the dirName', () => {
    const w = factory({
      dirName: 'backend',
      lines: [{ count: 1, noun: 'empty sequence' }, { count: 5, noun: 'unreferenced context' }],
    });
    expect(w.text()).toContain('backend');
    expect(w.text()).toContain('1 empty sequence');
    expect(w.text()).not.toContain('1 empty sequences');
    expect(w.text()).toContain('5 unreferenced contexts');
    w.unmount();
  });

  it('does not render when not visible', () => {
    const w = factory({ visible: false });
    expect(w.find('.close-confirm-modal').exists()).toBe(false);
    w.unmount();
  });

  it('pushes/pops modal stack', async () => {
    const w = factory();
    expect(modalStack.has('bulk-cleanup-confirm')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('bulk-cleanup-confirm')).toBe(false);
    w.unmount();
  });

  it('Clear button emits confirm', async () => {
    const w = factory();
    const clearBtn = w.findAll('button').find(b => b.text() === 'Clear')!;
    expect(clearBtn.attributes('tabindex')).toBe('-1');
    await clearBtn.trigger('click');
    expect(w.emitted('confirm')).toHaveLength(1);
    w.unmount();
  });

  it('Cancel button emits cancel', async () => {
    const w = factory();
    const cancelBtn = w.findAll('button').find(b => b.text() === 'Cancel')!;
    expect(cancelBtn.attributes('tabindex')).toBe('-1');
    await cancelBtn.trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad D-pad toggles selection', () => {
    const w = factory();
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(0);
    vm.handleButton('DPadDown');
    expect(vm.selectedIndex).toBe(1);
    vm.handleButton('DPadUp');
    expect(vm.selectedIndex).toBe(0);
    w.unmount();
  });

  it('gamepad A on Clear emits confirm', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.selectedIndex = 1;
    vm.handleButton('A');
    expect(w.emitted('confirm')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad B emits cancel', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('Tab toggles selection', () => {
    const w = factory();
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(0);
    vm.handleButton('Tab');
    expect(vm.selectedIndex).toBe(1);
    vm.handleButton('Tab');
    expect(vm.selectedIndex).toBe(0);
    w.unmount();
  });

});

// ============================================================================
// QuickSpawnModal
// ============================================================================

import QuickSpawnModal from '../../../renderer/components/modals/QuickSpawnModal.vue';

describe('QuickSpawnModal.vue', () => {
  const cliTypes = ['claude-code', 'copilot-cli', 'generic'];

  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Record<string, any> = {}) {
    return mount(QuickSpawnModal, {
      props: { visible: true, cliTypes, ...props },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders all CLI types', () => {
    const w = factory();
    const items = w.findAll('.dir-picker-item');
    expect(items).toHaveLength(3);
    expect(items[0].attributes('tabindex')).toBe('-1');
    expect(w.find('button').attributes('tabindex')).toBe('-1');
    w.unmount();
  });

  it('does not render when not visible', () => {
    const w = factory({ visible: false });
    expect(w.find('#quickSpawnList').exists()).toBe(false);
    w.unmount();
  });

  it('pre-selects matching CLI type', () => {
    const w = factory({ preselectedCliType: 'copilot-cli' });
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(1);
    w.unmount();
  });

  it('gamepad D-pad down moves selection (clamped)', () => {
    const w = factory();
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(0);
    vm.handleButton('DPadDown');
    expect(vm.selectedIndex).toBe(1);
    vm.handleButton('DPadDown');
    expect(vm.selectedIndex).toBe(2);
    vm.handleButton('DPadDown');
    expect(vm.selectedIndex).toBe(2); // clamped
    w.unmount();
  });

  it('gamepad D-pad up clamped at 0', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('DPadUp');
    expect(vm.selectedIndex).toBe(0); // clamped
    w.unmount();
  });

  it('gamepad A selects CLI type', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('DPadDown'); // index 1 = copilot-cli
    vm.handleButton('A');
    expect(w.emitted('select')?.[0]).toEqual(['copilot-cli']);
    w.unmount();
  });

  it('gamepad B cancels', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('jump number Digit2 selects the second CLI type immediately', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('Digit2');
    expect(w.emitted('select')?.[0]).toEqual(['copilot-cli']);
    w.unmount();
  });

  it('jump number out of range is ignored', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('Digit5'); // only 3 items
    expect(w.emitted('select')).toBeUndefined();
    w.unmount();
  });

  it('renders jump-key badges on the first rows', () => {
    const w = factory();
    const badges = w.findAll('.jump-key');
    expect(badges.map(b => b.text())).toEqual(['1', '2', '3']);
    w.unmount();
  });

  it('click selects item', async () => {
    const w = factory();
    const items = w.findAll('.dir-picker-item');
    await items[2].trigger('click');
    expect(w.emitted('select')?.[0]).toEqual(['generic']);
    w.unmount();
  });

  it('Tab moves selection down', () => {
    const w = factory();
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(0);
    vm.handleButton('Tab');
    expect(vm.selectedIndex).toBe(1);
    vm.handleButton('Tab');
    expect(vm.selectedIndex).toBe(2);
    vm.handleButton('Tab');
    expect(vm.selectedIndex).toBe(2); // clamped
    w.unmount();
  });

  it('ShiftTab moves selection up', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('DPadDown');
    vm.handleButton('DPadDown');
    expect(vm.selectedIndex).toBe(2);
    vm.handleButton('ShiftTab');
    expect(vm.selectedIndex).toBe(1);
    vm.handleButton('ShiftTab');
    expect(vm.selectedIndex).toBe(0);
    vm.handleButton('ShiftTab');
    expect(vm.selectedIndex).toBe(0); // clamped
    w.unmount();
  });

  it('pushes/pops modal stack', async () => {
    const w = factory();
    expect(modalStack.has('quick-spawn')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('quick-spawn')).toBe(false);
    w.unmount();
  });
});

// ============================================================================
// DirPickerModal
// ============================================================================

import DirPickerModal from '../../../renderer/components/modals/DirPickerModal.vue';

describe('DirPickerModal.vue', () => {
  const dirs = [
    { name: 'project-a', path: 'C:\\dev\\project-a' },
    { name: 'project-b', path: 'C:\\dev\\project-b' },
    { name: 'project-c', path: 'C:\\dev\\project-c' },
  ];

  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Record<string, any> = {}) {
    return mount(DirPickerModal, {
      props: { visible: true, cliType: 'claude-code', items: dirs, ...props },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders all directories', () => {
    const w = factory();
    const items = w.findAll('.dir-picker-item');
    expect(items).toHaveLength(3);
    expect(items[0].text()).toContain('project-a');
    expect(items[0].attributes('tabindex')).toBe('-1');
    expect(w.find('button').attributes('tabindex')).toBe('-1');
    w.unmount();
  });

  it('sections directories by project when project metadata is present', () => {
    const w = factory({
      items: [
        { name: 'repo root', path: 'C:\\dev\\repo', projectId: 'p1', projectName: 'Repo', isCanonical: true },
        { name: 'repo app', path: 'C:\\dev\\repo\\app', projectId: 'p1', projectName: 'Repo' },
        { name: 'other', path: 'C:\\dev\\other', projectId: 'p2', projectName: 'Other' },
      ],
    });

    const sections = w.findAll('.dir-picker-section');
    expect(sections.map(section => section.text())).toEqual(['Repo', 'Other']);
    expect(w.findAll('.dir-picker-item')).toHaveLength(3);
    expect(w.find('.dir-picker-item__badge').text()).toBe('[Main]');
    w.unmount();
  });

  it('title includes CLI display name', () => {
    // Labels come from the CLI type record, never from a hardcoded slug table.
    state.cliToolsCache = { 'claude-code': { displayName: 'Claude', name: 'Claude' } };
    const w = factory();
    expect(w.text()).toContain('Claude');
    expect(w.text()).toContain('Select Directory');
    w.unmount();
  });

  it('does not render when not visible', () => {
    const w = factory({ visible: false });
    expect(w.find('#dirPickerList').exists()).toBe(false);
    w.unmount();
  });

  it('pre-selects matching path', () => {
    const w = factory({ preselectedPath: 'C:\\dev\\project-b' });
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(1);
    w.unmount();
  });

  it('gamepad navigation clamped', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('DPadDown');
    vm.handleButton('DPadDown');
    vm.handleButton('DPadDown');
    expect(vm.selectedIndex).toBe(2); // clamped at last
    vm.handleButton('DPadUp');
    expect(vm.selectedIndex).toBe(1);
    w.unmount();
  });

  it('gamepad A selects directory', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('DPadDown'); // index 1
    vm.handleButton('A');
    expect(w.emitted('select')?.[0]).toEqual(['C:\\dev\\project-b']);
    w.unmount();
  });

  it('gamepad B cancels', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('click selects', async () => {
    const w = factory();
    const items = w.findAll('.dir-picker-item');
    await items[2].trigger('click');
    expect(w.emitted('select')?.[0]).toEqual(['C:\\dev\\project-c']);
    w.unmount();
  });

  it('Tab moves selection down', () => {
    const w = factory();
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(0);
    vm.handleButton('Tab');
    expect(vm.selectedIndex).toBe(1);
    vm.handleButton('Tab');
    expect(vm.selectedIndex).toBe(2);
    vm.handleButton('Tab');
    expect(vm.selectedIndex).toBe(2); // clamped
    w.unmount();
  });

  it('ShiftTab moves selection up', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('DPadDown');
    vm.handleButton('DPadDown');
    expect(vm.selectedIndex).toBe(2);
    vm.handleButton('ShiftTab');
    expect(vm.selectedIndex).toBe(1);
    vm.handleButton('ShiftTab');
    expect(vm.selectedIndex).toBe(0);
    vm.handleButton('ShiftTab');
    expect(vm.selectedIndex).toBe(0); // clamped
    w.unmount();
  });

  it('pushes/pops modal stack', async () => {
    const w = factory();
    expect(modalStack.has('dir-picker')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('dir-picker')).toBe(false);
    w.unmount();
  });
});

// ============================================================================
// ContextMenu
// ============================================================================

import ContextMenu from '../../../renderer/components/modals/ContextMenu.vue';

describe('ContextMenu.vue', () => {
  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Record<string, any> = {}) {
    return mount(ContextMenu, {
      props: {
        visible: true,
        hasSelection: false,
        hasActiveSession: true,
        hasSequences: true,
        hasDrafts: true,
        isSnappedOut: false,
        ...props,
      },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders all menu items', () => {
    const w = factory();
    const items = w.findAll('.context-menu-item');
    expect(items.length).toBeGreaterThanOrEqual(8);
    w.unmount();
  });

  it('disables copy when no selection', () => {
    const w = factory({ hasSelection: false });
    const copyItem = w.find('[data-action="copy"]');
    expect(copyItem.classes()).toContain('context-menu-item--disabled');
    w.unmount();
  });

  it('enables copy when has selection', () => {
    const w = factory({ hasSelection: true });
    const copyItem = w.find('[data-action="copy"]');
    expect(copyItem.classes()).not.toContain('context-menu-item--disabled');
    w.unmount();
  });

  it('disables paste when no active session', () => {
    const w = factory({ hasActiveSession: false });
    const pasteItem = w.find('[data-action="paste"]');
    expect(pasteItem.classes()).toContain('context-menu-item--disabled');
    w.unmount();
  });

  it('gamepad D-pad down skips disabled items', () => {
    const w = factory({ hasSelection: false }); // Copy disabled
    const vm = w.vm as any;
    // First enabled item should be selected (Paste at index 1)
    expect(vm.selectedIndex).toBe(1); // skip disabled Copy
    vm.handleButton('DPadDown');
    expect(vm.selectedIndex).toBe(2); // Editor
    w.unmount();
  });

  it('gamepad A executes action and emits', () => {
    const w = factory();
    const vm = w.vm as any;
    // Navigate to "New Session" which is always enabled
    vm.selectedIndex = 3; // new-session
    vm.handleButton('A');
    expect(w.emitted('action')?.[0]).toEqual(['new-session']);
    w.unmount();
  });

  it('gamepad A on Cancel emits cancel', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.selectedIndex = 11; // Cancel item (after move-to-group + remove-from-group)
    vm.handleButton('A');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad B cancels', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('click on enabled item emits action', async () => {
    const w = factory();
    const newSession = w.find('[data-action="new-session"]');
    await newSession.trigger('click');
    expect(w.emitted('action')?.[0]).toEqual(['new-session']);
    w.unmount();
  });

  it('click on disabled item does nothing', async () => {
    const w = factory({ hasSelection: false });
    const copyItem = w.find('[data-action="copy"]');
    await copyItem.trigger('click');
    expect(w.emitted('action')).toBeUndefined();
    w.unmount();
  });

  it('pushes/pops modal stack', async () => {
    const w = factory();
    expect(modalStack.has('context-menu')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('context-menu')).toBe(false);
    w.unmount();
  });

  it('does not render when not visible', () => {
    const w = factory({ visible: false });
    expect(w.find('.context-menu').exists()).toBe(false);
    w.unmount();
  });
});

// ============================================================================
// DraftSubmenu
// ============================================================================

import DraftSubmenu from '../../../renderer/components/modals/DraftSubmenu.vue';

describe('DraftSubmenu.vue', () => {
  const drafts = [
    { id: 'd1', label: 'Draft 1', text: 'Hello' },
    { id: 'd2', label: 'Draft 2', text: 'World' },
  ];

  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Record<string, any> = {}) {
    return mount(DraftSubmenu, {
      props: { visible: true, drafts, ...props },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders New Draft + existing drafts', () => {
    const w = factory();
    const items = w.findAll('.context-menu-item');
    expect(items).toHaveLength(3); // New Draft + 2 drafts
    expect(items[0].text()).toContain('New Draft');
    expect(items[1].text()).toContain('Draft 1');
    expect(items[2].text()).toContain('Draft 2');
    w.unmount();
  });

  it('gamepad A on New Draft emits new-draft', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleSubmenuButton('A');
    expect(w.emitted('new-draft')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad navigation wraps through items', () => {
    const w = factory();
    const vm = w.vm as any;
    expect(vm.selectedIndex).toBe(0);
    vm.handleSubmenuButton('DPadDown');
    expect(vm.selectedIndex).toBe(1);
    vm.handleSubmenuButton('DPadDown');
    expect(vm.selectedIndex).toBe(2);
    vm.handleSubmenuButton('DPadDown');
    expect(vm.selectedIndex).toBe(0); // wrap
    w.unmount();
  });

  it('gamepad A on draft opens action picker', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleSubmenuButton('DPadDown'); // index 1 = Draft 1
    vm.handleSubmenuButton('A');
    expect(vm.showActions).toBe(true);
    expect(vm.activeDraft?.id).toBe('d1');
    expect(modalStack.has('draft-action')).toBe(true);
    w.unmount();
  });

  it('action picker emits apply', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleSubmenuButton('DPadDown'); // select Draft 1
    vm.handleSubmenuButton('A'); // open actions
    // Apply is index 0
    vm.handleActionButton('A');
    expect(w.emitted('apply')?.[0]?.[0]).toEqual(drafts[0]);
    w.unmount();
  });

  it('action picker B goes back to submenu', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleSubmenuButton('DPadDown');
    vm.handleSubmenuButton('A');
    expect(vm.showActions).toBe(true);
    vm.handleActionButton('B');
    expect(vm.showActions).toBe(false);
    expect(modalStack.has('draft-action')).toBe(false);
    w.unmount();
  });

  it('gamepad B on submenu cancels', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleSubmenuButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('pushes/pops modal stack', async () => {
    const w = factory();
    expect(modalStack.has('draft-submenu')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('draft-submenu')).toBe(false);
    w.unmount();
  });
});

// ============================================================================
// FormModal
// ============================================================================

import FormModal from '../../../renderer/components/modals/FormModal.vue';

describe('FormModal.vue', () => {
  const fields = [
    { key: 'name', label: 'Name', defaultValue: 'My Project' },
    { key: 'path', label: 'Path', type: 'text' as const, browse: true },
    { key: 'type', label: 'Type', type: 'select' as const, options: [
      { label: 'CLI', value: 'cli' },
      { label: 'GUI', value: 'gui' },
    ], defaultValue: 'cli' },
    { key: 'description', label: 'Description', type: 'textarea' as const },
  ];

  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Record<string, any> = {}) {
    return mount(FormModal, {
      props: { visible: true, title: 'Add Directory', fields, ...props },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders title and all fields', () => {
    const w = factory();
    expect(w.text()).toContain('Add Directory');
    expect(w.findAll('.binding-editor-field')).toHaveLength(4);
    w.unmount();
  });

  it('does not render when not visible', () => {
    const w = factory({ visible: false });
    expect(w.find('.modal').exists()).toBe(false);
    w.unmount();
  });

  it('initializes with default values', () => {
    const w = factory();
    const nameInput = w.find('#form-name');
    expect((nameInput.element as HTMLInputElement).value).toBe('My Project');
    w.unmount();
  });

  it('Save button emits save with form values', async () => {
    const w = factory();
    const saveBtn = w.findAll('button').find(b => b.text() === 'Save')!;
    await saveBtn.trigger('click');
    const emitted = w.emitted('save')?.[0]?.[0] as Record<string, string>;
    expect(emitted.name).toBe('My Project');
    expect(emitted.type).toBe('cli');
    w.unmount();
  });

  it('shows inline validation errors and stays open on invalid save', async () => {
    const w = mount(FormModal, {
      props: {
        visible: true,
        title: 'Add Action',
        fields: [
          { key: 'title', label: 'Title', required: true, defaultValue: '' },
          { key: 'description', label: 'Description', type: 'textarea' as const },
        ],
      },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });

    const saveBtn = w.findAll('button').find(b => b.text() === 'Save')!;
    await saveBtn.trigger('click');

    expect(w.emitted('save')).toBeUndefined();
    expect(w.emitted('update:visible')).toBeUndefined();
    expect(w.find('#form-title').attributes('aria-invalid')).toBe('true');
    expect(w.find('[role="alert"]').text()).toBe('Title is required.');
    expect(w.find('.modal').exists()).toBe(true);
    w.unmount();
  });

  it('clears required-field errors after valid input and then saves', async () => {
    const w = mount(FormModal, {
      props: {
        visible: true,
        title: 'Add Action',
        fields: [
          { key: 'title', label: 'Title', required: true, defaultValue: '' },
        ],
      },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });

    const saveBtn = w.findAll('button').find(b => b.text() === 'Save')!;
    await saveBtn.trigger('click');
    expect(w.find('[role="alert"]').text()).toBe('Title is required.');

    const titleInput = w.find('#form-title');
    await titleInput.setValue('Ship it');
    expect(w.find('[role="alert"]').exists()).toBe(false);
    await w.vm.$nextTick();
    expect(w.find('#form-title').attributes('aria-invalid')).toBeUndefined();

    await saveBtn.trigger('click');
    expect(w.emitted('save')?.[0]?.[0]).toEqual({ title: 'Ship it' });
    expect(w.emitted('update:visible')?.[0]).toEqual([false]);
    w.unmount();
  });

  it('Cancel button emits cancel', async () => {
    const w = factory();
    const cancelBtn = w.findAll('button').find(b => b.text() === 'Cancel')!;
    await cancelBtn.trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad B cancels', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('renders browse button for browse-enabled fields', () => {
    const w = factory();
    const browseBtn = w.findAll('.btn--sm');
    expect(browseBtn).toHaveLength(1);
    w.unmount();
  });

  it('renders select field with options', () => {
    const w = factory();
    const select = w.find('#form-type');
    const options = select.findAll('option');
    expect(options).toHaveLength(2);
    expect(options[0].text()).toBe('CLI');
    w.unmount();
  });

  it('renders textarea field', () => {
    const w = factory();
    const textarea = w.find('#form-description');
    expect(textarea.element.tagName).toBe('TEXTAREA');
    w.unmount();
  });

  it('pushes/pops modal stack', async () => {
    const w = factory();
    expect(modalStack.has('form-modal')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('form-modal')).toBe(false);
    w.unmount();
  });

  it('Tab focus trap wraps within form fields', async () => {
    const w = factory();
    const overlay = w.find('.modal-overlay');
    const nameInput = w.find('#form-name').element as HTMLInputElement;
    const saveButton = w.findAll('button').find(b => b.text() === 'Save')!.element as HTMLButtonElement;

    saveButton.focus();
    await overlay.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(nameInput);

    nameInput.focus();
    await overlay.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(saveButton);
    w.unmount();
  });

});

// ============================================================================
// BindingEditorModal
// ============================================================================

import BindingEditorModal from '../../../renderer/components/modals/BindingEditorModal.vue';

describe('BindingEditorModal.vue', () => {
  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
  });

  function factory(props: Record<string, any> = {}) {
    return mount(BindingEditorModal, {
      props: {
        visible: true,
        buttonName: 'A',
        cliType: 'claude-code',
        binding: null,
        ...props,
      },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders title with button and CLI name', () => {
    state.cliToolsCache = { 'claude-code': { displayName: 'Claude', name: 'Claude' } };
    const w = factory();
    expect(w.text()).toContain('A');
    expect(w.text()).toContain('Claude');
    w.unmount();
  });

  it('does not render when not visible', () => {
    const w = factory({ visible: false });
    expect(w.find('.modal').exists()).toBe(false);
    w.unmount();
  });

  it('defaults to keyboard action type', () => {
    const w = factory();
    const select = w.find('#be-action');
    expect((select.element as HTMLSelectElement).value).toBe('keyboard');
    w.unmount();
  });

  it('shows keyboard fields for keyboard action', () => {
    const w = factory();
    expect(w.find('#be-sequence').exists()).toBe(true);
    w.unmount();
  });

  it('shows voice fields when action is voice', async () => {
    const w = factory({ binding: { action: 'voice', key: 'F1', mode: 'tap' } });
    expect(w.find('#be-key').exists()).toBe(true);
    expect(w.find('#be-mode').exists()).toBe(true);
    expect(w.find('#be-target').exists()).toBe(true);
    w.unmount();
  });

  it('shows scroll fields when action is scroll', async () => {
    const w = factory({ binding: { action: 'scroll', direction: 'down', lines: 10 } });
    expect(w.find('#be-direction').exists()).toBe(true);
    expect(w.find('#be-lines').exists()).toBe(true);
    w.unmount();
  });

  it('Save emits binding with keyboard data', async () => {
    const w = factory();
    // Set sequence
    const textarea = w.find('#be-sequence');
    await textarea.setValue('/help{Enter}');
    const saveBtn = w.findAll('button').find(b => b.text() === 'Save')!;
    await saveBtn.trigger('click');
    const emitted = w.emitted('save')?.[0]?.[0] as any;
    expect(emitted.action).toBe('keyboard');
    expect(emitted.sequence).toBe('/help{Enter}');
    w.unmount();
  });

  it('Cancel emits cancel', async () => {
    const w = factory();
    const cancelBtn = w.findAll('button').find(b => b.text() === 'Cancel')!;
    await cancelBtn.trigger('click');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad B cancels', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('cancel')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad A saves', () => {
    const w = factory();
    const vm = w.vm as any;
    vm.handleButton('A');
    expect(w.emitted('save')).toHaveLength(1);
    w.unmount();
  });

  it('populates from existing binding', () => {
    const w = factory({
      binding: { action: 'voice', key: 'F5', mode: 'hold', target: 'terminal' },
    });
    const vm = w.vm as any;
    expect(vm.actionType).toBe('voice');
    expect(vm.voiceKey).toBe('F5');
    expect(vm.voiceMode).toBe('hold');
    expect(vm.voiceTarget).toBe('terminal');
    w.unmount();
  });

  it('pushes/pops modal stack', async () => {
    const w = factory();
    expect(modalStack.has('binding-editor')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('binding-editor')).toBe(false);
    w.unmount();
  });

  it('Tab focus trap wraps within binding editor fields', async () => {
    const w = factory();
    const overlay = w.find('.modal-overlay');
    const buttonInput = w.find('input[readonly]').element as HTMLInputElement;
    const saveButton = w.findAll('button').find(b => b.text() === 'Save')!.element as HTMLButtonElement;

    saveButton.focus();
    await overlay.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(buttonInput);

    buttonInput.focus();
    await overlay.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(saveButton);
    w.unmount();
  });
});

// ============================================================================
// EditorPopup — Enter/Ctrl+Enter textarea tests
// ============================================================================

vi.mock('../../../renderer/editor/editor-history.js', () => ({
  loadEditorHistory: vi.fn().mockResolvedValue([]),
  addEditorHistoryEntry: vi.fn().mockResolvedValue(undefined),
  getEditorHistoryPreview: (s: string) => s.slice(0, 40),
}));

import EditorPopup from '../../../renderer/components/modals/EditorPopup.vue';

describe('EditorPopup.vue', () => {
  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(() => {
    modalStack = useModalStack();
    modalStack.clear();
    (window as any).gamepadCli = {
      configGetEditorPrefs: vi.fn().mockResolvedValue({}),
      configSetEditorPrefs: vi.fn().mockResolvedValue(undefined),
      draftList: vi.fn().mockResolvedValue([]),
      draftCreate: vi.fn().mockResolvedValue({ id: 'draft-1' }),
      draftUpdate: vi.fn().mockResolvedValue(undefined),
      draftDelete: vi.fn().mockResolvedValue(undefined),
    };
  });

  function factory(props: Record<string, any> = {}) {
    return mount(EditorPopup, {
      props: { visible: true, ...props },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  it('renders when visible', async () => {
    const w = factory();
    await flushPromises();
    expect(w.find('.editor-popup').exists()).toBe(true);
    w.unmount();
  });

  it('Ctrl+Enter in textarea emits send', async () => {
    const w = factory({ initialText: 'hello', hasPrefill: true });
    await flushPromises();
    const textarea = w.find('.editor-popup__textarea');
    await textarea.trigger('keydown', { key: 'Enter', ctrlKey: true });
    await flushPromises();
    expect(w.emitted('send')?.[0]?.[0]).toBe('hello');
    w.unmount();
  });

  it('plain Enter in textarea does NOT emit send (allows newline)', async () => {
    const w = factory({ initialText: 'hello' });
    await flushPromises();
    const textarea = w.find('.editor-popup__textarea');
    await textarea.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('send')).toBeUndefined();
    w.unmount();
  });

  it('Escape in textarea emits close', async () => {
    const w = factory();
    await flushPromises();
    const textarea = w.find('.editor-popup__textarea');
    await textarea.trigger('keydown', { key: 'Escape' });
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();
  });

  it('gamepad B closes editor', async () => {
    const w = factory();
    await flushPromises();
    const vm = w.vm as any;
    vm.handleButton('B');
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();
  });

  it('pushes/pops modal stack', async () => {
    const w = factory();
    await flushPromises();
    expect(modalStack.has('editor-popup')).toBe(true);
    await w.setProps({ visible: false });
    expect(modalStack.has('editor-popup')).toBe(false);
    w.unmount();
  });

  it('uses shared confirm dialog for unsent close actions', async () => {
    const w = factory({ initialText: 'draft text', hasPrefill: true });
    await flushPromises();
    await w.find('.icon-button').trigger('click');
    await flushPromises();
    expect(w.findComponent(ConfirmDialog).exists()).toBe(true);
    await w.findAll('button').find(b => b.text() === 'Keep Editing')!.trigger('click');
    expect(w.emitted('close')).toBeUndefined();
    w.unmount();
  });

  it('auto-saves programmatic text changes and treats saved text as clean', async () => {
    vi.useFakeTimers();
    const { state } = await import('../../../renderer/state.js');
    state.activeSessionId = 'session-1';
    state.sessions = [{ id: 'session-1', name: 'main', cliType: 'codex', processId: 1, workingDir: 'X:\\coding\\project' }];
    const w = factory();
    await flushPromises();

    (w.vm as any).text = 'from history';
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();

    expect((window as any).gamepadCli.draftCreate).toHaveBeenCalledWith('X:\\coding\\project', 'ctrl-g-draft', 'from history');
    await w.find('.icon-button').trigger('click');
    await flushPromises();
    expect(w.find('.editor-popup-confirm-dialog').exists()).toBe(false);
    expect(w.emitted('close')).toHaveLength(1);
    state.activeSessionId = null;
    state.sessions = [];
    vi.useRealTimers();
    w.unmount();
  });

  it('reopens blank after sent content when no draft remains', async () => {
    const w = factory({ initialText: 'send me', hasPrefill: true });
    await flushPromises();

    await w.find('.btn--primary').trigger('click');
    await flushPromises();

    await w.setProps({ visible: false });
    await flushPromises();
    await w.setProps({ visible: true, initialText: '' });
    await flushPromises();

    const textarea = w.find('textarea');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('');
    w.unmount();
  });
});

// ============================================================================
// EditorPopup — explicit prefill signal vs saved ctrl-g draft (PT-6 regression)
// ============================================================================

describe('EditorPopup.vue prefill signal', () => {
  let modalStack: ReturnType<typeof useModalStack>;

  beforeEach(async () => {
    const { state } = await import('../../../renderer/state.js');
    state.activeSessionId = 'session-1';
    state.sessions = [{ id: 'session-1', name: 'main', cliType: 'codex', processId: 1, workingDir: 'X:\\coding\\project' }];
    modalStack = useModalStack();
    modalStack.clear();
    (window as any).gamepadCli = {
      configGetEditorPrefs: vi.fn().mockResolvedValue({}),
      configSetEditorPrefs: vi.fn().mockResolvedValue(undefined),
      // A saved ctrl-g draft is present for the active scope.
      draftList: vi.fn().mockResolvedValue([
        { id: 'draft-9', label: 'ctrl-g-draft', text: 'STALE DRAFT' },
      ]),
      draftCreate: vi.fn().mockResolvedValue({ id: 'draft-9' }),
      draftUpdate: vi.fn().mockResolvedValue(undefined),
      draftDelete: vi.fn().mockResolvedValue(undefined),
    };
  });

  function factory(props: Record<string, any> = {}) {
    return mount(EditorPopup, {
      props: { visible: true, ...props },
      attachTo: document.body,
      global: { stubs: GLOBAL_STUBS },
    });
  }

  function value(w: VueWrapper<any>): string {
    return (w.find('textarea').element as HTMLTextAreaElement).value;
  }

  it('applying an empty template body opens EMPTY (saved draft does not leak in)', async () => {
    const w = factory({ initialText: '', hasPrefill: true });
    await flushPromises();
    expect(value(w)).toBe('');
    w.unmount();
  });

  it('failed-lookup/empty prefill path opens empty', async () => {
    // usePromptApplyFlow falls back to body='' with hasPrefill=true on lookup failure.
    const w = factory({ initialText: '', hasPrefill: true });
    await flushPromises();
    expect(value(w)).toBe('');
    w.unmount();
  });

  it('plain Ctrl+G open (no prefill) restores the saved draft', async () => {
    const w = factory(); // no initialText, no hasPrefill
    await flushPromises();
    expect(value(w)).toBe('STALE DRAFT');
    w.unmount();
  });

  it('non-empty template body prefills and overrides the saved draft', async () => {
    const w = factory({ initialText: 'TEMPLATE BODY', hasPrefill: true });
    await flushPromises();
    expect(value(w)).toBe('TEMPLATE BODY');
    w.unmount();
  });

  afterEach(async () => {
    const { state } = await import('../../../renderer/state.js');
    state.activeSessionId = null;
    state.sessions = [];
  });
});
