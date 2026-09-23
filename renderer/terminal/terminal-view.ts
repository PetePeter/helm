/**
 * Terminal View — wraps a single xterm.js Terminal instance with addons.
 *
 * Each TerminalView owns one xterm Terminal, fit/search/weblinks addons,
 * and forwards user input + resize events via callbacks.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { systemClient } from '../ipc/clients.js';
import { installMouseTrackingGuard } from './mouse-tracking-guard.js';

export interface TerminalViewOptions {
  sessionId: string;
  container: HTMLElement;
  onData?: (data: string) => void;
  /** Callback for scroll input — bypasses AIAGENT keyword detection. */
  onScrollInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitleChange?: (title: string) => void;
  /** Let the CLI capture the mouse. Off by default so plain click-drag selects text. */
  mouseTracking?: boolean;
}

export class TerminalView {
  readonly sessionId: string;
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private container: HTMLElement;
  private writeCallback?: (data: string) => void;
  private scrollCallback?: (data: string) => void;
  private disposed = false;

  constructor(options: TerminalViewOptions) {
    this.sessionId = options.sessionId;
    this.container = options.container;

    this.terminal = new Terminal({
      scrollback: 10_000,
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Consolas', monospace",
      theme: {
        background: '#0a0a0a',
        foreground: '#e0e0e0',
        cursor: '#ff6600',
        selectionBackground: 'rgba(255, 102, 0, 0.3)',
        black: '#0a0a0a',
        red: '#cc3333',
        green: '#44cc44',
        yellow: '#ffaa00',
        blue: '#4488ff',
        magenta: '#cc44cc',
        cyan: '#44cccc',
        white: '#e0e0e0',
        brightBlack: '#555555',
        brightRed: '#ff4444',
        brightGreen: '#66ff66',
        brightYellow: '#ffcc44',
        brightBlue: '#6699ff',
        brightMagenta: '#ff66ff',
        brightCyan: '#66ffff',
        brightWhite: '#ffffff',
        scrollbarSliderBackground: 'rgba(68, 68, 68, 0.8)',
        scrollbarSliderHoverBackground: 'rgba(255, 102, 0, 0.6)',
        scrollbarSliderActiveBackground: 'rgba(255, 102, 0, 0.8)',
      },
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();

    this.terminal.loadAddon(this.fitAddon);
    // Route clicked links to the OS default handler (system browser) instead of
    // opening an in-app Electron window. Bypasses window.open entirely.
    this.terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      void systemClient.systemOpenExternalUrl(uri);
    }));
    this.terminal.loadAddon(this.searchAddon);

    if (options.mouseTracking !== true) installMouseTrackingGuard(this.terminal);

    this.terminal.open(this.container);

    // Let Ctrl+Tab/Ctrl+Shift+Tab pass through to the global handler.
    // Ctrl+C with selection → copy to clipboard instead of sending SIGINT.
    // PageUp/PageDown in normal buffer: scroll viewport (plain shells like cmd.exe).
    // In alternate buffer (TUI CLIs): xterm.js sends escape to PTY natively.
    this.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.key === 'Tab' && event.ctrlKey) {
        return false;
      }
      if (event.key.toLowerCase() === 'c' && event.ctrlKey && !event.shiftKey && !event.altKey &&
          event.type === 'keydown' && this.terminal.hasSelection()) {
        const text = this.terminal.getSelection();
        void navigator.clipboard.writeText(text)
          .then(() => this.terminal.clearSelection())
          .catch((err: unknown) => console.warn('[TerminalView] copy failed:', err));
        return false;
      }
      if ((event.key === 'PageUp' || event.key === 'PageDown') &&
          event.type === 'keydown' &&
          this.terminal.buffer.active.type === 'normal') {
        const lines = this.terminal.rows;
        this.terminal.scrollLines(event.key === 'PageDown' ? lines : -lines);
        return false;
      }
      return true;
    });

    if (options.onData) {
      this.writeCallback = options.onData;
      this.terminal.onData(options.onData);
    }

    if (options.onScrollInput) {
      this.scrollCallback = options.onScrollInput;
    }

    if (options.onResize) {
      this.terminal.onResize(({ cols, rows }) => {
        options.onResize!(cols, rows);
      });
    }

    if (options.onTitleChange) {
      this.terminal.onTitleChange(options.onTitleChange);
    }

    // Fitting is deliberately owned by fitAndSyncPty. It waits until the
    // containing layout is measurable and then synchronizes the PTY dimensions.
  }

  /** Write data to the terminal display (from PTY stdout) */
  write(data: string): void {
    if (!this.disposed) {
      this.terminal.write(data);
    }
  }

  /** Re-fit terminal to container size */
  fit(): void {
    if (!this.disposed) {
      try {
        this.fitAddon.fit();
      } catch {
        // Container may not be visible yet
      }
    }
  }

  /** Move the existing xterm DOM into a new host without recreating its buffer. */
  adoptContainer(nextContainer: HTMLElement): boolean {
    if (this.disposed || nextContainer === this.container) return false;
    while (this.container.firstChild) {
      nextContainer.appendChild(this.container.firstChild);
    }
    this.container = nextContainer;
    this.fit();
    return true;
  }

  /** Get current terminal dimensions */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  /** Focus the terminal */
  focus(): void {
    if (!this.disposed) {
      this.terminal.focus();
    }
  }

  /** Paste text through xterm.js so it flows via terminal input handling to the PTY. */
  paste(data: string): void {
    if (!this.disposed && data) {
      this.terminal.paste(data);
    }
  }

  /** Blur the terminal */
  blur(): void {
    if (!this.disposed) {
      this.terminal.blur();
    }
  }

  /** Search forward in terminal buffer */
  findNext(term: string): boolean {
    return this.searchAddon.findNext(term);
  }

  /** Search backward in terminal buffer */
  findPrevious(term: string): boolean {
    return this.searchAddon.findPrevious(term);
  }

  /** Scroll to bottom of terminal buffer */
  scrollToBottom(): void {
    this.terminal.scrollToBottom();
  }

  /** Scroll by the given number of lines */
  scrollLines(lines: number): void {
    if (!this.disposed) {
      this.terminal.scrollLines(lines);
    }
  }

  /**
   * Buffer-aware scroll — viewport scrollback or PTY input.
   *
   * Normal buffer: scrollLines() to move viewport.
   * Alternate buffer: sends PageUp/PageDown escape sequences to the PTY so
   * the CLI app scrolls its own content. Uses scrollCallback (pty:scrollInput)
   * to avoid false AIAGENT state changes from screen redraws.
   * Used by gamepad scroll bindings — mouse wheel handled natively by xterm.js.
   */
  scroll(direction: 'up' | 'down', lines: number): void {
    if (this.disposed) return;

    if (this.terminal.buffer.active.type === 'alternate') {
      const cb = this.scrollCallback || this.writeCallback;
      if (cb) {
        const key = direction === 'down' ? '\x1b[6~' : '\x1b[5~';
        for (let i = 0; i < lines; i++) {
          cb(key);
        }
      }
    } else {
      this.terminal.scrollLines(direction === 'down' ? lines : -lines);
    }
  }

  /** Clear terminal buffer */
  clear(): void {
    this.terminal.clear();
  }

  /** Get currently selected text from terminal */
  getSelection(): string {
    return this.terminal.getSelection();
  }

  /** Check if any text is selected */
  hasSelection(): boolean {
    return this.terminal.hasSelection();
  }

  /** Clear the current selection */
  clearSelection(): void {
    this.terminal.clearSelection();
  }

  /** Whether the CLI has enabled bracketed paste mode (DEC private mode 2004).
   *  When true, pasted text should be wrapped in \x1b[200~ ... \x1b[201~ markers. */
  isBracketedPasteEnabled(): boolean {
    return this.terminal.modes.bracketedPasteMode;
  }

  /** Read the last N non-blank lines from the terminal buffer (ANSI-free) */
  getBufferLines(count: number): string[] {
    if (this.disposed) return [];
    const buf = this.terminal.buffer.active;
    // Scan backward from buffer end to find last non-blank line
    // (cursor position may be mid-screen in TUI CLIs like alternate-buffer apps)
    let endRow = buf.length - 1;
    while (endRow >= 0) {
      const line = buf.getLine(endRow);
      if (line && line.translateToString(true).trim() !== '') break;
      endRow--;
    }
    if (endRow < 0) return [];
    const startRow = Math.max(0, endRow - count + 1);
    const lines: string[] = [];
    for (let i = startRow; i <= endRow; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  /** Dispose terminal and release resources */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
}
