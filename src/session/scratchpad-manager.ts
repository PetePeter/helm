import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import {
  SCRATCHPAD_MAX_BYTES,
  scratchpadBytes,
  type Scratchpad,
  type ScratchpadAuthor,
  type ScratchpadWriteResult,
} from '../types/scratchpad.js';

/** Where pads live. One record per session id, so one session's churn never rewrites another's text. */
export interface ScratchpadStore {
  load(sessionId: string): Scratchpad | null;
  save(scratchpad: Scratchpad): void;
  remove(sessionId: string): void;
  list(): string[];
}

/**
 * ScratchpadManager: the single owner of every session's scratchpad.
 *
 * Two writers share one pad (the user typing in the pane, the session's LLM
 * through MCP), so a replace names the revision it was based on and a stale one
 * is refused with the current pad. That is the whole concurrency model: no
 * merge, no CRDT. An append needs no revision because it cannot drop anything.
 *
 * The pad is keyed by the Helm session id, so it survives compaction and a
 * recycle-bin restore; `clearSession` is called only when the session can never
 * come back.
 */
export class ScratchpadManager extends EventEmitter {
  private readonly pads = new Map<string, Scratchpad>();

  constructor(
    private readonly store: ScratchpadStore,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  get(sessionId: string): Scratchpad {
    return { ...this.current(sessionId) };
  }

  /** Replace the whole text. `baseRevision` is the revision the writer last saw. */
  set(sessionId: string, text: string, by: ScratchpadAuthor, baseRevision: number): ScratchpadWriteResult {
    const current = this.current(sessionId);
    if (baseRevision !== current.revision) {
      return {
        ok: false,
        reason: 'stale',
        message: `The scratchpad changed since revision ${baseRevision}; it is now at revision ${current.revision}. Re-apply your change to the current text.`,
        scratchpad: { ...current },
      };
    }
    return this.write(current, text, by);
  }

  /** Add text on a new line at the end. Never drops what is already there. */
  append(sessionId: string, text: string, by: ScratchpadAuthor): ScratchpadWriteResult {
    const current = this.current(sessionId);
    const separator = current.text && !current.text.endsWith('\n') ? '\n' : '';
    return this.write(current, text ? `${current.text}${separator}${text}` : current.text, by);
  }

  /**
   * A session that continues under a new id (Switch CLI) takes its notes
   * along. The source keeps its own copy for a recycle-bin restore.
   */
  copySession(fromSessionId: string, toSessionId: string): void {
    const source = this.current(fromSessionId);
    if (source.text) this.write(this.current(toSessionId), source.text, source.updatedBy ?? 'user');
  }

  /** The session is gone for good: drop its pad. */
  clearSession(sessionId: string): void {
    this.pads.delete(sessionId);
    this.store.remove(sessionId);
  }

  /** Startup reclamation after a crash: drop pads whose session is neither live nor in the recycle bin. */
  pruneOrphans(keep: ReadonlySet<string>): string[] {
    const pruned = this.store.list().filter(sessionId => !keep.has(sessionId));
    for (const sessionId of pruned) this.clearSession(sessionId);
    if (pruned.length) logger.info(`[Scratchpad] Pruned ${pruned.length} orphaned scratchpad(s)`);
    return pruned;
  }

  private current(sessionId: string): Scratchpad {
    let pad = this.pads.get(sessionId);
    if (!pad) {
      pad = this.store.load(sessionId) ?? { sessionId, text: '', revision: 0 };
      this.pads.set(sessionId, pad);
    }
    return pad;
  }

  private write(current: Scratchpad, text: string, by: ScratchpadAuthor): ScratchpadWriteResult {
    if (text === current.text) return { ok: true, scratchpad: { ...current } };
    const bytes = scratchpadBytes(text);
    if (bytes > SCRATCHPAD_MAX_BYTES) {
      return {
        ok: false,
        reason: 'too_large',
        message: `The scratchpad holds at most ${SCRATCHPAD_MAX_BYTES} bytes; this write would make it ${bytes}. Nothing was changed.`,
        scratchpad: { ...current },
      };
    }
    const next: Scratchpad = {
      sessionId: current.sessionId,
      text,
      revision: current.revision + 1,
      updatedAt: this.now(),
      updatedBy: by,
    };
    this.pads.set(next.sessionId, next);
    this.store.save(next);
    this.emit('scratchpad:changed', { ...next });
    return { ok: true, scratchpad: { ...next } };
  }
}
