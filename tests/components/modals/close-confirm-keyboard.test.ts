/**
 * Close confirmation through the production keyboard router and modal bridge.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import CloseConfirmModal from '../../../renderer/components/modals/CloseConfirmModal.vue';
import SessionCard from '../../../renderer/components/sidebar/SessionCard.vue';
import { useModalKeyboardBridge } from '../../../renderer/composables/useModalKeyboardBridge.js';
import { useModalStack } from '../../../renderer/composables/useModalStack.js';
import { installKeyRouter, registerKeyHandler, resetKeyHandlers } from '../../../renderer/keyboard/router.js';
import { PANE_TERMINAL } from '../../../renderer/dock-types.js';

let uninstallRouter: (() => void) | null = null;
let unmountHarness: (() => void) | null = null;

function mountCloseFlow() {
  const requestClose = vi.fn();
  const confirmClose = vi.fn();
  const cancelClose = vi.fn();

  const Harness = defineComponent({
    setup() {
      const visible = ref(false);
      const sessionCardProps = {
        session: { id: 's1', name: 'worker', cliType: 'claude-code' },
        navIndex: 0,
        sessionState: 'idle',
        activityLevel: 'idle',
        displayName: 'worker',
        artifactCount: 0,
        unreadChatCount: 0,
        loopContinues: 0,
        pendingSubagents: 0,
        elapsedText: '',
        workingPlanLabel: '',
        workingPlanTooltip: '',
        isActive: false,
        isFocused: false,
        focusColumn: 0,
        isEditing: false,
        llmNotifications: [],
      };

      return () => h('div', [
        h(SessionCard, {
          ...sessionCardProps,
          onClose: () => {
            requestClose();
            visible.value = true;
          },
        } as never),
        h(CloseConfirmModal, {
          visible: visible.value,
          sessionName: 'worker',
          'onUpdate:visible': (value: boolean) => { visible.value = value; },
          onConfirm: confirmClose,
          onCancel: cancelClose,
        }),
      ]);
    },
  });

  const wrapper = mount(Harness, { attachTo: document.body });
  unmountHarness = () => wrapper.unmount();
  return { requestClose, confirmClose, cancelClose };
}

function press(target: Element, type: 'keydown' | 'keyup', key: string): KeyboardEvent {
  const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function dialogButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.modal-footer button')];
}

beforeEach(() => {
  document.body.innerHTML = '';
  const modalStack = useModalStack();
  modalStack.clear();
  resetKeyHandlers();

  const { handler } = useModalKeyboardBridge();
  registerKeyHandler({
    id: 'modal-stack-bridge',
    scope: 'modal',
    handle: (ctx) => handler(ctx.event),
  });
  uninstallRouter = installKeyRouter({
    getActiveSessionId: () => 's1',
    getFocusedPane: () => PANE_TERMINAL,
    isPaneVisible: () => true,
    isModalOpen: () => modalStack.isOpen.value,
  });
});

afterEach(() => {
  unmountHarness?.();
  unmountHarness = null;
  uninstallRouter?.();
  uninstallRouter = null;
  useModalStack().clear();
  resetKeyHandlers();
  document.body.innerHTML = '';
});

describe('close confirmation keyboard path', () => {
  it('Tabs to Close, activates the highlighted action with Space, and does not re-request close', async () => {
    const flow = mountCloseFlow();
    const opener = document.querySelector<HTMLButtonElement>('.session-close')!;
    opener.focus();
    opener.click();
    await nextTick();

    expect(flow.requestClose).toHaveBeenCalledOnce();
    expect(useModalStack().topId.value).toBe('close-confirm');
    expect(document.activeElement).not.toBe(opener);
    const keyboardTarget = document.activeElement as HTMLElement;
    expect(dialogButtons().map(button => button.classList.contains('btn--focused'))).toEqual([true, false]);

    const tab = press(keyboardTarget, 'keydown', 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    await nextTick();
    expect(dialogButtons().map(button => button.classList.contains('btn--focused'))).toEqual([false, true]);

    const space = press(keyboardTarget, 'keydown', ' ');
    expect(space.defaultPrevented).toBe(true);
    await nextTick();
    expect(flow.confirmClose).toHaveBeenCalledOnce();
    expect(flow.cancelClose).not.toHaveBeenCalled();
    expect(useModalStack().isOpen.value).toBe(false);

    // jsdom does not synthesize the browser's native Space keyup click default.
    press(keyboardTarget, 'keyup', ' ');
    expect(flow.requestClose).toHaveBeenCalledOnce();
  });

  it('wraps to Cancel on the second Tab and activates the highlighted cancel action', async () => {
    const flow = mountCloseFlow();
    const opener = document.querySelector<HTMLButtonElement>('.session-close')!;
    opener.focus();
    opener.click();
    await nextTick();
    expect(document.activeElement).not.toBe(opener);
    const keyboardTarget = document.activeElement as HTMLElement;

    expect(press(keyboardTarget, 'keydown', 'Tab').defaultPrevented).toBe(true);
    await nextTick();
    expect(press(keyboardTarget, 'keydown', 'Tab').defaultPrevented).toBe(true);
    await nextTick();
    expect(dialogButtons().map(button => button.classList.contains('btn--focused'))).toEqual([true, false]);

    expect(press(keyboardTarget, 'keydown', ' ').defaultPrevented).toBe(true);
    await nextTick();
    expect(flow.cancelClose).toHaveBeenCalledOnce();
    expect(flow.confirmClose).not.toHaveBeenCalled();
    expect(useModalStack().isOpen.value).toBe(false);
  });
});
