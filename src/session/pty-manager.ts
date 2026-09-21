import { EventEmitter } from 'events';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';
import { validateProjectDirectory } from './validation.js';
import {
  buildPastePayload,
  BRACKETED_PASTE_POLL_MS,
  BRACKETED_PASTE_READY_BUDGET_MS,
  RENAME_QUIET_BUDGET_MS,
  RENAME_QUIET_POLL_MS,
  RENAME_QUIET_WINDOW_MS,
  SUBMIT_SETTLE_DELAY_MS,
  type TextDeliveryOptions,
} from './delivery-context.js';
import { BracketedPasteTracker } from './bracketed-paste-tracker.js';
import { TerminalOutputBuffer, type TerminalOutputMode, type TerminalTail } from './terminal-output-buffer.js';

const esmRequire = createRequire(import.meta.url);

/**
 * How a PTY write registers on the activity dots.
 *
 * 'input'  — real stdin. Marks the session active, whoever the caller is.
 * 'scroll' — scrollback keys. The redraw they provoke is not new work, and
 *            promoting it would turn every scroll green (invariant 8).
 * 'system' — an app-owned reminder. It must not fabricate user activity or
 *            restart the idle timer (invariant 8).
 */
export type WriteIntent = 'input' | 'scroll' | 'system';

export interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (exitCode: { exitCode: number; signal?: number }) => void) => void;
}

export interface PtySpawnOptions {
  sessionId: string;
  /** CLI command to spawn (escaped with args via escapeShellArg). Ignored when rawCommand is set. */
  command?: string;
  args?: string[];
  /** Raw command string written to shell stdin as-is (no escaping). Use for resume commands like `copilot --continue`. */
  rawCommand?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface PtyFactory {
  spawn(
    file: string,
    args: string[],
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> },
  ): PtyProcess;
}

/**
 * Escape a shell argument to prevent metacharacter injection.
 * On Windows (PowerShell): wraps in single quotes, escapes internal single quotes.
 * On Unix (bash): wraps in single quotes, escapes internal single quotes.
 * Simple alphanumeric/hyphen/dot values are passed through unchanged.
 */
function escapeShellArg(arg: string): string {
  if (/^[a-zA-Z0-9._\-/\\:]+$/.test(arg)) return arg;
  if (process.platform === 'win32') {
    return `'${arg.replace(/'/g, "''")}'`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve the shell (and args) that backs a PTY.
 *
 * Windows: cmd.exe with no args — the historical default shell.
 *
 * macOS/Linux: the user's own login shell ($SHELL, e.g. /bin/zsh) started as an
 * interactive login shell (-il) so it sources the user's profile
 * (.zprofile/.zshrc, .bash_profile/.profile) — exactly like a real terminal tab.
 * This is critical for GUI-launched .app bundles: launchd hands the app only a
 * stripped PATH (/usr/bin:/bin:/usr/sbin:/sbin), so without sourcing the profile
 * the PTY can't find user-installed CLIs like `claude` (~/.local/bin) or Homebrew
 * tools (/opt/homebrew/bin). $SHELL is preferred over bash because PATH additions
 * typically live in the user's actual shell's rc files, not bash's. `npm start`
 * from a terminal didn't show the bug because it already inherited the full PATH.
 */
export function resolvePtyShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'cmd.exe', args: [] };
  return { file: env.SHELL || 'bash', args: ['-il'] };
}

/**
 * Manages PTY processes for embedded terminals.
 *
 * Accepts an optional PtyFactory for dependency injection so tests can
 * provide a mock without requiring the native node-pty module.
 *
 * Events:
 * - 'data' (sessionId: string, data: string) — PTY output
 * - 'exit' (sessionId: string, exitCode: number) — PTY exited
 */
export class PtyManager extends EventEmitter {
  private ptys: Map<string, PtyProcess> = new Map();
  /** Set once the app is quitting — see beginShutdown(). */
  private shuttingDown = false;
  private factory: PtyFactory;
  /** Marks a session active on stdin. Injected so PtyManager stays free of StateDetector. */
  private activityMarker?: (sessionId: string) => void;
  private terminalOutputBuffer = new TerminalOutputBuffer();
  /** Main-process view of each CLI's DEC 2004 state, for sessions with no renderer. */
  private bracketedPaste = new BracketedPasteTracker();
  private writeCounts: Map<string, number> = new Map();
  /** Last-known PTY dimensions per session (node-pty's PtyProcess does not expose cols/rows). */
  private sizes: Map<string, { cols: number; rows: number }> = new Map();
  /** Timestamp of each session's most recent PTY output, for quiet-window waits. */
  private lastOutputAt: Map<string, number> = new Map();

  constructor(factory?: PtyFactory) {
    super();
    if (factory) {
      this.factory = factory;
    } else {
      // Lazy-load node-pty at runtime to avoid import errors in test environments.
      this.factory = {
        spawn: (file, args, opts) => {
          const pty = esmRequire('node-pty');
          return pty.spawn(file, args, opts);
        },
      };
    }
  }

  /** Spawn a new PTY process. */
  spawn(options: PtySpawnOptions): PtyProcess {
    const { sessionId, command, args = [], rawCommand, cwd, cols = 120, rows = 30, env } = options;

    if (this.ptys.has(sessionId)) {
      throw new Error(`PTY already exists for session: ${sessionId}`);
    }

    const { file: shell, args: shellArgs } = resolvePtyShell();

    // A requested cwd is part of the caller's intent: silently starting the CLI
    // somewhere else produces a session recorded against a project it never
    // opened. Only the "no directory asked for" case falls back to home.
    let resolvedCwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
    if (cwd) {
      try {
        validateProjectDirectory(cwd);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.error(`[PTY] Refusing to spawn session ${sessionId}: ${reason}`);
        throw new Error(`Cannot start session in "${cwd}": ${reason}`);
      }
      resolvedCwd = cwd;
    }

    const ptyProcess = this.factory.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolvedCwd,
      env: { ...process.env, ...env } as Record<string, string>,
    });

    this.ptys.set(sessionId, ptyProcess);
    this.sizes.set(sessionId, { cols, rows });
    // Seed the quiet-window clock at spawn: a session that has never spoken
    // counts as busy from birth, not from the epoch — its first paint is
    // still ahead of it and a write landed now would be split by it.
    this.lastOutputAt.set(sessionId, Date.now());

    // Attach error handlers to internal pipe Sockets to prevent unhandled errors from crashing the process.
    // node-pty internals may change — guard with existence checks.
    const agent = (ptyProcess as any)._agent;
    if (agent) {
      const inSocket = agent._inSocket || agent.inSocket;
      const outSocket = agent._outSocket || agent.outSocket;
      if (inSocket?.on) inSocket.on('error', (err: Error) => logger.error(`[PTY] Socket error (in) for ${sessionId}: ${err.message}`));
      if (outSocket?.on) outSocket.on('error', (err: Error) => logger.error(`[PTY] Socket error (out) for ${sessionId}: ${err.message}`));
    }

    ptyProcess.onData((data: string) => {
      this.terminalOutputBuffer.append(sessionId, data);
      this.bracketedPaste.observe(sessionId, data);
      this.lastOutputAt.set(sessionId, Date.now());
      this.emit('data', sessionId, data);
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      this.ptys.delete(sessionId);
      this.terminalOutputBuffer.clear(sessionId);
      this.bracketedPaste.clear(sessionId);
      this.writeCounts.delete(sessionId);
      this.sizes.delete(sessionId);
      this.lastOutputAt.delete(sessionId);
      // During app shutdown every PTY dies at once; those exits are not
      // session closures, so no listener may act on them.
      if (this.shuttingDown) return;
      this.emit('exit', sessionId, exitCode);
    });

    // Write initial command to shell stdin.
    // rawCommand: written as-is (for resume commands like `copilot --continue`)
    // command+args: escaped to prevent metacharacter injection (for fresh spawns)
    try {
      if (rawCommand) {
        ptyProcess.write(rawCommand + '\r');
      } else if (command) {
        const escapedArgs = args.map(arg => escapeShellArg(arg));
        const escapedCommand = escapeShellArg(command);
        const fullCommand = escapedArgs.length > 0
          ? escapedCommand + ' ' + escapedArgs.join(' ')
          : escapedCommand;
        ptyProcess.write(fullCommand + '\r');
      }
    } catch (error) {
      logger.error(`[PTY] Initial command write failed for ${sessionId}: ${error}`);
    }

    logger.info(`[PTY] Spawned session ${sessionId}: ${rawCommand || command} (PID ${ptyProcess.pid})`);
    return ptyProcess;
  }

  /**
   * Write data to a session's PTY stdin.
   *
   * Marking lives here rather than in the pty:write IPC handler so that bytes
   * originating in the main process — MCP and Telegram delivery, pattern-matcher
   * send-text — move the activity dots too. Genuinely user-origin concerns
   * (interaction-channel affinity, the Telegram input hook) stay in the handler.
   */
  write(sessionId: string, data: string, intent: WriteIntent = 'input'): void {
    const pty = this.ptys.get(sessionId);
    if (!pty) {
      logger.warn(`[PTY] No PTY found for session: ${sessionId} (available: ${[...this.ptys.keys()].join(', ')})`);
      return;
    }
    try {
      pty.write(data);
      this.writeCounts.set(sessionId, (this.writeCounts.get(sessionId) ?? 0) + 1);
    } catch (error) {
      logger.error(`[PTY] Write failed for session=${sessionId}: ${error}`);
      return;
    }
    if (intent === 'input') this.activityMarker?.(sessionId);
  }

  /** Register the activity sink invoked on every stdin write. */
  setActivityMarker(marker: ((sessionId: string) => void) | undefined): void {
    this.activityMarker = marker;
  }

  /** Get the number of PTY writes made to a session. Returns 0 if not tracked. */
  getWriteCount(sessionId: string): number {
    return this.writeCounts.get(sessionId) ?? 0;
  }

  /**
   * Deliver bulk text to a session's PTY, framing it per the tracked DEC 2004
   * state and sending the submit suffix as a separate later write.
   *
   * There is one delivery path. Text used to make a round trip through the
   * renderer to be written by this same class, purely to borrow xterm's DEC 2004
   * bit and to honour four paste modes nothing ever configured. The tracker
   * supplies the bit and the modes are gone, so the trip — along with its
   * request timeout, its raw fallback and its duplicate-write ambiguity — went
   * with them.
   */
  async deliverText(sessionId: string, text: string, options?: TextDeliveryOptions): Promise<void> {
    if (!text && !options?.submitSuffix) return;
    const suffix = options?.submitSuffix ?? (options?.withReturn ? '\r' : '');

    if (text) {
      // Framing keeps a multi-line payload as one paste; without it a TUI line
      // editor submits line-by-line and only the last fragment survives. A CLI
      // that never announced the mode (cmd.exe) still gets raw bytes — there
      // line-by-line execution is the point.
      let enabled = this.bracketedPaste.isEnabled(sessionId);
      if (!enabled && text.includes('\n')) {
        enabled = await this.bracketedPaste.waitUntilEnabled(sessionId, {
          budgetMs: BRACKETED_PASTE_READY_BUDGET_MS,
          pollMs: BRACKETED_PASTE_POLL_MS,
          isAlive: () => this.ptys.has(sessionId),
        });
      }
      this.write(sessionId, buildPastePayload(text, enabled), options?.writeIntent ?? 'input');
      // The suffix stays a SEPARATE write after a settle beat: a CR concatenated
      // onto a paste block does not submit, it leaves the text sitting on the
      // prompt (the bug 5a981b3 fixed).
      if (suffix) await new Promise<void>(resolve => setTimeout(resolve, SUBMIT_SETTLE_DELAY_MS));
    }
    if (suffix) this.write(sessionId, suffix, options?.writeIntent ?? 'input');
  }

  /** Whether the session's CLI has announced bracketed paste on its output stream. */
  isBracketedPasteEnabled(sessionId: string): boolean {
    return this.bracketedPaste.isEnabled(sessionId);
  }

  /**
   * Wait until a session's output has been silent for `quietMs`.
   *
   * A full-screen TUI re-render mid-write splits a paste in flight (the
   * rename-delivery bug P-0792): landing writes on a settled screen means
   * waiting out re-renders provoked by hook replies and startup banners.
   * Resolves true when the window went quiet; false when the budget ran out,
   * the session is gone, or it never stops talking — callers treat false as
   * "proceed anyway", a dropped rename is worse than a raced one.
   */
  async waitForQuiet(
    sessionId: string,
    options?: { quietMs?: number; budgetMs?: number; pollMs?: number },
  ): Promise<boolean> {
    const quietMs = options?.quietMs ?? RENAME_QUIET_WINDOW_MS;
    const budgetMs = options?.budgetMs ?? RENAME_QUIET_BUDGET_MS;
    const pollMs = options?.pollMs ?? RENAME_QUIET_POLL_MS;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (!this.ptys.has(sessionId)) return false;
      if (Date.now() - (this.lastOutputAt.get(sessionId) ?? 0) >= quietMs) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
  }

  /** Resize a session's PTY. */
  resize(sessionId: string, cols: number, rows: number): void {
    const pty = this.ptys.get(sessionId);
    if (!pty) return;
    try {
      pty.resize(cols, rows);
      this.sizes.set(sessionId, { cols, rows });
    } catch (error) {
      logger.error(`[PTY] Resize failed for session=${sessionId}: ${error}`);
    }
  }

  /**
   * Nudge a session's PTY with a transient resize (rows-1 then back), forcing the
   * shell to emit SIGWINCH. Full-screen TUIs (e.g. Copilot CLI) redraw their input
   * region on SIGWINCH; a hidden session that never received a fit/resize keeps a
   * stale size, so text delivered to it lands in a mis-sized buffer. Sent before
   * inter-session/Telegram text delivery so the recipient redraws first.
   * No-op when size is unknown or too small to shrink.
   */
  async nudgeResize(sessionId: string): Promise<void> {
    const pty = this.ptys.get(sessionId);
    const size = this.sizes.get(sessionId);
    if (!pty || !size || size.rows <= 1) return;
    try {
      pty.resize(size.cols, size.rows - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      pty.resize(size.cols, size.rows);
    } catch (error) {
      logger.error(`[PTY] Resize nudge failed for session=${sessionId}: ${error}`);
    }
  }

  /** Kill a session's PTY process. */
  kill(sessionId: string): void {
    const pty = this.ptys.get(sessionId);
    if (!pty) return;
    try {
      pty.kill();
    } catch (error) {
      logger.error(`[PTY] Kill failed for session=${sessionId}: ${error}`);
    }
    this.ptys.delete(sessionId);
    this.terminalOutputBuffer.clear(sessionId);
    this.bracketedPaste.clear(sessionId);
    this.writeCounts.delete(sessionId);
    this.sizes.delete(sessionId);
    this.lastOutputAt.delete(sessionId);
  }

  /** Latch app shutdown. From here on, PTY exits are consequences of the app
   *  quitting rather than deliberate session closures, so the 'exit' event is
   *  no longer emitted — session records, recycle bin and scheduled tasks all
   *  hang off that event and must not react to a shutdown. One-way: the
   *  process is on its way out. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Kill all PTY processes. */
  killAll(): void {
    for (const [sessionId, pty] of this.ptys) {
      try {
        pty.kill();
      } catch (error) {
        logger.error(`[PTY] Kill failed during killAll for session=${sessionId}: ${error}`);
      }
    }
    this.ptys.clear();
    this.terminalOutputBuffer.clearAll();
    this.bracketedPaste.clearAll();
    this.writeCounts.clear();
    this.sizes.clear();
    this.lastOutputAt.clear();
  }

  /** Check if a PTY exists for a session. */
  has(sessionId: string): boolean {
    return this.ptys.has(sessionId);
  }

  /** Get the PID of a session's PTY. */
  getPid(sessionId: string): number | undefined {
    return this.ptys.get(sessionId)?.pid;
  }

  /** Get all active session IDs. */
  getSessionIds(): string[] {
    return Array.from(this.ptys.keys());
  }

  /** Read recent terminal output captured from PTY stdout. */
  getTerminalTail(sessionId: string, lines: number, mode: TerminalOutputMode, stripBlankLines = false): TerminalTail {
    return this.terminalOutputBuffer.tail(sessionId, lines, mode, stripBlankLines);
  }

}
