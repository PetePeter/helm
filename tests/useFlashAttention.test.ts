import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useFlashAttention,
  __resetFlashAttention,
  pickGroupFlashEntry,
  PULSE_DURATION_MS,
  type FlashEntry,
} from '../renderer/composables/useFlashAttention.js';

function entry(overrides: Partial<FlashEntry>): FlashEntry {
  return { sessionId: 'x', phase: 'pulse', startedAt: 0, ...overrides };
}

describe('useFlashAttention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetFlashAttention();
  });

  afterEach(() => {
    __resetFlashAttention();
    vi.useRealTimers();
  });

  it('starts a flash in the pulse phase', () => {
    const flash = useFlashAttention();
    flash.start({ sessionId: 's1' });

    expect(flash.isFlashing('s1')).toBe(true);
    expect(flash.entries.get('s1')?.phase).toBe('pulse');
  });

  it('flips from pulse to solid after the pulse duration', () => {
    const flash = useFlashAttention();
    flash.start({ sessionId: 's1' });

    vi.advanceTimersByTime(PULSE_DURATION_MS);

    expect(flash.entries.get('s1')?.phase).toBe('solid');
  });

  it('clear() removes the flash (session was focused)', () => {
    const flash = useFlashAttention();
    flash.start({ sessionId: 's1' });

    flash.clear('s1');

    expect(flash.isFlashing('s1')).toBe(false);
    // The pending solid-phase timer must not resurrect the entry.
    vi.advanceTimersByTime(PULSE_DURATION_MS);
    expect(flash.isFlashing('s1')).toBe(false);
  });

  it('reports a group as flashing when any member session flashes', () => {
    const flash = useFlashAttention();
    flash.start({ sessionId: 's2' });

    expect(flash.groupIsFlashing(['s1', 's2', 's3'])).toBe(true);
    expect(flash.groupIsFlashing(['s1', 's3'])).toBe(false);
  });
});

describe('pickGroupFlashEntry', () => {
  it('returns null when no member is flashing', () => {
    const map = new Map<string, FlashEntry>([['a', entry({ sessionId: 'a' })]]);
    expect(pickGroupFlashEntry(map, ['b', 'c'])).toBeNull();
  });

  it('prefers a newer pulse over an older solid (staggered members)', () => {
    const map = new Map<string, FlashEntry>([
      ['a', entry({ sessionId: 'a', phase: 'solid', startedAt: 100 })],
      ['b', entry({ sessionId: 'b', phase: 'pulse', startedAt: 200 })],
    ]);
    expect(pickGroupFlashEntry(map, ['a', 'b'])?.sessionId).toBe('b');
  });

  it('prefers a pulse even when the solid entry started later', () => {
    const map = new Map<string, FlashEntry>([
      ['a', entry({ sessionId: 'a', phase: 'pulse', startedAt: 100 })],
      ['b', entry({ sessionId: 'b', phase: 'solid', startedAt: 300 })],
    ]);
    expect(pickGroupFlashEntry(map, ['a', 'b'])?.sessionId).toBe('a');
  });

  it('breaks ties by most recent start within the same phase', () => {
    const map = new Map<string, FlashEntry>([
      ['a', entry({ sessionId: 'a', phase: 'solid', startedAt: 100 })],
      ['b', entry({ sessionId: 'b', phase: 'solid', startedAt: 400 })],
    ]);
    expect(pickGroupFlashEntry(map, ['a', 'b'])?.sessionId).toBe('b');
  });
});
