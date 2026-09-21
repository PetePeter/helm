/**
 * MobileChatJournal — the ONE rolling record of every chat message this hub has
 * fanned out to phones, and the thing catch-up replays from.
 *
 * WHY A JOURNAL: fan-out is live-only. A phone that was out of range, or an app
 * whose process died with its in-memory threads, simply missed everything — and
 * Telegram was quietly carrying the whole burden of "was I told?". The journal
 * decouples "was sent" from "was received": every message is appended ONCE,
 * whether or not any phone took it, and each phone catches up from its own
 * cursor when its link next comes up.
 *
 * ONE GLOBAL SEQUENCE, not per-phone. Cursors are the phones' business — the
 * hub never tracks who is behind, so a fourth paired phone needs no new state
 * here and a factory-reset APK is just a cursor at zero.
 *
 * DELIVERED ENTRIES STAY, and retention is the SESSION'S lifetime, not an age:
 * entries survive until their session is permanently gone — purged from the
 * recycle bin (expiry, Forget, Empty) or closed without ever being recoverable.
 * A phone that comes back a week later still gets the conversation, because the
 * session (or its bin entry) was alive the whole time. The hard entry cap is
 * the only unconditional bound, and exists only so a runaway agent cannot grow
 * the file without bound — at chat volumes it is never reached.
 *
 * Alerts and artifact notices are deliberately NOT journaled: a notification is
 * only true while it happens, and replaying "needs input" an hour late is the
 * failure the alert path exists to avoid. See docs/chat-fan-out.md.
 *
 * Shaped like MobileDeviceStore: injected persist sink, no I/O in the
 * constructor (the orchestrator hydrates via `hydrate(loadMobileChatJournal())`).
 */

import type { ChatRecordInput } from './mobile-envelope.js';

/** One journaled message: its place in the global sequence, and the record. */
export interface ChatJournalEntry {
  seq: number;
  record: ChatRecordInput;
}

/** The persisted form. `nextSeq` is saved so a seq is never reused after a restart. */
export interface ChatJournalState {
  nextSeq: number;
  entries: ChatJournalEntry[];
}

export interface MobileChatJournalOptions {
  /** Called on every mutation. Failures are the sink's problem, never fatal. */
  persist?: (state: ChatJournalState) => void;
  /** Oldest-dropped safety ceiling. See the class comment for why it exists. */
  maxEntries?: number;
}

export const DEFAULT_CHAT_JOURNAL_MAX_ENTRIES = 100_000;

export class MobileChatJournal {
  private entries: ChatJournalEntry[] = [];
  private nextSeq = 0;
  private readonly persist: ((state: ChatJournalState) => void) | undefined;
  private readonly maxEntries: number;

  constructor(options: MobileChatJournalOptions = {}) {
    this.persist = options.persist;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_CHAT_JOURNAL_MAX_ENTRIES);
  }

  /**
   * Adopt a saved state. Never throws: a corrupt file reads as "no history",
   * which costs a phone some duplicate-free gaps it will refetch — never a
   * crash at startup.
   */
  hydrate(saved: unknown): void {
    if (!saved || typeof saved !== 'object') return;
    const state = saved as Partial<ChatJournalState>;
    if (typeof state.nextSeq !== 'number' || !Array.isArray(state.entries)) return;
    this.nextSeq = state.nextSeq;
    this.entries = state.entries.filter(entry =>
      entry
      && typeof entry === 'object'
      && typeof entry.seq === 'number'
      && !!entry.record
      && typeof entry.record.at === 'number');
  }

  /**
   * Append one fanned-out message and return its entry. Delivery plays no part:
   * the journal exists precisely for the phones that did NOT take it live.
   */
  append(record: ChatRecordInput): ChatJournalEntry {
    this.nextSeq += 1;
    this.entries.push({ seq: this.nextSeq, record });
    this.prune();
    this.save();
    return this.entries[this.entries.length - 1];
  }

  /** Every entry after `seq`, oldest first. The whole journal for a cursor of 0. */
  since(seq: number): ChatJournalEntry[] {
    return this.entries.filter(entry => entry.seq > seq);
  }

  /** The newest seq handed out — the cursor a fully caught-up phone reports. */
  latestSeq(): number {
    return this.nextSeq;
  }

  /**
   * A session left for good (recycle-bin purge, or a close that never went to
   * the bin): its conversation is not coming back either, so the entries go
   * now. Returns how many were dropped.
   */
  pruneSession(sessionId: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter(entry => entry.record.sessionId !== sessionId);
    const dropped = before - this.entries.length;
    if (dropped > 0) this.save();
    return dropped;
  }

  /**
   * Enforce the cap. Runs on load and on every append — both are rare enough
   * that sweeping the whole list is cheap.
   */
  private prune(): void {
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }
  }

  private save(): void {
    if (!this.persist) return;
    this.persist({ nextSeq: this.nextSeq, entries: this.entries });
  }
}
