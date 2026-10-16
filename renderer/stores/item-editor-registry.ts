/**
 * Item editor registry — module-level callback registry for non-Vue callers.
 *
 * The active window controller (MainWindowApp.vue or SnapOutWindow.vue)
 * registers opener/closer/handler callbacks on mount. Non-Vue modules
 * (bindings.ts, navigation.ts, paste-handler.ts) call through these to
 * interact with the mounted ItemEditor.vue instance.
 */

import type { PlanStatus, PlanType } from '../../src/types/plan.js';
import type { PlanCallbacks } from '../components/panels/ItemEditor.vue';

export type { PlanCallbacks };

type PlanEditorOpener = (sessionId: string, plan: { id: string; title: string; description: string; status: PlanStatus; stateInfo?: string; type?: PlanType; completionNotes?: string }, callbacks: PlanCallbacks) => void;

let _planOpener: PlanEditorOpener | null = null;
let _closer: (() => void) | null = null;
let _visibilityChecker: (() => boolean) | null = null;
let _buttonHandler: ((button: string) => void) | null = null;
let _planChangesChecker: (() => boolean) | null = null;

export function setPlanEditorOpener(fn: PlanEditorOpener): void { _planOpener = fn; }
export function setItemEditorCloser(fn: () => void): void { _closer = fn; }
export function setItemEditorVisibilityChecker(fn: () => boolean): void { _visibilityChecker = fn; }
export function setItemEditorButtonHandler(fn: (button: string) => void): void { _buttonHandler = fn; }
export function setPlanChangesChecker(fn: () => boolean): void { _planChangesChecker = fn; }

export function showPlanInEditor(
  sessionId: string,
  plan: { id: string; title: string; description: string; status: PlanStatus; stateInfo?: string; type?: PlanType; humanId?: string; createdAt?: number; stateUpdatedAt?: number; completionNotes?: string },
  callbacks: PlanCallbacks,
): void {
  _planOpener?.(sessionId, plan, callbacks);
}

export function hideItemEditor(): void { _closer?.(); }

export function isItemEditorVisible(): boolean { return _visibilityChecker?.() ?? false; }

export function handleItemEditorButton(button: string): void {
  if (!_buttonHandler) {
    console.warn('[ItemEditorRegistry] handleItemEditorButton called but no handler registered');
    return;
  }
  _buttonHandler(button);
}

export function hasUnsavedPlanChanges(): boolean { return _planChangesChecker?.() ?? false; }
