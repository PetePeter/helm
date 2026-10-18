import type { SessionEta } from '../types/session.js';

export interface SessionEtaInput {
  minutes?: unknown;
  at?: unknown;
  note?: unknown;
}

/** Create the durable ETA record from exactly one relative or absolute time. */
export function createSessionEta(input: SessionEtaInput, now = Date.now()): SessionEta {
  const hasMinutes = input.minutes !== undefined;
  const hasAt = input.at !== undefined;
  if (hasMinutes === hasAt) {
    throw new Error('Exactly one of minutes or at is required');
  }

  let at: number;
  if (hasMinutes) {
    if (typeof input.minutes !== 'number' || !Number.isFinite(input.minutes) || input.minutes <= 0) {
      throw new Error('minutes must be a finite positive number');
    }
    at = now + input.minutes * 60_000;
  } else {
    if (typeof input.at !== 'number' || !isEpochMilliseconds(input.at)) {
      throw new Error('at must be a finite epoch-millisecond timestamp');
    }
    at = input.at;
  }

  if (!isEpochMilliseconds(now) || !isEpochMilliseconds(at)) {
    throw new Error('ETA time must be a valid epoch-millisecond timestamp');
  }
  if (input.note !== undefined && typeof input.note !== 'string') {
    throw new Error('note must be a string');
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  return { at, setAt: now, ...(note ? { note } : {}) };
}

/** Ignore malformed hand-edited persistence data without discarding its session. */
export function isSessionEta(value: unknown): value is SessionEta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const eta = value as Record<string, unknown>;
  return isEpochMilliseconds(eta.at)
    && isEpochMilliseconds(eta.setAt)
    && (eta.note === undefined || typeof eta.note === 'string');
}

function isEpochMilliseconds(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isFinite(new Date(value).getTime());
}
