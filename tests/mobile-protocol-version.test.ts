/**
 * mobile-protocol-version — the compatibility gate, tested as pure logic.
 *
 * Every case here is a real product failure someone would otherwise hit on a
 * sideloaded APK that has drifted from the desktop: the asymmetric "Helm is the
 * old one" direction is the one that gets forgotten, so it is tested explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROTOCOL_RANGE,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  negotiateProtocolVersion,
  parseProtocolRange,
} from '../src/mobile/protocol-version';

const LABELS = { local: 'Helm', peer: 'the phone app' };

describe('negotiateProtocolVersion', () => {
  it('selects the highest version both ends support', () => {
    const result = negotiateProtocolVersion({ min: 1, max: 4 }, { min: 2, max: 3 }, LABELS);
    expect(result).toEqual({ ok: true, version: 3 });
  });

  it('succeeds when both ends support exactly one identical version', () => {
    expect(negotiateProtocolVersion({ min: 2, max: 2 }, { min: 2, max: 2 }, LABELS))
      .toEqual({ ok: true, version: 2 });
  });

  it('refuses when the peer is too old, naming both ranges and who must update', () => {
    const result = negotiateProtocolVersion({ min: 3, max: 4 }, { min: 1, max: 2 }, LABELS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('peer-too-old');
    expect(result.message).toContain('3');
    expect(result.message).toContain('2');
    expect(result.message).toContain('Helm');
    expect(result.message).toContain('the phone app');
  });

  it('refuses when the peer is too new — the local side is the stale one', () => {
    const result = negotiateProtocolVersion({ min: 1, max: 2 }, { min: 3, max: 4 }, LABELS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('peer-too-new');
    // The actionable half: the user must update the LOCAL side in this direction.
    expect(result.message).toMatch(/update helm/i);
  });

  it('refuses an inverted range rather than silently repairing it', () => {
    const result = negotiateProtocolVersion({ min: 1, max: 2 }, { min: 5, max: 4 }, LABELS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('malformed-range');
  });

  it('ships a coherent local range', () => {
    expect(PROTOCOL_MIN).toBeGreaterThanOrEqual(1);
    expect(PROTOCOL_MAX).toBeGreaterThanOrEqual(PROTOCOL_MIN);
    expect(LOCAL_PROTOCOL_RANGE).toEqual({ min: PROTOCOL_MIN, max: PROTOCOL_MAX });
  });
});

describe('parseProtocolRange', () => {
  it('accepts a well-formed range', () => {
    expect(parseProtocolRange(1, 3)).toEqual({ min: 1, max: 3 });
  });

  it.each([
    ['absent', undefined, undefined],
    ['null', null, null],
    ['non-numeric', 'two', 'three'],
    ['NaN', Number.NaN, Number.NaN],
    ['fractional', 1.5, 2],
    ['zero', 0, 2],
    ['negative', -1, 2],
    ['inverted', 4, 3],
    ['absurdly large', 1, 1e9],
  ])('rejects a %s range instead of defaulting it', (_label, min, max) => {
    expect(parseProtocolRange(min, max)).toBeNull();
  });
});
