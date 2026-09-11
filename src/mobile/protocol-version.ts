/**
 * protocol-version — the compatibility gate between Helm and the phone app.
 *
 * WHY A PROTOCOL VERSION AND NOT A PRODUCT VERSION: Helm auto-updates on the
 * desktop while the APK is sideloaded, so the two drift constantly. Pinning
 * "Helm x.y.z requires app a.b.c" needs editing on every release and says
 * nothing useful when it fails. A protocol version is decoupled from both
 * product versions and changes only when the WIRE changes.
 *
 * Each side declares a supported RANGE and the highest common version wins.
 * Product versions are still exchanged, but purely so the refusal message can
 * name something a human recognises — they never gate the decision.
 *
 * RULE: any breaking wire change increments `PROTOCOL_MAX` and adds a row to the
 * version history table in `docs/mobile-secure-channel.md`, in the same commit.
 * Additive changes do neither.
 */

/** Oldest wire protocol this build can still speak. */
export const PROTOCOL_MIN = 1;

/** Newest wire protocol this build speaks. Bump on any breaking wire change. */
export const PROTOCOL_MAX = 1;

/** Sanity ceiling — a version beyond this is corruption, not a future build. */
const PROTOCOL_ABSURD = 4096;

export interface ProtocolRange {
  readonly min: number;
  readonly max: number;
}

export const LOCAL_PROTOCOL_RANGE: ProtocolRange = { min: PROTOCOL_MIN, max: PROTOCOL_MAX };

/**
 * A refusal code is ALWAYS relative to whoever is holding it: `peer-too-old`
 * means "the other end is the old one". It is written to the wire from the
 * refuser's point of view and inverted on receipt, so neither side has to
 * reason about perspective. The human message travels alongside and names both
 * sides explicitly, so it needs no inversion.
 */
export type ProtocolRefusalCode = 'peer-too-old' | 'peer-too-new' | 'malformed-range';

export interface ProtocolLabels {
  /** How to name this side in a message, e.g. "Helm". */
  local: string;
  /** How to name the other side, e.g. "the phone app". */
  peer: string;
}

export type NegotiationOutcome =
  | { ok: true; version: number }
  | { ok: false; code: ProtocolRefusalCode; message: string };

/**
 * Validate an untrusted pair of range endpoints. Returns null for anything
 * malformed — never a default, because defaulting a garbage version to 0 or to
 * PROTOCOL_MAX turns a corrupt frame into a silently accepted session.
 */
export function parseProtocolRange(min: unknown, max: unknown): ProtocolRange | null {
  if (!isVersion(min) || !isVersion(max)) return null;
  if (min > max) return null;
  return { min, max };
}

/** Pick the highest version both ranges contain, or explain why there is none. */
export function negotiateProtocolVersion(
  local: ProtocolRange,
  peer: ProtocolRange,
  labels: ProtocolLabels,
): NegotiationOutcome {
  if (!parseProtocolRange(local.min, local.max) || !parseProtocolRange(peer.min, peer.max)) {
    return {
      ok: false,
      code: 'malformed-range',
      message: `${labels.peer} sent an unusable protocol range. Reinstall ${labels.peer}.`,
    };
  }

  const version = Math.min(local.max, peer.max);
  if (version >= Math.max(local.min, peer.min)) return { ok: true, version };

  const ranges = `${labels.local} speaks protocol ${describe(local)}; `
    + `${labels.peer} speaks ${describe(peer)}.`;
  return peer.max < local.min
    ? {
      ok: false,
      code: 'peer-too-old',
      message: `${capitalize(labels.peer)} is too old for this version of ${labels.local}. `
        + `${ranges} Update ${labels.peer}.`,
    }
    : {
      ok: false,
      code: 'peer-too-new',
      message: `${capitalize(labels.local)} is too old for this version of ${labels.peer}. `
        + `${ranges} Update ${labels.local}.`,
    };
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= PROTOCOL_ABSURD;
}

function describe(range: ProtocolRange): string {
  return range.min === range.max ? `${range.min}` : `${range.min}–${range.max}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
