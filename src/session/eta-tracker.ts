/**
 * EtaTracker — scores the LLM's completion estimates against reality.
 *
 * session_eta_set opens an estimate; session_eta_clear closes it. A re-set
 * never restarts the clock: actual time runs from the first set and is scored
 * against the first guess, so re-setting a tiny ETA over and over only shows
 * as late. An estimate not cleared by ETA + 10m is "unmarked" — its end is
 * capped there and it is kept out of learning, as are first guesses under 5m.
 * The learned P10–P90 ratio band (actual ÷ predicted, per CLI + folder) is
 * snapshotted onto each new ETA as its confidence range. See docs/session-eta.md.
 */

import type { SessionEta, SessionInfo } from '../types/session.js';
import type { SessionManager } from './manager.js';
import { createSessionEta, type SessionEtaInput } from './session-eta.js';
import type { EtaPersistence } from './eta-persistence.js';

export const UNMARKED_GRACE_MS = 10 * 60_000;
export const MIN_LEARN_MS = 5 * 60_000;
export const MIN_SAMPLES = 5;
const MAX_SAMPLES = 50;

export type EtaOutcome = 'cleared' | 'unmarked';

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
    // An overdue one the sweep hasn't reached yet is closed, not revived.
    if (prev && this.closeIfOverdue(prev, where)) prev = undefined;
    const startedAt = prev ? startOf(prev) : now;
    const firstAt = prev ? firstOf(prev) : eta.at;
    const range = computeEtaRange(this.records, where, startedAt, eta.at);
    return { ...eta, startedAt, firstAt, ...(range ? { range } : {}) };
  }

  /** Record a finished estimate. A clear past the grace still counts as unmarked. */
  close(eta: SessionEta, where: EtaWhere, outcome: EtaOutcome): EtaRecord {
    const now = this.now();
    const cap = eta.at + UNMARKED_GRACE_MS;
    const finalOutcome: EtaOutcome = now > cap ? 'unmarked' : outcome;
    const record: EtaRecord = {
      startedAt: startOf(eta),
      endedAt: Math.min(now, cap),
      firstAt: firstOf(eta),
      finalAt: eta.at,
      outcome: finalOutcome,
      ...where,
      ...(eta.note ? { note: eta.note } : {}),
    };
    this.records.push(record);
    this.deps.persistence.append(record);
    return record;
  }

  /** Close as unmarked once ETA + grace has passed; null while still in time. */
  closeIfOverdue(eta: SessionEta, where: EtaWhere): EtaRecord | null {
    return this.now() > eta.at + UNMARKED_GRACE_MS ? this.close(eta, where, 'unmarked') : null;
  }

  /** Records that started in [from, to). */
  query(from: number, to: number): EtaRecord[] {
    return this.records.filter(r => r.startedAt >= from && r.startedAt < to);
  }
}

const startOf = (eta: SessionEta): number => eta.startedAt ?? eta.setAt;
const firstOf = (eta: SessionEta): number => eta.firstAt ?? eta.at;

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

/** Headline tiles: on time = finished by the first guess; slip = end − first guess. */
export function summarizeEstimates(records: EtaRecord[]): EtaSummary {
  const total = records.length;
  if (!total) return { total: 0, onTimePct: 0, medianSlipMin: 0, unmarked: 0 };
  const onTime = records.filter(r => r.outcome === 'cleared' && r.endedAt <= r.firstAt).length;
  const slips = records.map(r => (r.endedAt - r.firstAt) / 60_000).sort((a, b) => a - b);
  const mid = slips.length >> 1;
  const median = slips.length % 2 ? slips[mid] : (slips[mid - 1] + slips[mid]) / 2;
  return {
    total,
    onTimePct: Math.round((onTime / total) * 100),
    medianSlipMin: Math.round(median),
    unmarked: records.filter(r => r.outcome === 'unmarked').length,
  };
}

/** Where an estimate is learned and filed: the session's CLI and folder. */
export function etaWhereOf(session: Pick<SessionInfo, 'cliType' | 'workingDir' | 'name'>): EtaWhere {
  return { cliType: session.cliType, dir: session.workingDir ?? '', sessionName: session.name };
}

/** Close every open estimate past ETA + grace as unmarked and drop it from its session. */
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
