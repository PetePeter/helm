/**
 * Terminal provider — framework-agnostic singleton for the TerminalManager.
 *
 * Replaces the `getTerminalManager()` export from `main.ts` so that any
 * module can access the terminal manager without importing the orchestrator.
 */

import type { TerminalManager } from '../terminal/terminal-manager.js';

let _terminalManager: TerminalManager | null = null;
const changeListeners = new Set<(tm: TerminalManager | null) => void>();

export function getTerminalManager(): TerminalManager | null {
  return _terminalManager;
}

export function setTerminalManager(tm: TerminalManager | null): void {
  _terminalManager = tm;
  for (const listener of changeListeners) listener(tm);
}

/**
 * Subscribe to manager replacement. Composables created before app bootstrap
 * (dock panes mount first, useAppBootstrap constructs the manager later) use
 * this to attach to the output buffer once it exists. Returns an unsubscribe.
 */
export function onTerminalManagerChanged(listener: (tm: TerminalManager | null) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function adoptTerminalHost(host: HTMLElement | null): boolean {
  return _terminalManager?.adoptHost(host) ?? false;
}
