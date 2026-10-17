import type { Ref } from 'vue';
import { state } from '../state.js';
import { getTerminalManager } from '../runtime/terminal-provider.js';
import { toDirection, navigateFocus } from '../utils.js';
import { processConfigBinding, processConfigRelease, releaseVoiceTalk } from '../bindings.js';
import {
  handlePlanScreenDpad,
  handlePlanScreenAction,
} from '../plans/plan-screen.js';
import { handleSessionsScreenButton } from '../screens/sessions.js';
import { useModalStack } from './useModalStack.js';
import { useModalKeyboardBridge } from './useModalKeyboardBridge.js';
import { isAnyBridgeModalVisible } from '../stores/modal-bridge.js';
import type { PaneId } from '../dock-types.js';

type MainViewState = 'terminal' | 'plan';

interface ButtonTarget {
  handleButton?: (button: string) => boolean | void;
}

interface NavigationController {
  closeSettings(): void;
  closePlan(): Promise<void> | void;
  navigateToSession(sessionId: string): Promise<void> | void;
}

export interface InputRouterDeps {
  settingsVisible: Ref<boolean>;
  activeView: Ref<MainViewState>;
  bindingEditorVisible: Ref<boolean>;
  itemEditorVisible: Ref<boolean>;
  itemEditorRef: Ref<ButtonTarget | null>;
  settingsPanelRef: Ref<ButtonTarget | null>;
  navStore: NavigationController;
  /** Identity of the dock pane that owns gamepad input. */
  focusedPaneId?: Ref<PaneId | null>;
  /** Last focusable item identity recorded inside a pane. */
  getFocusedItemId?: (paneId: PaneId) => string | null;
}

export function useInputRouter(deps: InputRouterDeps) {
  function focusedPaneRoot(paneId: PaneId): HTMLElement | null {
    const panes = document.querySelectorAll<HTMLElement>('[data-dock-pane-id]');
    return Array.from(panes).find(pane => pane.dataset.dockPaneId === paneId) ?? null;
  }

  function restorePaneItemFocus(paneId: PaneId, root: HTMLElement): void {
    const itemId = deps.getFocusedItemId?.(paneId);
    if (!itemId) return;
    const candidate = Array.from(root.querySelectorAll<HTMLElement>('.focusable, [data-focus-id], button, input, select, textarea'))
      .find(element => element.dataset.focusId === itemId
        || element.id === itemId
        || element.getAttribute('name') === itemId
        || element.getAttribute('aria-label') === itemId
        || (element.dataset.navIndex && `nav:${element.dataset.navIndex}` === itemId));
    candidate?.focus();
  }

  function handleGenericPaneInput(button: string, paneId: PaneId): boolean {
    const root = focusedPaneRoot(paneId);
    if (!root) return false;
    restorePaneItemFocus(paneId, root);
    const dir = toDirection(button);
    if (dir) {
      navigateFocus(dir === 'up' || dir === 'left' ? -1 : 1, root);
      return true;
    }
    if (button === 'A') {
      const active = document.activeElement;
      if (active instanceof HTMLElement && root.contains(active) && active.classList.contains('focusable')) {
        active.click();
      } else {
        getFirstFocusable(root)?.focus();
      }
      return true;
    }
    return button === 'B';
  }

  function getFirstFocusable(root: HTMLElement): HTMLElement | null {
    return root.querySelector<HTMLElement>('.focusable:not([hidden]):not([disabled])');
  }

  function handleButton(button: string): void {
    if (button === 'Sandwich' || button === 'Guide') {
      deps.settingsVisible.value = false;
      deps.navStore.closeSettings();
      return;
    }

    const { handleInput } = useModalStack();
    if (handleInput(button)) return;

    if (isAnyBridgeModalVisible()) return;
    if (deps.bindingEditorVisible.value) return;

    if (deps.itemEditorVisible.value) {
      deps.itemEditorRef.value?.handleButton?.(button);
      return;
    }

    if (deps.settingsVisible.value) {
      // SettingsScreen owns the pane model; B from its nav emits close.
      const handled = deps.settingsPanelRef.value?.handleButton?.(button);
      if (!handled && button === 'B') {
        deps.settingsVisible.value = false;
        deps.navStore.closeSettings();
      }
      return;
    }

    const focusedPane = deps.focusedPaneId?.value;
    const routeByFocus = focusedPane !== undefined && focusedPane !== null;

    if ((routeByFocus ? focusedPane === 'plan-screen' : deps.activeView.value === 'plan')) {
      const dir = toDirection(button);
      if (dir) { handlePlanScreenDpad(dir); return; }
      if (button === 'B') { void deps.navStore.closePlan(); return; }
      if (handlePlanScreenAction(button)) return;
    }

    if (routeByFocus) {
      if (focusedPane === 'sessions') {
        handleSessionsScreenButton(button);
        return;
      } else if (focusedPane !== 'terminal' && focusedPane) {
        if (handleGenericPaneInput(button, focusedPane)) return;
      }
    } else if (handleSessionsScreenButton(button)) return;

    const tm = getTerminalManager();
    const activeSession = tm?.getActiveSessionId();
    const session = state.sessions.find(s => s.id === activeSession);
    const cliType = session?.cliType;
    if (cliType) {
      processConfigBinding(button);
    }
  }

  /**
   * Release actions (hold-to-talk, hold-to-repeat) belong to the terminal's CLI
   * binding, so they only fire while the terminal owns focus. A release routed
   * into a tool pane would otherwise reach the PTY behind the user's back.
   */
  function handleRelease(button: string): void {
    if (releaseVoiceTalk(button)) return;
    const focusedPane = deps.focusedPaneId?.value;
    if (focusedPane !== undefined && focusedPane !== null && focusedPane !== 'terminal') return;
    const tm = getTerminalManager();
    const activeSession = tm?.getActiveSessionId();
    const session = state.sessions.find(s => s.id === activeSession);
    if (session?.cliType) {
      processConfigRelease(button);
    }
  }

  const { handler: handleModalKeyboardBridge } = useModalKeyboardBridge();

  return {
    handleButton,
    handleRelease,
    handleModalKeyboardBridge,
  };
}
