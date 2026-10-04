// @xterm/headless is CommonJS and main is an unbundled ESM import of it, so a
// named import fails at load time under Node — only the default export works.
import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { logger } from '../utils/logger.js';

const { Terminal } = xtermHeadless;
type Terminal = HeadlessTerminal;

interface TerminalSize {
  cols: number;
  rows: number;
}

/** Maintains xterm's rendered screen for snapshot clients while output tails stay chronological. */
export class TerminalScreenBuffer {
  private readonly terminals = new Map<string, Terminal>();
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly pendingFlushes = new Map<string, () => void>();

  attach(sessionId: string, size: TerminalSize): void {
    this.clear(sessionId);
    this.terminals.set(sessionId, new Terminal({
      // Reading terminal.buffer is an xterm proposed API; screen snapshots need it.
      allowProposedApi: true,
      cols: Math.max(1, size.cols),
      rows: Math.max(1, size.rows),
      scrollback: MAX_SCROLLBACK,
    }));
  }

  append(sessionId: string, data: string): void {
    const terminal = this.terminals.get(sessionId);
    if (!terminal || !data) return;

    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    this.pendingWrites.set(sessionId, pending);
    this.pendingFlushes.set(sessionId, complete);
    try {
      terminal.write(data, () => {
        complete();
        if (this.pendingWrites.get(sessionId) === pending) this.pendingWrites.delete(sessionId);
        if (this.pendingFlushes.get(sessionId) === complete) this.pendingFlushes.delete(sessionId);
      });
    } catch (error) {
      this.clear(sessionId);
      logger.error(`[PTY] xterm screen update failed for ${sessionId}: ${error}`);
    }
  }

  resize(sessionId: string, size: TerminalSize): void {
    this.terminals.get(sessionId)?.resize(
      Math.max(1, size.cols),
      Math.max(1, size.rows),
    );
  }

  async tail(sessionId: string, requestedLines: number): Promise<string[]> {
    const terminal = this.terminals.get(sessionId);
    if (!terminal) return [];
    await this.pendingWrites.get(sessionId);
    if (this.terminals.get(sessionId) !== terminal) return [];

    const buffer = terminal.buffer.active;
    const end = buffer.length;
    const start = Math.max(0, end - Math.min(MAX_SCROLLBACK, Math.max(1, requestedLines)));
    return Array.from({ length: end - start }, (_, index) =>
      buffer.getLine(start + index)?.translateToString(true) ?? '',
    );
  }

  clear(sessionId: string): void {
    this.pendingFlushes.get(sessionId)?.();
    this.pendingFlushes.delete(sessionId);
    this.pendingWrites.delete(sessionId);
    this.terminals.get(sessionId)?.dispose();
    this.terminals.delete(sessionId);
  }

  clearAll(): void {
    for (const flush of this.pendingFlushes.values()) flush();
    for (const terminal of this.terminals.values()) terminal.dispose();
    this.terminals.clear();
    this.pendingWrites.clear();
    this.pendingFlushes.clear();
  }
}

const MAX_SCROLLBACK = 500;
