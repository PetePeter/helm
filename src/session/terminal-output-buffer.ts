import { stripAnsi } from '../utils/strip-ansi.js';

export type TerminalOutputMode = 'raw' | 'stripped' | 'both';
export type TerminalReadMode = TerminalOutputMode | 'screen';

interface LineBuffer {
  lines: string[];
  partial: string;
}

interface SessionTerminalBuffer {
  raw: LineBuffer;
  stripped: LineBuffer;
  lastOutputAt?: number;
}

export interface TerminalTail {
  raw?: string[];
  stripped?: string[];
  lastOutputAt?: number;
}

export class TerminalOutputBuffer {
  private buffers = new Map<string, SessionTerminalBuffer>();

  constructor(private readonly maxLines = 500) {}

  append(sessionId: string, data: string, now = Date.now()): void {
    if (!data) return;
    const buffer = this.getOrCreate(sessionId);
    this.appendToLineBuffer(buffer.raw, data);
    this.appendToLineBuffer(buffer.stripped, stripAnsi(data));
    buffer.lastOutputAt = now;
  }

  tail(sessionId: string, lines: number, mode: TerminalOutputMode, stripBlankLines = false): TerminalTail {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return {};
    const includeRaw = mode === 'raw' || mode === 'both';
    const includeStripped = mode === 'stripped' || mode === 'both';

    let raw = includeRaw ? this.getLines(buffer.raw, lines) : undefined;
    let stripped = includeStripped ? this.getLines(buffer.stripped, lines) : undefined;

    if (stripBlankLines) {
      if (mode === 'both' && raw && stripped) {
        // Drop paired rows where the stripped side is blank to preserve row correspondence.
        const kept = stripped
          .map((s, i) => ({ s, r: raw![i] }))
          .filter(({ s }) => s.trim() !== '');
        raw = kept.map(({ r }) => r);
        stripped = kept.map(({ s }) => s);
      } else {
        if (raw) raw = raw.filter(r => r.trim() !== '');
        if (stripped) stripped = stripped.filter(s => s.trim() !== '');
      }
    }

    return {
      ...(raw !== undefined ? { raw } : {}),
      ...(stripped !== undefined ? { stripped } : {}),
      ...(buffer.lastOutputAt !== undefined ? { lastOutputAt: buffer.lastOutputAt } : {}),
    };
  }

  clear(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  clearAll(): void {
    this.buffers.clear();
  }

  private getOrCreate(sessionId: string): SessionTerminalBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = {
        raw: { lines: [], partial: '' },
        stripped: { lines: [], partial: '' },
      };
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  private appendToLineBuffer(buffer: LineBuffer, data: string): void {
    const normalized = data.replace(/\r\n/g, '\n');
    const combined = buffer.partial + normalized;
    const parts = combined.split('\n');
    buffer.partial = this.collapseCarriageReturn(parts.pop() ?? '');

    for (const part of parts) {
      buffer.lines.push(this.collapseCarriageReturn(part));
    }

    if (buffer.lines.length > this.maxLines) {
      buffer.lines = buffer.lines.slice(-this.maxLines);
    }
  }

  private getLines(buffer: LineBuffer, count: number): string[] {
    const lines = buffer.partial ? [...buffer.lines, buffer.partial] : [...buffer.lines];
    return lines.slice(-count);
  }

  private collapseCarriageReturn(value: string): string {
    const index = value.lastIndexOf('\r');
    return index >= 0 ? value.slice(index + 1) : value;
  }
}
