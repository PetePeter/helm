/**
 * Modal keyboard bridge — the shared key→modal-stack mapping.
 *
 * Translates raw keyboard events into modal-stack gamepad inputs so that
 * keyboard users can drive selection-mode modals (context menu, pickers,
 * confirm dialogs) exactly like the gamepad does. Used by both the main
 * window and the snap-out popout window so behaviour stays identical across
 * windows.
 *
 * Registered with the keyboard router as a `modal`-scope handler. `handler`
 * reports whether it consumed the key; suppression is the router's job.
 */

import { useModalStack } from './useModalStack.js';
import { useEscProtection } from './useEscProtection.js';
import {
  getActiveInputContext,
  isEditableElement,
  isEditableElementInContainer,
  MODAL_NAVIGATION_SELECTOR,
} from '../input/input-ownership.js';

function isEditableElementInsideModal(element: Element | null): element is HTMLElement {
  return isEditableElement(element) && isEditableElementInContainer(
    element,
    '.modal-overlay.modal--visible, .scheduled-tasks-tab--popup',
  );
}

function searchInputAllowsNavigation(element: Element | null, key: string): boolean {
  if (!(element instanceof HTMLInputElement) || !element.hasAttribute('data-modal-arrow-navigation')) return false;
  if (key === 'ArrowUp' || key === 'ArrowDown') return true;
  if (key === 'ArrowLeft') return element.selectionStart === 0 && element.selectionEnd === 0;
  if (key === 'ArrowRight') {
    return element.selectionStart === element.value.length && element.selectionEnd === element.value.length;
  }
  return false;
}

export function useModalKeyboardBridge() {
  /**
   * Returns true when the key was consumed. No-op unless a modal is open and
   * the modal declares interest in the pressed key via its interceptKeys policy.
   */
  function handler(e: KeyboardEvent): boolean {
    const stack = useModalStack();
    if (!stack.isOpen.value) return false;

    const active = document.activeElement;
    const activeContext = getActiveInputContext({
      activeElement: active,
      modalNavigationSelectors: MODAL_NAVIGATION_SELECTOR,
    });
    const editableInModal = activeContext === 'editable-field' && isEditableElementInsideModal(active);
    const searchNavigation = editableInModal && searchInputAllowsNavigation(active, e.key);
    const interceptKeys = stack.topInterceptKeys.value;
    const escProtection = useEscProtection();

    // While ESC protection is up, any non-Escape key dismisses it and is swallowed.
    if (escProtection.isProtecting.value && e.key !== 'Escape') {
      escProtection.dismissProtection();
      return true;
    }

    if (e.key === 'ArrowUp') {
      if (!interceptKeys.has('arrows') || (editableInModal && !searchNavigation)) return false;
      stack.handleInput('DPadUp');
    } else if (e.key === 'ArrowDown') {
      if (!interceptKeys.has('arrows') || (editableInModal && !searchNavigation)) return false;
      stack.handleInput('DPadDown');
    } else if (e.key === 'ArrowLeft') {
      if (!interceptKeys.has('arrows') || (editableInModal && !searchNavigation)) return false;
      stack.handleInput('DPadLeft');
    } else if (e.key === 'ArrowRight') {
      if (!interceptKeys.has('arrows') || (editableInModal && !searchNavigation)) return false;
      stack.handleInput('DPadRight');
    } else if (e.key === 'Tab') {
      if (!interceptKeys.has('tab')) return false;
      stack.handleInput(e.shiftKey ? 'ShiftTab' : 'Tab');
    } else if (e.key === 'Enter') {
      if (!interceptKeys.has('enter') || (editableInModal && document.activeElement?.tagName === 'TEXTAREA')) return false;
      stack.handleInput('A');
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      if (!interceptKeys.has('space') || editableInModal) return false;
      stack.handleInput('A');
    } else if (e.key === 'Escape') {
      if (!interceptKeys.has('escape')) return false;
      stack.handleInput('B');
    } else if (e.key >= '0' && e.key <= '9' && e.key.length === 1) {
      // Jump numbers: bare digit selects the Nth row in a selection modal.
      if (!interceptKeys.has('digits') || editableInModal) return false;
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      stack.handleInput(`Digit${e.key}`);
    } else if (e.key.length === 1 && e.key >= 'a' && e.key <= 'z') {
      // Jump letters: bare letter selects the Nth row in a tree picker (positions 10-35).
      if (!interceptKeys.has('letters') || editableInModal) return false;
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      stack.handleInput(`Key${e.key.toUpperCase()}`);
    } else {
      return false;
    }

    return true;
  }

  return { handler };
}
