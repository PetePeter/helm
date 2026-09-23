/**
 * Terminal Manager — orchestrates multiple embedded terminal instances.
 *
 * Handles creation, switching, resize, PTY IPC data routing, and cleanup.
 * Each terminal is a TerminalView backed by a PTY process on the main side.
 */

import { TerminalView } from './terminal-view.js';
import { fitAndSyncPty } from './fit-and-sync-pty.js';
import { PtyOutputBuffer } from './pty-output-buffer.js';
import { resolveSuccessorSessionId } from './successor-pick.js';
import type { SessionInfo } from '../../src/types/session.js';
import { loadStoredSessions } from '../session-store.js';
import { eventsClient, terminalClient } from '../ipc/clients.js';
import { cliTypeWantsMouseTracking } from '../utils.js';

export interface TerminalSession {
  sessionId: string;
  cliType: string;
  name: string;
  title?: string;
  view: TerminalView;
  element: HTMLElement;
  cwd?: string;
}

export type ManagedTerminalSession = SessionInfo & {
  title?: string;
};

export class TerminalManager {
  private terminals: Map<string, TerminalSession> = new Map();
  private managedSessions: Map<string, ManagedTerminalSession> = new Map();
  private activeSessionId: string | null = null;
  private container: HTMLElement;
  private unsubscribers: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;
  private onEmpty: (() => void) | null = null;
  private visibleOrderProvider: (() => string[]) | null = null;
  private onSwitch: ((sessionId: string | null) => void) | null = null;
  private onTitleChangeCallback: ((sessionId: string, title: string) => void) | null = null;
  private pendingFitCancel: (() => void) | null = null;
  private fitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fitWatchdog: ReturnType<typeof setInterval> | null = null;
  private outputBuffer: PtyOutputBuffer;
  private snapBackBuffer: Map<string, string[]> = new Map();

  constructor(container: HTMLElement) {
    this.container = container;
    this.outputBuffer = new PtyOutputBuffer(50);
    this.setupIpcListeners();
    this.setupResizeObserver();
    this.fitWatchdog = setInterval(() => this.fitActive(), 60_000);
  }

  /** Get the shared PTY output buffer for preview display */
  getOutputBuffer(): PtyOutputBuffer {
    return this.outputBuffer;
  }

  /** Register a callback invoked when the last terminal is destroyed */
  setOnEmpty(callback: () => void): void {
    this.onEmpty = callback;
  }

  setOnSwitch(callback: (sessionId: string | null) => void): void {
    this.onSwitch = callback;
  }

  /**
   * Register the source of visible session order (navList display order, with
   * collapsed-group / hidden / snapped-out sessions already excluded). Used to
   * hand over to the right terminal when the active one is destroyed or detached.
   * Without a provider — child windows, tests — insertion order is used.
   */
  setVisibleOrderProvider(provider: () => string[]): void {
    this.visibleOrderProvider = provider;
  }

  /** Register a callback invoked when a terminal's OSC title changes */
  setOnTitleChange(callback: (sessionId: string, title: string) => void): void {
    this.onTitleChangeCallback = callback;
  }

  /** Deselect the active terminal without destroying it. Keyboard relay stops routing. */
  deselect(): void {
    if (!this.activeSessionId) return;
    this.activeSessionId = null;
    this.onSwitch?.(null);
  }

  /** Create a new terminal and spawn its PTY process */
  async createTerminal(
    sessionId: string,
    cliType: string,
    command: string,
    args: string[] = [],
    cwd?: string,
    contextText?: string,
    resumeSessionName?: string,
  ): Promise<boolean> {
    if (this.terminals.has(sessionId)) return false;

    const element = document.createElement('div');
    element.className = 'terminal-pane';
    element.dataset.sessionId = sessionId;
    element.style.display = 'none';
    this.container.appendChild(element);

    const view = new TerminalView({
      sessionId,
      container: element,
      mouseTracking: cliTypeWantsMouseTracking(cliType),
      onData: (data) => {
        terminalClient.ptyWrite?.(sessionId, data);
      },
      onScrollInput: (data) => {
        terminalClient.ptyScrollInput?.(sessionId, data);
      },
      onResize: (cols, rows) => {
        terminalClient.ptyResize?.(sessionId, cols, rows);
      },
      onTitleChange: (title) => {
        const sess = this.terminals.get(sessionId);
        if (sess) {
          sess.title = title;
          this.onTitleChangeCallback?.(sessionId, title);
        }
      },
    });

    this.terminals.set(sessionId, { sessionId, cliType, name: cliType, view, element, cwd });
    this.upsertManagedSession({
      id: sessionId,
      name: cliType,
      cliType,
      processId: 0,
      workingDir: cwd,
    });

    // Intercept right-click before xterm.js processes it (prevents CLIs with
    // mouse tracking from interpreting right-click as paste)
    element.addEventListener('mousedown', (e) => {
      if (e.button === 2) {
        e.stopPropagation();
      }
    }, true);

    // Right-click context menu on the terminal pane
    element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Capture selection synchronously before the async import clears it
      const sess = this.terminals.get(sessionId);
      const selectedText = sess?.view?.getSelection() ?? '';
      const hasSelection = sess?.view?.hasSelection() ?? false;
      import('../stores/modal-bridge.js').then(({ showContextMenu }) => {
        showContextMenu(sessionId, selectedText, hasSelection);
      });
    });

    const result = await terminalClient.ptySpawn?.(sessionId, command, args, cwd, cliType, contextText, resumeSessionName);
    console.log(`[TerminalManager] ptySpawn result:`, JSON.stringify(result));
    if (!result?.success) {
      console.error(`[TerminalManager] ptySpawn failed:`, result?.error || 'no result');
      this.destroyTerminal(sessionId);
      return false;
    }

    // Always activate the newly created terminal
    this.switchTo(sessionId);

    return true;
  }

  /**
   * Adopt an externally-spawned PTY session (e.g. from Telegram).
   * Creates xterm.js view and registers in the terminal map WITHOUT calling pty:spawn.
   * PTY data routing works automatically via setupIpcListeners which matches by sessionId.
   */
  adoptTerminal(
    sessionId: string,
    cliType: string,
    cwd?: string,
    name?: string,
  ): void {
    if (this.terminals.has(sessionId)) return;

    const element = document.createElement('div');
    element.className = 'terminal-pane';
    element.dataset.sessionId = sessionId;
    element.style.display = 'none';
    this.container.appendChild(element);

    const view = new TerminalView({
      sessionId,
      container: element,
      mouseTracking: cliTypeWantsMouseTracking(cliType),
      onData: (data) => {
        terminalClient.ptyWrite?.(sessionId, data);
      },
      onScrollInput: (data) => {
        terminalClient.ptyScrollInput?.(sessionId, data);
      },
      onResize: (cols, rows) => {
        terminalClient.ptyResize?.(sessionId, cols, rows);
      },
      onTitleChange: (title) => {
        const sess = this.terminals.get(sessionId);
        if (sess) {
          sess.title = title;
          this.onTitleChangeCallback?.(sessionId, title);
        }
      },
    });

    const resolvedName = name?.trim() || cliType;
    this.terminals.set(sessionId, { sessionId, cliType, name: resolvedName, view, element, cwd });
    this.upsertManagedSession({
      id: sessionId,
      name: resolvedName,
      cliType,
      processId: 0,
      workingDir: cwd,
    });

    // Flush any PTY data that arrived during the snap-back gap
    const buffered = this.snapBackBuffer.get(sessionId);
    if (buffered?.length) {
      for (const chunk of buffered) view.write(chunk);
    }
    this.snapBackBuffer.delete(sessionId);

    element.addEventListener('mousedown', (e) => {
      if (e.button === 2) {
        e.stopPropagation();
      }
    }, true);

    element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Capture selection synchronously before the async import clears it
      const sess = this.terminals.get(sessionId);
      const selectedText = sess?.view?.getSelection() ?? '';
      const hasSelection = sess?.view?.hasSelection() ?? false;
      import('../stores/modal-bridge.js').then(({ showContextMenu }) => {
        showContextMenu(sessionId, selectedText, hasSelection);
      });
    });

    // Don't auto-switch — let the user choose when to look at it
  }

  /** Switch the visible terminal */
  switchTo(sessionId: string): void {
    const session = this.terminals.get(sessionId);
    if (!session) return;

    // Mark switching BEFORE fit/resize to suppress false activity promotion
    terminalClient.ptyMarkSwitching?.(sessionId);

    // Hide current
    if (this.activeSessionId) {
      const current = this.terminals.get(this.activeSessionId);
      if (current) {
        current.element.style.display = 'none';
        current.view.blur();
      }
    }

    // Show new
    session.element.style.display = 'block';
    this.activeSessionId = sessionId;

    // Fit and focus after layout — double-RAF so the display:block reflow is
    // measured by FitAddon. Cancel pending rAF to avoid stacking on rapid switches.
    this.pendingFitCancel?.();
    this.pendingFitCancel = fitAndSyncPty(
      sessionId,
      session.view,
      (id, cols, rows) => terminalClient.ptyResize?.(id, cols, rows),
    );
    session.view.focus();

    this.onSwitch?.(sessionId);
  }

  /** Get the active session ID */
  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /** Get the active terminal view (convenience for context menu, etc.) */
  getActiveView(): TerminalView | null {
    if (!this.activeSessionId) return null;
    return this.terminals.get(this.activeSessionId)?.view ?? null;
  }

  /** Move all existing terminal elements to a new host without remounting xterm. */
  adoptHost(nextHost: HTMLElement | null): boolean {
    if (!nextHost || nextHost === this.container) return false;
    for (const session of this.terminals.values()) {
      nextHost.appendChild(session.element);
    }
    this.container = nextHost;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.setupResizeObserver();
    this.fitActive();
    return true;
  }

  /** Focus the currently active terminal */
  focusActive(): void {
    if (this.activeSessionId) {
      const session = this.terminals.get(this.activeSessionId);
      session?.view.focus();
    }
  }

  /** Refit the active terminal after layout changes (e.g. panel resize).
   *  Double-RAF ensures the DOM has fully reflowed before FitAddon measures.
   *  Snapshots the sessionId so a rapid switch between call and execution
   *  doesn't fit the wrong (hidden) terminal. */
  fitActive(): void {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    this.pendingFitCancel?.();
    const session = this.terminals.get(sessionId);
    if (!session) return;
    this.pendingFitCancel = fitAndSyncPty(
      sessionId,
      session.view,
      (id, cols, rows) => terminalClient.ptyResize?.(id, cols, rows),
    );
  }

  /** Get all terminal session IDs */
  getSessionIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /** Hydrate durable session records from the persistent store into runtime ownership. */
  hydrateSessions(records: ManagedTerminalSession[]): void {
    const seen = new Set<string>();
    for (const record of records) {
      seen.add(record.id);
      this.upsertManagedSession(record);
    }

    for (const id of Array.from(this.managedSessions.keys())) {
      if (this.terminals.has(id)) continue;
      if (!seen.has(id)) this.managedSessions.delete(id);
    }
  }

  /** Load persisted session records through the session-store bridge. */
  async hydrateFromStore(): Promise<ManagedTerminalSession[]> {
    const records = await loadStoredSessions();
    this.hydrateSessions(records as ManagedTerminalSession[]);
    return this.getManagedSessions();
  }

  /** Get all sessions TerminalManager currently owns, including stored dormant records. */
  getManagedSessions(): ManagedTerminalSession[] {
    const merged = new Map<string, ManagedTerminalSession>();
    for (const [id, record] of this.managedSessions) {
      merged.set(id, { ...record });
    }

    for (const [id, terminal] of this.terminals) {
      const existing = merged.get(id);
      merged.set(id, {
        ...(existing ?? {
          id,
          processId: 0,
          workingDir: terminal.cwd,
        }),
        id,
        name: terminal.name || existing?.name || terminal.cliType,
        cliType: terminal.cliType || existing?.cliType || 'unknown',
        workingDir: terminal.cwd || existing?.workingDir,
        title: terminal.title || existing?.title,
      });
    }

    return Array.from(merged.values());
  }

  /** Remove a session from TerminalManager's durable runtime registry. */
  removeManagedSession(sessionId: string): void {
    this.managedSessions.delete(sessionId);
  }

  /** Get terminal session info */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.terminals.get(sessionId);
  }

  /** Update the display name for a terminal session */
  renameSession(sessionId: string, newName: string): void {
    const session = this.terminals.get(sessionId);
    if (session) {
      session.name = newName;
    }
    const managed = this.managedSessions.get(sessionId);
    if (managed) {
      this.managedSessions.set(sessionId, { ...managed, name: newName });
    }
  }

  /** Get the OSC title for a terminal session */
  getTitle(sessionId: string): string | undefined {
    return this.terminals.get(sessionId)?.title;
  }

  /** Destroy a terminal and kill its PTY */
  destroyTerminal(sessionId: string): void {
    const session = this.terminals.get(sessionId);
    if (!session) return;

    session.view.dispose();
    session.element.remove();
    this.terminals.delete(sessionId);
    this.managedSessions.delete(sessionId);

    terminalClient.ptyKill?.(sessionId);
    this.outputBuffer.clear(sessionId);

    this.handOverActive(sessionId);
  }

  /**
   * Hand the active slot over after `sessionId` stopped being managed here.
   * Picks the next session in visible order; when terminals remain but none are
   * visible (all in collapsed groups) we deselect rather than activate a session
   * the user cannot see. onEmpty stays reserved for "no terminals at all".
   */
  private handOverActive(sessionId: string): void {
    if (this.activeSessionId !== sessionId) return;
    this.activeSessionId = null;

    const remaining = Array.from(this.terminals.keys());
    if (remaining.length === 0) {
      this.onEmpty?.();
      return;
    }

    const visibleOrder = this.visibleOrderProvider?.();
    const next = visibleOrder
      ? resolveSuccessorSessionId(visibleOrder, remaining, sessionId)
      : remaining[0];

    if (next) {
      this.switchTo(next);
    } else {
      this.onSwitch?.(null);
    }
  }

  /** Detach a terminal from this manager without killing the PTY.
   *  Used when a session is snapped out to a child window.
   *  When buffer=true, PTY data arriving during the gap is buffered for flush on adoptTerminal. */
  detachTerminal(sessionId: string, buffer = false): void {
    const session = this.terminals.get(sessionId);
    if (!session) return;

    session.view.dispose();
    session.element.remove();
    this.terminals.delete(sessionId);
    this.outputBuffer.clear(sessionId);
    if (buffer) this.snapBackBuffer.set(sessionId, []);

    this.handOverActive(sessionId);
  }

  /** Write data to a terminal's display (from PTY output) */
  writeToTerminal(sessionId: string, data: string): void {
    const session = this.terminals.get(sessionId);
    if (session) {
      session.view.write(data);
    } else if (this.snapBackBuffer.has(sessionId)) {
      // Buffer PTY data during the snap-back gap (detach → adopt)
      const chunks = this.snapBackBuffer.get(sessionId)!;
      chunks.push(data);
      if (chunks.length > 200) chunks.shift(); // cap buffer to prevent unbounded growth
    }
  }

  /** Fit all visible terminals to their containers */
  fitAll(): void {
    for (const [, session] of this.terminals) {
      if (session.element.style.display !== 'none') {
        fitAndSyncPty(
          session.sessionId,
          session.view,
          (id, cols, rows) => terminalClient.ptyResize?.(id, cols, rows),
        );
      }
    }
  }

  /** Get the number of terminals */
  getCount(): number {
    return this.terminals.size;
  }

  /** Check if a terminal exists */
  has(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }

  /** Check if a session is an embedded terminal (alias for has) */
  hasTerminal(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }

  /**
   * Materialise a terminal view on-demand for a session that exists in
   * managedSessions (hydrated from store) but has no xterm.js view yet.
   * Replays PtyOutputBuffer scrollback so the user sees history immediately.
   * Idempotent — no-op if the view already exists or session is unknown.
   */
  ensureTerminal(sessionId: string): void {
    if (this.terminals.has(sessionId)) return;

    const managed = this.managedSessions.get(sessionId);
    if (!managed) return;

    const element = document.createElement('div');
    element.className = 'terminal-pane';
    element.dataset.sessionId = sessionId;
    element.style.display = 'none';
    this.container.appendChild(element);

    const view = new TerminalView({
      sessionId,
      container: element,
      mouseTracking: cliTypeWantsMouseTracking(managed.cliType),
      onData: (data) => { terminalClient.ptyWrite?.(sessionId, data); },
      onScrollInput: (data) => { terminalClient.ptyScrollInput?.(sessionId, data); },
      onResize: (cols, rows) => { terminalClient.ptyResize?.(sessionId, cols, rows); },
      onTitleChange: (title) => {
        const sess = this.terminals.get(sessionId);
        if (sess) {
          sess.title = title;
          this.onTitleChangeCallback?.(sessionId, title);
        }
      },
    });

    this.terminals.set(sessionId, {
      sessionId,
      cliType: managed.cliType ?? 'unknown',
      name: managed.name || managed.cliType || 'unknown',
      view,
      element,
      cwd: managed.workingDir,
    });

    // Replay buffered scrollback so user sees history, not a blank screen
    const lines = this.outputBuffer.getLastLines(sessionId, 50);
    if (lines.length > 0) {
      view.write(lines.join('\n'));
    }

    // Drain snap-back buffer if a detach→adopt gap was in progress
    const buffered = this.snapBackBuffer.get(sessionId);
    if (buffered?.length) {
      for (const chunk of buffered) view.write(chunk);
    }
    this.snapBackBuffer.delete(sessionId);

    element.addEventListener('mousedown', (e) => {
      if (e.button === 2) e.stopPropagation();
    }, true);

    element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sess = this.terminals.get(sessionId);
      const selectedText = sess?.view?.getSelection() ?? '';
      const hasSelection = sess?.view?.hasSelection() ?? false;
      import('../stores/modal-bridge.js').then(({ showContextMenu }) => {
        showContextMenu(sessionId, selectedText, hasSelection);
      });
    });
  }

  /** Read last N lines from a terminal's xterm.js buffer */
  getTerminalLines(sessionId: string, count: number): string[] {
    const session = this.terminals.get(sessionId);
    return session ? session.view.getBufferLines(count) : [];
  }

  /** Clean up all terminals and listeners */
  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    for (const id of Array.from(this.terminals.keys())) {
      this.destroyTerminal(id);
    }

    this.pendingFitCancel?.();
    this.pendingFitCancel = null;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.fitDebounceTimer !== null) {
      clearTimeout(this.fitDebounceTimer);
      this.fitDebounceTimer = null;
    }
    if (this.fitWatchdog !== null) {
      clearInterval(this.fitWatchdog);
      this.fitWatchdog = null;
    }
  }

  /** Set up IPC event listeners for PTY data routing */
  private setupIpcListeners(): void {
    if (!eventsClient.onPtyData) return;

    const unsubData = eventsClient.onPtyData((sessionId: string, data: string) => {
      this.writeToTerminal(sessionId, data);
      this.outputBuffer.append(sessionId, data);
    });
    this.unsubscribers.push(unsubData);

    const unsubExit = eventsClient.onPtyExit((sessionId: string, _exitCode: number) => {
      const session = this.terminals.get(sessionId);
      if (session) {
        session.view.write('\r\n\x1b[33m[Process exited]\x1b[0m\r\n');
      }
    });
    this.unsubscribers.push(unsubExit);
  }

  private upsertManagedSession(record: ManagedTerminalSession): void {
    const existing = this.managedSessions.get(record.id);
    this.managedSessions.set(record.id, {
      ...existing,
      ...record,
      name: record.name || existing?.name || record.cliType,
      processId: record.processId ?? existing?.processId ?? 0,
    });
  }

  /** Observe container resize to re-fit terminals.
   *  Debounced at 50ms so CSS transitions settle before FitAddon measures. */
  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitDebounceTimer !== null) clearTimeout(this.fitDebounceTimer);
      this.fitDebounceTimer = setTimeout(() => {
        this.fitDebounceTimer = null;
        this.fitAll();
      }, 50);
    });
    this.resizeObserver.observe(this.container);
  }
}
