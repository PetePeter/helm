import { appClient, attachmentsClient, configClient, contextsClient, deliveryClient, dialogClient, draftsClient, eventsClient, incomingClient, keyboardClient, patternsClient, plansClient, projectsClient, schedulerClient, sessionsClient, systemClient, telegramClient, terminalClient, toolsClient } from '../ipc/clients.js';
/**
 * Navigation store — centralized view routing + sidebar focus.
 *
 * Single write authority for:
 *   - Panel view (terminal / overview / plan) — mirrors main-view-manager
 *   - Active session ID — via stores/app.ts `setActiveSessionId`, the single
 *     guard that a session-pinned window (snap-out pop-out) relies on
 *   - Sidebar focus (identity-based — survives navList rebuilds)
 *   - Overlay lifecycle (open/close overview, plan, settings)
 *
 * Existing reactive singletons (state.ts, sessions-state.ts) remain the
 * read path for components. The store writes to them; no competing refs.
 *
 * main-view-manager.ts remains the DOM transition engine — this store
 * delegates view transitions to showView() and mirrors the result via
 * onViewChange().
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { state } from '../state.js';
import { setActiveSessionId } from './app.js';
import { sessionsState } from '../screens/sessions-state.js';
import { hideDraftEditor } from './draft-editor-registry.js';
import {
  showView,
  onViewChange,
  currentView,
  type MainView,
} from '../main-view/main-view-manager.js';
import { findNavIndexBySessionId } from '../session-groups.js';
import { getTerminalManager } from '../runtime/terminal-provider.js';
import { useChipBarStore } from './chip-bar.js';

export type ActivationResult =
  | { kind: 'local-terminal'; sessionId: string }
  | { kind: 'snapped-out'; sessionId: string }
  | { kind: 'unavailable'; sessionId: string }
  | { kind: 'failed'; sessionId: string; error: unknown };

export const useNavigationStore = defineStore('navigation', () => {
  // ── Panel view (mirrors main-view-manager) ───────────────────────────
  // Not a competing ref — updated exclusively via onViewChange listener.
  const _panelView = ref<MainView>(currentView());
  const panelView = computed(() => _panelView.value);

  // ── Overlay restore context ──────────────────────────────────────────
  // Saved on overlay open, consumed on overlay close.
  const _previousSessionId = ref<string | null>(null);
  const _savedFocusItem = ref<{ id: string; type: string } | null>(null);

  // ── Identity-based sidebar focus ─────────────────────────────────────
  // Store { id, type } not index — survives navList rebuilds.
  const focusedNavItem = ref<{ id: string; type: string } | null>(null);
  const focusColumn = ref<0 | 1 | 2 | 3 | 4 | 5>(0);

  // ── Initialization ───────────────────────────────────────────────────
  let initialized = false;
  let unsubViewChange: (() => void) | null = null;
  let navigationRequestId = 0;

  function init(): void {
    if (initialized) return;
    initialized = true;

    unsubViewChange = onViewChange((view: MainView) => {
      _panelView.value = view;
    });

    // Seed identity from current sidebar focus
    const navItem = sessionsState.navList[sessionsState.sessionsFocusIndex];
    if (navItem) {
      focusedNavItem.value = { id: navItem.id, type: navItem.type };
      focusColumn.value = sessionsState.cardColumn;
    }
  }

  // ── Focus helpers ────────────────────────────────────────────────────

  /** Derive numeric navList index from identity-based focusedNavItem. */
  function resolveFocusIndex(): number {
    if (!focusedNavItem.value) return sessionsState.sessionsFocusIndex;
    const idx = sessionsState.navList.findIndex(
      item => item.type === focusedNavItem.value!.type && item.id === focusedNavItem.value!.id,
    );
    return idx >= 0 ? idx : sessionsState.sessionsFocusIndex;
  }

  /** Write identity-based focus to sessionsState numeric fields. */
  function syncFocusIndex(): void {
    sessionsState.sessionsFocusIndex = resolveFocusIndex();
    sessionsState.cardColumn = focusColumn.value;
  }

  /** Re-read sidebar focus from sessionsState (legacy writes may have changed it). */
  function captureCurrentFocus(): void {
    const navItem = sessionsState.navList[sessionsState.sessionsFocusIndex];
    if (navItem) {
      focusedNavItem.value = { id: navItem.id, type: navItem.type };
      focusColumn.value = sessionsState.cardColumn;
    }
  }

  /** Set sidebar focus to a specific session card by ID. */
  function syncSidebarToSession(sessionId: string): void {
    const navItem = sessionsState.navList[findNavIndexBySessionId(sessionsState.navList, sessionId)];
    focusedNavItem.value = { id: sessionId, type: navItem?.type ?? 'session-card' };
    focusColumn.value = 0;
    syncFocusIndex();
  }

  // ── Navigation actions ───────────────────────────────────────────────

  /** Keep the main-process session authority aligned with renderer navigation. */
  async function setMainActiveSession(sessionId: string): Promise<void> {
    try {
      await sessionsClient.sessionSetActive?.(sessionId);
    } catch (error) {
      // Local navigation should remain usable if the authority sync fails;
      // the next explicit navigation will retry it.
      console.warn(`[Navigation] Failed to sync active session ${sessionId}:`, error);
    }
  }

  /**
   * Full UX transition — dismiss overlays, switch terminal, sync sidebar,
   * hide draft/editor, clear chip bar.
   *
   * Use for: sidebar session click, notification click, overview card select.
   */
  async function navigateToSession(sessionId: string): Promise<ActivationResult> {
    const requestId = ++navigationRequestId;
    const isLatestRequest = () => requestId === navigationRequestId;
    const cv = currentView();

    // Always clear restore context — we're navigating to a concrete session.
    // Covers the case where overview's selectCard callback already dismissed
    // the overlay before this runs (so cv === 'terminal' with stale context).
    _previousSessionId.value = null;
    _savedFocusItem.value = null;

    // 1. Dismiss overlays (skip their restore — we're going somewhere new)
    if (cv === 'overview') {
      const { setSelectedOnExit } = await import('../screens/group-overview.js');
      if (!isLatestRequest()) return { kind: 'failed', sessionId, error: 'stale request' };
      setSelectedOnExit(true);
      await showView('terminal');
    } else if (cv === 'plan') {
      await showView('terminal');
    }
    if (!isLatestRequest()) return { kind: 'failed', sessionId, error: 'stale request' };

    // 2. Clean up draft/editor/chip bar
    const [{ hideEditorPopup }, chipBarMod] = await Promise.all([
      import('../editor/editor-popup.js'),
      import('../stores/chip-bar.js'),
    ]);
    if (!isLatestRequest()) return { kind: 'failed', sessionId, error: 'stale request' };
    const chipBarStore = chipBarMod.useChipBarStore();
    hideDraftEditor();
    hideEditorPopup();
    chipBarStore.clear();

    // 3. Focus snapped-out sessions via the main process so their owning
    // window is activated instead of assuming the terminal lives locally.
    if (state.snappedOutSessions.has(sessionId)) {
      await setMainActiveSession(sessionId);
      if (!isLatestRequest()) return { kind: 'failed', sessionId, error: 'stale request' };
      setActiveSessionId(sessionId);
      syncSidebarToSession(sessionId);
      void chipBarStore.refresh(sessionId);
      return { kind: 'snapped-out', sessionId };
    }

    // 4. Materialise terminal on-demand for remote-spawned sessions that
    // exist in managedSessions but have no xterm.js view yet, then switch.
    const tm = getTerminalManager();
    if (tm) {
      tm.ensureTerminal(sessionId);
      if (tm.hasTerminal(sessionId)) {
        await setMainActiveSession(sessionId);
        if (!isLatestRequest()) return { kind: 'failed', sessionId, error: 'stale request' };
        tm.switchTo(sessionId);
        setActiveSessionId(sessionId);
        syncSidebarToSession(sessionId);
        void chipBarStore.refresh(sessionId);
        return { kind: 'local-terminal', sessionId };
      }
    }

    // No local terminal and not snapped-out — unavailable
    return { kind: 'unavailable', sessionId };
  }

  /**
   * Thin session switch — set activeSessionId + switch terminal only.
   * No overlay dismissal, no sidebar sync, no draft/chip cleanup.
   *
   * Use for: D-pad auto-select, Ctrl+Tab cycling.
   */
  function activateSession(sessionId: string): ActivationResult {
    ++navigationRequestId;

    if (state.snappedOutSessions.has(sessionId)) {
      void setMainActiveSession(sessionId);
      setActiveSessionId(sessionId);
      void useChipBarStore().refresh(sessionId);
      return { kind: 'snapped-out', sessionId };
    }

    const tm = getTerminalManager();
    if (tm?.hasTerminal(sessionId)) {
      void setMainActiveSession(sessionId);
      tm.switchTo(sessionId);
      setActiveSessionId(sessionId);
      void useChipBarStore().refresh(sessionId);
      return { kind: 'local-terminal', sessionId };
    }
    return { kind: 'unavailable', sessionId };
  }

  // ── Overlay lifecycle ────────────────────────────────────────────────

  async function openOverview(dirPath: string | null, initialSessionId?: string): Promise<void> {
    ++navigationRequestId;
    // If transitioning from plan, its unmount runs during showView('overview') — no special flag needed.

    // Re-read legacy focus before saving (D-pad may have moved it)
    captureCurrentFocus();

    // Save restore context (preserve existing if chaining overlay → overlay)
    if (_previousSessionId.value === null) {
      _previousSessionId.value = state.activeSessionId;
    }
    if (!_savedFocusItem.value) {
      _savedFocusItem.value = focusedNavItem.value ? { ...focusedNavItem.value } : null;
    }

    await showView('overview', { groupDirPath: dirPath, initialSessionId });
  }

  /**
   * Close overview and restore previous terminal + sidebar focus.
   * Delegates to group-overview.ts unmount for terminal/DOM restore,
   * then reads back the result to update identity-based focus.
   */
  async function closeOverview(): Promise<void> {
    ++navigationRequestId;
    await showView('terminal');

    // Overview unmount restores terminal + numeric sidebar focus.
    // Read back the restored index and update identity tracker.
    const currentIdx = Math.min(
      sessionsState.sessionsFocusIndex,
      Math.max(0, sessionsState.navList.length - 1),
    );
    sessionsState.sessionsFocusIndex = currentIdx;
    const navItem = sessionsState.navList[currentIdx];
    if (navItem) {
      focusedNavItem.value = { id: navItem.id, type: navItem.type };
    }
    _previousSessionId.value = null;
    _savedFocusItem.value = null;
  }

  async function openPlan(dirPath: string): Promise<void> {
    ++navigationRequestId;
    // If overview is open, tell it to skip restore
    if (currentView() === 'overview') {
      const { setSelectedOnExit } = await import('../screens/group-overview.js');
      setSelectedOnExit(true);
    }

    // Re-read legacy focus before saving (D-pad may have moved it)
    captureCurrentFocus();

    // Plan is a session aspect, not a selection UI: opening it must not save
    // or later rewrite the selected session.
    if (!_savedFocusItem.value) {
      _savedFocusItem.value = focusedNavItem.value ? { ...focusedNavItem.value } : null;
    }

    await showView('plan', { dir: dirPath });
  }

  /**
   * Close plan and return to the terminal without changing session selection.
   * Plan has no selection restore logic; only the sidebar focus identity is
   * retained for the dock navigation cursor.
   */
  async function closePlan(): Promise<void> {
    ++navigationRequestId;
    const savedFocus = _savedFocusItem.value;
    _previousSessionId.value = null;
    _savedFocusItem.value = null;

    await showView('terminal');

    // Restore sidebar focus
    if (savedFocus) {
      focusedNavItem.value = savedFocus;
      syncFocusIndex();
    }

    // Refresh the chip bar for the session that remains selected.
    const { useChipBarStore } = await import('../stores/chip-bar.js');
    void useChipBarStore().refresh(state.activeSessionId);
  }

  function openSettings(): void {
    state.currentScreen = 'settings';
  }

  function closeSettings(): void {
    state.currentScreen = 'sessions';
  }

  // ── NavList rebuild ──────────────────────────────────────────────────

  /**
   * Reconcile after an external terminal switch (e.g. destroyTerminal auto-selects
   * next session, or internal TerminalManager logic). Updates state + sidebar +
   * chip bar without calling tm.switchTo (avoids re-entrancy).
   */
  async function reconcileTerminalSwitch(sessionId: string | null): Promise<void> {
    if (sessionId) {
      setActiveSessionId(sessionId);
      syncSidebarToSession(sessionId);
    } else {
      setActiveSessionId(null);
    }
    const { useChipBarStore } = await import('../stores/chip-bar.js');
    void useChipBarStore().refresh(sessionId);
  }

  /**
   * Re-derive numeric focus index from identity after navList changes.
   * Call after refreshSessions() rebuilds navList.
   */
  function onNavListRebuilt(): void {
    if (!focusedNavItem.value) return;

    const idx = sessionsState.navList.findIndex(
      item => item.type === focusedNavItem.value!.type && item.id === focusedNavItem.value!.id,
    );

    if (idx >= 0) {
      sessionsState.sessionsFocusIndex = idx;
      return;
    }

    // Focused item gone — fall back to active session
    if (state.activeSessionId) {
      const activeIdx = findNavIndexBySessionId(sessionsState.navList, state.activeSessionId);
      if (activeIdx >= 0) {
        sessionsState.sessionsFocusIndex = activeIdx;
        const nav = sessionsState.navList[activeIdx];
        focusedNavItem.value = { id: nav.id, type: nav.type };
        return;
      }
    }

    // Clamp to valid range
    sessionsState.sessionsFocusIndex = Math.min(
      sessionsState.sessionsFocusIndex,
      Math.max(0, sessionsState.navList.length - 1),
    );
    const clamped = sessionsState.navList[sessionsState.sessionsFocusIndex];
    if (clamped) {
      focusedNavItem.value = { id: clamped.id, type: clamped.type };
    }
  }

  // ── Test utilities ───────────────────────────────────────────────────

  /** Test-only — dispose listeners and reset state. */
  function __dispose(): void {
    if (unsubViewChange) {
      unsubViewChange();
      unsubViewChange = null;
    }
    initialized = false;
    _panelView.value = 'terminal';
    _previousSessionId.value = null;
    _savedFocusItem.value = null;
    focusedNavItem.value = null;
    focusColumn.value = 0;
  }

  /** Test-only — read restore context for assertions. */
  function __getRestoreContext() {
    return {
      previousSessionId: _previousSessionId.value,
      savedFocusItem: _savedFocusItem.value,
    };
  }

  return {
    // State (readonly)
    panelView,
    focusedNavItem,
    focusColumn,

    // Init
    init,

    // Focus
    captureCurrentFocus,
    resolveFocusIndex,
    syncFocusIndex,
    syncSidebarToSession,

    // Navigation actions
    navigateToSession,
    activateSession,
    reconcileTerminalSwitch,

    // Overlay lifecycle
    openOverview,
    closeOverview,
    openPlan,
    closePlan,

    // Settings
    openSettings,
    closeSettings,

    // NavList rebuild
    onNavListRebuilt,

    // Test-only
    __dispose,
    __getRestoreContext,
  };
});
