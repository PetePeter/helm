import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import {
  DRAFT_MAX_BYTES,
  draftBytes,
  type Draft,
  type DraftSend,
  type DraftAuthor,
  type DraftWriteResult,
} from '../types/draft.js';

/** Where pads live. One record per session id, so one session's churn never rewrites another's text. */
export interface DraftStore {
  load(sessionId: string): Draft | null;
  save(draft: Draft): void;
  remove(sessionId: string): void;
  list(): string[];
  loadHistory(sessionId: string): DraftSend[];
  saveHistory(sessionId: string, entries: DraftSend[]): void;
}

/**
 * DraftManager: the single owner of every session's draft.
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
export class DraftManager extends EventEmitter {
  private readonly pads = new Map<string, Draft>();
  private readonly histories = new Map<string, DraftSend[]>();

  constructor(
    private readonly store: DraftStore,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  get(sessionId: string): Draft {
    return { ...this.current(sessionId) };
  }

  history(sessionId: string): DraftSend[] {
    let entries = this.histories.get(sessionId);
    if (!entries) {
      entries = this.store.loadHistory(sessionId);
      this.histories.set(sessionId, entries);
    }
    return entries.map(entry => ({ ...entry }));
  }

  recordSend(sessionId: string, text: string, via: DraftSend['via']): DraftSend[] {
    const entries = [{ text, at: this.now(), via }, ...this.history(sessionId)].slice(0, 10);
    this.histories.set(sessionId, entries);
    this.store.saveHistory(sessionId, entries);
    return entries.map(entry => ({ ...entry }));
  }

  /** Replace the whole text. `baseRevision` is the revision the writer last saw. */
  set(sessionId: string, text: string, by: DraftAuthor, baseRevision: number): DraftWriteResult {
    const current = this.current(sessionId);
    if (baseRevision !== current.revision) {
      return {
        ok: false,
        reason: 'stale',
        message: `The draft changed since revision ${baseRevision}; it is now at revision ${current.revision}. Re-apply your change to the current text.`,
        draft: { ...current },
      };
    }
    return this.write(current, text, by);
  }

  /** Add text on a new line at the end. Never drops what is already there. */
  append(sessionId: string, text: string, by: DraftAuthor): DraftWriteResult {
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
    const history = this.history(fromSessionId);
    if (history.length) {
      this.histories.set(toSessionId, history);
      this.store.saveHistory(toSessionId, history);
    }
  }

  /** The session is gone for good: drop its pad. */
  clearSession(sessionId: string): void {
    this.pads.delete(sessionId);
    this.histories.delete(sessionId);
    this.store.remove(sessionId);
  }

  /** Startup reclamation after a crash: drop pads whose session is neither live nor in the recycle bin. */
  pruneOrphans(keep: ReadonlySet<string>): string[] {
    const pruned = [...new Set(this.store.list())].filter(sessionId => !keep.has(sessionId));
    for (const sessionId of pruned) this.clearSession(sessionId);
    if (pruned.length) logger.info(`[Draft] Pruned ${pruned.length} orphaned draft(s)`);
    return pruned;
  }

  private current(sessionId: string): Draft {
    let pad = this.pads.get(sessionId);
    if (!pad) {
      pad = this.store.load(sessionId) ?? { sessionId, text: '', revision: 0 };
      this.pads.set(sessionId, pad);
    }
    return pad;
  }

  private write(current: Draft, text: string, by: DraftAuthor): DraftWriteResult {
    if (text === current.text) return { ok: true, draft: { ...current } };
    const bytes = draftBytes(text);
    if (bytes > DRAFT_MAX_BYTES) {
      return {
        ok: false,
        reason: 'too_large',
        message: `The draft holds at most ${DRAFT_MAX_BYTES} bytes; this write would make it ${bytes}. Nothing was changed.`,
        draft: { ...current },
      };
    }
    const next: Draft = {
      sessionId: current.sessionId,
      text,
      revision: current.revision + 1,
      updatedAt: this.now(),
      updatedBy: by,
    };
    this.pads.set(next.sessionId, next);
    this.store.save(next);
    this.emit('draft:changed', { ...next });
    return { ok: true, draft: { ...next } };
  }
}
