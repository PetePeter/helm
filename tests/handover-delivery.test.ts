import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandoverDelivery } from '../src/session/handover-delivery.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FLOOR_MS = 15_000;
const CEILING_MS = 300_000;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setup() {
  const stateDetector = new EventEmitter();
  const sessionManager = new EventEmitter();
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const losses: Array<{ sessionId: string; reason: string }> = [];
  const handover = new HandoverDelivery(
    stateDetector as any,
    sessionManager as any,
    async (sessionId, text) => {
      delivered.push({ sessionId, text });
    },
    (sessionId, reason) => {
      losses.push({ sessionId, reason });
    },
    { floorMs: FLOOR_MS, ceilingMs: CEILING_MS },
  );

  /** Emit the active→inactive edge the real StateDetector produces after 10s of silence. */
  const goInactive = (sessionId: string) => {
    stateDetector.emit('activity-change', { sessionId, level: 'inactive', lastOutputAt: Date.now() });
  };

  return { stateDetector, sessionManager, handover, delivered, losses, goInactive };
}

describe('HandoverDelivery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers on the first inactive edge after arming, and stays inert without one', async () => {
    vi.useFakeTimers();
    const { handover, delivered, goInactive } = setup();

    handover.arm('s1', 'handover text');
    // A session already sitting inactive emits no new edge. Nothing may fire on
    // the strength of a state that predates the compact command.
    vi.advanceTimersByTime(FLOOR_MS + 1000);
    await flush();
    expect(delivered).toEqual([]);

    goInactive('s1');
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'handover text' }]);
    expect(handover.isPending('s1')).toBe(false);

    handover.dispose();
  });

  it('ignores an edge inside the floor, and delivers at the ceiling when no edge arrives', async () => {
    vi.useFakeTimers();
    const { handover, delivered, goInactive } = setup();

    handover.arm('s1', 'early');
    // A stall before compaction really starts looks exactly like completion.
    vi.advanceTimersByTime(FLOOR_MS - 1000);
    goInactive('s1');
    await flush();
    expect(delivered).toEqual([]);
    expect(handover.isPending('s1')).toBe(true);

    // A CLI that never goes quiet must not swallow the handover entirely.
    vi.advanceTimersByTime(CEILING_MS);
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'early' }]);

    handover.dispose();
  });

  it('delivers exactly once — re-arming replaces the text and the ceiling never doubles up', async () => {
    vi.useFakeTimers();
    const { handover, delivered, goInactive } = setup();

    handover.arm('s1', 'stale');
    handover.arm('s1', 'fresh');
    vi.advanceTimersByTime(FLOOR_MS + 1000);
    goInactive('s1');
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'fresh' }]);

    // Neither the superseded arm's ceiling nor further silence may re-paste it.
    vi.advanceTimersByTime(CEILING_MS * 2);
    goInactive('s1');
    await flush();
    expect(delivered).toHaveLength(1);

    handover.dispose();
  });

  it('cancel and session close both suppress delivery and report the loss', async () => {
    vi.useFakeTimers();
    const { handover, sessionManager, delivered, losses, goInactive } = setup();

    handover.arm('s1', 'cancelled text');
    handover.cancel('s1');
    handover.arm('s2', 'closed text');
    sessionManager.emit('session:removed', { sessionId: 's2' });

    vi.advanceTimersByTime(FLOOR_MS + 1000);
    goInactive('s1');
    goInactive('s2');
    vi.advanceTimersByTime(CEILING_MS);
    await flush();

    expect(delivered).toEqual([]);
    expect(losses).toEqual([
      { sessionId: 's1', reason: 'cancelled' },
      { sessionId: 's2', reason: 'session-closed' },
    ]);

    handover.dispose();
  });

  it('keeps concurrent sessions isolated', async () => {
    vi.useFakeTimers();
    const { handover, delivered, goInactive } = setup();

    handover.arm('s1', 'for one');
    handover.arm('s2', 'for two');
    vi.advanceTimersByTime(FLOOR_MS + 1000);

    goInactive('s1');
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'for one' }]);
    expect(handover.isPending('s2')).toBe(true);

    goInactive('s2');
    await flush();
    expect(delivered).toEqual([
      { sessionId: 's1', text: 'for one' },
      { sessionId: 's2', text: 'for two' },
    ]);

    handover.dispose();
  });

  describe('PreCompact hook (G3)', () => {
    it('delivers immediately, ignoring the lull floor', async () => {
      vi.useFakeTimers();
      const { handover, delivered } = setup();

      // Armed less than one floor ago — the heuristic would refuse this edge;
      // PreCompact must not. The CLI said the context is being discarded NOW.
      handover.arm('s1', 'precompact text');
      handover.deliverFromPreCompact('s1');
      await flush();

      expect(delivered).toEqual([{ sessionId: 's1', text: 'precompact text' }]);
      expect(handover.isPending('s1')).toBe(false);

      handover.dispose();
    });

    it('never double-delivers — the fallback lull edge finds nothing afterwards', async () => {
      vi.useFakeTimers();
      const { handover, delivered, goInactive } = setup();

      handover.arm('s1', 'once only');
      handover.deliverFromPreCompact('s1');
      await flush();

      // Post-compaction the terminal goes quiet again: the heuristic edge for
      // a session without hooks. The entry is already gone, so this is inert.
      goInactive('s1');
      vi.advanceTimersByTime(CEILING_MS);
      await flush();

      expect(delivered).toEqual([{ sessionId: 's1', text: 'once only' }]);

      handover.dispose();
    });

    it('is a no-op when no handover is pending', async () => {
      vi.useFakeTimers();
      const { handover, delivered, losses } = setup();

      // PreCompact fires on every compaction, hooked or not, armed or not —
      // a session that never armed a handover must not lose or error here.
      handover.deliverFromPreCompact('s1');
      await flush();

      expect(delivered).toEqual([]);
      expect(losses).toEqual([]);

      handover.dispose();
    });
  });
});
