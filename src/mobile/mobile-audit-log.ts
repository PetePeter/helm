/**
 * MobileAuditLog — rolling 7-day trail of every inbound paired-phone call
 * decision.
 *
 * Shaped like PeerAuditLog (EventEmitter; append → unshift newest-first → prune
 * by cutoff → persist → emit; injectable clock and persist sink). Kept as its own
 * log rather than folded into the peer trail: the entries are keyed on a DEVICE
 * id, the two files have independent lifetimes, and a reviewer looking at "what
 * did my phone do" should not have to read past fleet traffic.
 *
 * SECURITY — this is the whole point of the module: entries store NO payload
 * values and NO secrets. `argSummary` is a short string of top-level argument
 * KEY NAMES only (built by the gate) and `error` is an error TYPE name, never a
 * dispatcher message (several embed argument values).
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { saveMobileAudit, loadMobileAudit, MOBILE_AUDIT_WINDOW_MS } from './mobile-audit-persistence.js';

export { MOBILE_AUDIT_WINDOW_MS };

export type MobileAuditOutcome = 'ok' | 'denied' | 'rate-limited' | 'error';

export interface MobileAuditEntry {
  id: string;
  /** Local MobileDevice record id — never the rotating BLE address. */
  deviceId: string;
  method: string;
  /** Top-level argument KEY NAMES only — NEVER values. e.g. "keys: sessionId,text". */
  argSummary: string;
  outcome: MobileAuditOutcome;
  ranAt: number;
  /** Error TYPE name only (no messages, no payloads); present when outcome === 'error'. */
  error?: string;
}

export type MobileAuditPersist = (entries: MobileAuditEntry[]) => void;

export class MobileAuditLog extends EventEmitter {
  private entries: MobileAuditEntry[];

  constructor(
    private readonly persist: MobileAuditPersist = (e) => saveMobileAudit(e),
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.entries = loadMobileAudit(undefined, now());
  }

  /**
   * Record a decision. Assigns an id, inserts newest-first, prunes the retention
   * window, persists, and emits 'mobile-audit:changed'.
   */
  append(entry: Omit<MobileAuditEntry, 'id'>): MobileAuditEntry {
    const created: MobileAuditEntry = { id: randomUUID(), ...entry };
    this.entries.unshift(created);
    this.prune();
    this.persist(this.entries);
    this.emit('mobile-audit:changed');
    return created;
  }

  /** All entries, newest first. */
  list(): MobileAuditEntry[] {
    return [...this.entries].sort((a, b) => b.ranAt - a.ranAt);
  }

  /** Snapshot for persistence (independent copies). */
  exportAll(): MobileAuditEntry[] {
    return this.entries.map(e => ({ ...e }));
  }

  /** Replace internal state (used on hydrate); re-prunes defensively. */
  importAll(entries: MobileAuditEntry[]): void {
    this.entries = Array.isArray(entries) ? entries.map(e => ({ ...e })) : [];
    this.prune();
  }

  /** Drop entries whose ranAt falls outside the retention window. */
  private prune(): void {
    const cutoff = this.now() - MOBILE_AUDIT_WINDOW_MS;
    this.entries = this.entries.filter(e => e.ranAt >= cutoff);
  }
}
