/**
 * MainViewManager — owns the `#mainArea` right panel.
 *
 * Two views share the panel mutually exclusively:
 *   - 'terminal' — the active xterm.js session
 *   - 'plan'     — the planner canvas for a directory
 *
 * Each view registers mount/unmount handlers at startup. Calling
 * `show(view, params)` transitions from the current view to the target
 * one: the old view's `unmount` runs first, then the new view's `mount`.
 *
 * Replaces the ad-hoc pattern of callers hiding sibling overlays
 * (scattered `hidePlanScreen()` calls, lazy
 * `import('../plans/plan-screen.js').then(...)` blocks).
 */

export type MainView = 'terminal' | 'plan';

export interface ViewMountContext {
  transitionId: number;
  isActive: () => boolean;
}

export interface ViewHandlers {
  /** Called when this view becomes current. Receives params from show(). */
  mount: (params?: unknown, context?: ViewMountContext) => void | Promise<void>;
  /** Called when another view is about to take over. Must clean up DOM + listeners. */
  unmount: () => void;
}

type ChangeListener = (view: MainView) => void;

const handlers = new Map<MainView, ViewHandlers>();
const listeners = new Set<ChangeListener>();
let current: MainView = 'terminal';
let transitionCounter = 0;

/** Register handlers for a view. Idempotent — last registration wins. */
export function registerView(view: MainView, h: ViewHandlers): void {
  handlers.set(view, h);
}

/** The currently active view. */
export function currentView(): MainView {
  return current;
}

/**
 * Transition to `view`. Unmounts the current view then mounts the target.
 * When target === current the call is treated as a refresh: unmount is
 * skipped but mount runs so callers can pass fresh params.
 */
export async function showView(view: MainView, params?: unknown): Promise<void> {
  const transitionId = ++transitionCounter;
  const prev = current;
  const prevHandlers = handlers.get(prev);
  if (prevHandlers && prev !== view) {
    try { prevHandlers.unmount(); } catch (err) { console.error('[MainView] unmount failed:', err); }
  }
  current = view;
  if (prev !== view) {
    for (const cb of listeners) {
      try { cb(view); } catch (err) { console.error('[MainView] listener failed:', err); }
    }
  }
  const next = handlers.get(view);
  if (next) {
    const context: ViewMountContext = {
      transitionId,
      isActive: () => transitionCounter === transitionId && current === view,
    };
    try {
      await next.mount(params, context);
      if (!context.isActive()) return;
    } catch (err) {
      console.error('[MainView] mount failed:', err);
      if (!context.isActive()) return;
    }
  }
}

/** Subscribe to view-change events. Returns an unsubscribe function. */
export function onViewChange(cb: ChangeListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test-only — reset manager state. */
export function __resetMainViewManager(): void {
  handlers.clear();
  listeners.clear();
  current = 'terminal';
  transitionCounter = 0;
}
