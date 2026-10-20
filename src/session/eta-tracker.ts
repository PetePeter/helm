/**
 * EtaTracker — scores the LLM's completion estimates against reality.
 *
 * session_eta_set opens an estimate; session_eta_clear closes it. A re-set
 * never restarts the clock: actual time runs from the first set and is scored
 * against the first guess, so re-setting a tiny ETA over and over only shows
 * as late — unless the set passes a rescope reason, which closes the old
 * estimate as "rescoped" (unscored) and starts a fresh clock. A late clear
 * still counts, at its real end. Only an estimate never cleared within 3× its
 * first guess (at least 1h) is "unmarked": its end is capped there and it is
 * kept out of learning, as are first guesses under 5m.
 * The learned P10–P90 ratio band (actual ÷ predicted, per CLI + folder) is
 * snapshotted onto each new ETA as its confidence range. See docs/session-eta.md.
 */

import type { SessionEta, SessionInfo } from '../types/session.js';
import type { SessionManager } from './manager.js';
import { createSessionEta, type SessionEtaInput } from './session-eta.js';
import type { EtaPersistence } from './eta-persistence.js';

export const UNMARKED_FACTOR = 3;
export const UNMARKED_MIN_MS = 60 * 60_000;
const UNMARKED_GRACE_MS = 10 * 60_000;
export const MIN_LEARN_MS = 5 * 60_000;
export const MIN_SAMPLES = 5;
const MAX_SAMPLES = 50;

export type EtaOutcome = 'cleared' | 'unmarked' | 'rescoped';

export interface EtaRecord {
  startedAt: number;
  endedAt: number;
  /** The first guess — what the estimate is scored against. */
  firstAt: number;
  /** The last ETA shown before it closed. */
  finalAt: number;
  outcome: EtaOutcome;
  cliType: string;
  dir: string;
  sessionName: string;
  note?: string;
  /** Why the scope changed, on a rescoped record. */
  reason?: string;
}

export interface EtaWhere {
  cliType: string;
  dir: string;
  sessionName: string;
}

export interface EtaSummary {
  total: number;
  onTimePct: number;
  medianSlipMin: number;
  unmarked: number;
  rescoped: number;
}

export interface EtaTrackerDeps {
  persistence: Pick<EtaPersistence, 'append' | 'loadAll'>;
  now?: () => number;
}

export class EtaTracker {
  private readonly records: EtaRecord[];
  private readonly now: () => number;

  constructor(private readonly deps: EtaTrackerDeps) {
    this.now = deps.now ?? Date.now;
    this.records = deps.persistence.loadAll();
  }

  /** Open an estimate, or revise the open one without restarting its clock. */
  set(prev: SessionEta | undefined, input: SessionEtaInput, where: EtaWhere): SessionEta {
    const now = this.now();
    const eta = createSessionEta(input, now);
    const reason = rescopeReason(input.rescope);
    // An overdue one the sweep hasn't reached yet is closed, not revived.
    if (prev && this.closeIfOverdue(prev, where)) prev = undefined;
    if (prev && reason) {
      this.close(prev, where, 'rescoped', reason);
      prev = undefined;
    }
    const startedAt = prev ? startOf(prev) : now;
    const firstAt = prev ? firstOf(prev) : eta.at;
    const range = computeEtaRange(this.records, where, startedAt, eta.at);
    return { ...eta, startedAt, firstAt, ...(range ? { range } : {}) };
  }

  /** Record a finished estimate. A close past the cap counts as unmarked, ending at the cap. */
  close(eta: SessionEta, where: EtaWhere, outcome: EtaOutcome, reason?: string): EtaRecord {
    const now = this.now();
    const cap = capOf(eta);
    const finalOutcome: EtaOutcome = now > cap ? 'unmarked' : outcome;
    const record: EtaRecord = {
      startedAt: startOf(eta),
      endedAt: Math.min(now, cap),
      firstAt: firstOf(eta),
      finalAt: eta.at,
      outcome: finalOutcome,
      ...where,
      ...(eta.note ? { note: eta.note } : {}),
      ...(reason && finalOutcome === 'rescoped' ? { reason } : {}),
    };
    this.records.push(record);
    this.deps.persistence.append(record);
    return record;
  }

  /** Close as unmarked once the cap has passed; null while it may still be cleared. */
  closeIfOverdue(eta: SessionEta, where: EtaWhere): EtaRecord | null {
    return this.now() > capOf(eta) ? this.close(eta, where, 'unmarked') : null;
  }

  /** Records that started in [from, to). */
  query(from: number, to: number): EtaRecord[] {
    return this.records.filter(r => r.startedAt >= from && r.startedAt < to);
  }
}

const startOf = (eta: SessionEta): number => eta.startedAt ?? eta.setAt;
const firstOf = (eta: SessionEta): number => eta.firstAt ?? eta.at;

/** Past this an open estimate is abandoned: 3× the first guess, at least 1h, never before a re-set ETA + 10m. */
function capOf(eta: SessionEta): number {
  const start = startOf(eta);
  const window = Math.max(UNMARKED_FACTOR * (firstOf(eta) - start), UNMARKED_MIN_MS);
  return Math.max(start + window, eta.at + UNMARKED_GRACE_MS);
}

function rescopeReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason) throw new Error('rescope must be a non-empty reason');
  return reason;
}

function isLearnable(r: EtaRecord): boolean {
  return r.outcome === 'cleared' && r.firstAt - r.startedAt >= MIN_LEARN_MS;
}

/** The P10–P90 band of past actual ÷ predicted ratios, scaled onto this estimate. */
export function computeEtaRange(
  records: EtaRecord[],
  where: Pick<EtaWhere, 'cliType' | 'dir'>,
  startedAt: number,
  at: number,
): NonNullable<SessionEta['range']> | null {
  const ratios = records
    .filter(r => r.cliType === where.cliType && r.dir === where.dir && isLearnable(r))
    .slice(-MAX_SAMPLES)
    .map(r => (r.endedAt - r.startedAt) / (r.firstAt - r.startedAt))
    .sort((a, b) => a - b);
  if (ratios.length < MIN_SAMPLES) return null;
  const last = ratios.length - 1;
  const p10 = ratios[Math.floor(0.1 * last)];
  const p90 = ratios[Math.ceil(0.9 * last)];
  const predicted = at - startedAt;
  return {
    lo: Math.round(startedAt + p10 * predicted),
    hi: Math.round(startedAt + p90 * predicted),
    samples: ratios.length,
  };
}

/** Headline tiles: on time = finished by the first guess; slip = end − first guess. Rescoped ones are unscored. */
export function summarizeEstimates(all: EtaRecord[]): EtaSummary {
  const rescoped = all.filter(r => r.outcome === 'rescoped').length;
  const records = all.filter(r => r.outcome !== 'rescoped');
  const total = records.length;
  if (!total) return { total: 0, onTimePct: 0, medianSlipMin: 0, unmarked: 0, rescoped };
  const onTime = records.filter(r => r.outcome === 'cleared' && r.endedAt <= r.firstAt).length;
  const slips = records.map(r => (r.endedAt - r.firstAt) / 60_000).sort((a, b) => a - b);
  const mid = slips.length >> 1;
  const median = slips.length % 2 ? slips[mid] : (slips[mid - 1] + slips[mid]) / 2;
  return {
    total,
    onTimePct: Math.round((onTime / total) * 100),
    medianSlipMin: Math.round(median),
    unmarked: records.filter(r => r.outcome === 'unmarked').length,
    rescoped,
  };
}

/** Where an estimate is learned and filed: the session's CLI and folder. */
export function etaWhereOf(session: Pick<SessionInfo, 'cliType' | 'workingDir' | 'name'>): EtaWhere {
  return { cliType: session.cliType, dir: session.workingDir ?? '', sessionName: session.name };
}

/** Close every open estimate past its cap as unmarked and drop it from its session. */
export function sweepOverdueEtas(
  sessions: Pick<SessionManager, 'getAllSessions' | 'updateSession'>,
  tracker: Pick<EtaTracker, 'closeIfOverdue'>,
): void {
  for (const session of sessions.getAllSessions()) {
    if (session.eta && !session.remote && tracker.closeIfOverdue(session.eta, etaWhereOf(session))) {
      sessions.updateSession(session.id, { eta: undefined });
    }
  }
}
