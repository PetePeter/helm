import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ESC_SETTLE_MS, HANDOVER_KICKOFF, HandoverDelivery } from '../src/session/handover-delivery.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FLOOR_MS = 15_000;
const CEILING_MS = 120_000;
const SILENCE_MS = 10_000;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setup() {
  const ptyOutput = new EventEmitter();
  const sessionManager = new EventEmitter();
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const losses: Array<{ sessionId: string; reason: string }> = [];
  const handover = new HandoverDelivery(
    ptyOutput,
    sessionManager as any,
    async (sessionId, text) => {
      delivered.push({ sessionId, text });
    },
    (sessionId, reason) => {
      losses.push({ sessionId, reason });
    },
    { floorMs: FLOOR_MS, ceilingMs: CEILING_MS, silenceMs: SILENCE_MS },
  );
  const output = (sessionId: string) => ptyOutput.emit('data', sessionId, 'x');

  return { ptyOutput, sessionManager, handover, delivered, losses, output };
}

describe('HandoverDelivery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers once the PTY has been silent, with no activity-state change at all', async () => {
    vi.useFakeTimers();
    const { handover, delivered } = setup();

    // Hook sessions after a /clear: no Stop hook, no state edge — only silence.
    handover.arm('s1', 'cleared', { floorMs: 2_000 });
    vi.advanceTimersByTime(SILENCE_MS - 1);
    await flush();
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'cleared' }]);
    expect(handover.isPending('s1')).toBe(false);
    handover.dispose();
  });

  it('output restarts the silence window; output from other sessions does not', async () => {
    vi.useFakeTimers();
    const { handover, delivered, output } = setup();

    handover.arm('s1', 'note', { floorMs: 0 });
    vi.advanceTimersByTime(SILENCE_MS - 1000);
    output('s1');
    output('s2');
    vi.advanceTimersByTime(SILENCE_MS - 1);
    await flush();
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'note' }]);
    handover.dispose();
  });

  it('silence inside the floor waits for the floor to pass', async () => {
    vi.useFakeTimers();
    const { handover, delivered } = setup();

    // A stall before compaction really starts looks exactly like completion.
    handover.arm('s1', 'compact');
    vi.advanceTimersByTime(FLOOR_MS - 1);
    await flush();
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'compact' }]);
    handover.dispose();
  });

  it('delivers at the ceiling when the PTY never falls silent', async () => {
    vi.useFakeTimers();
    const { handover, delivered, output } = setup();

    handover.arm('s1', 'spinner');
    for (let t = 0; t < CEILING_MS - 1000; t += 1000) {
      vi.advanceTimersByTime(1000);
      output('s1');
    }
    await flush();
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1000);
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'spinner' }]);
    handover.dispose();
  });

  describe('Esc retry (a /clear whose terminal never falls quiet)', () => {
    function setupNudge() {
      const ptyOutput = new EventEmitter();
      const delivered: string[] = [];
      const nudged: string[] = [];
      const handover = new HandoverDelivery(
        ptyOutput, new EventEmitter() as any,
        async (_id, text) => { delivered.push(text); }, () => {},
        { floorMs: 0, ceilingMs: CEILING_MS, silenceMs: SILENCE_MS, nudge: id => nudged.push(id) },
      );
      const keepBusy = (ms: number) => {
        for (let t = 0; t < ms; t += 1000) { vi.advanceTimersByTime(1000); ptyOutput.emit('data', 's1', 'x'); }
      };
      return { handover, delivered, nudged, keepBusy };
    }

    it('at the ceiling sends Esc once, then delivers on the silence that follows', async () => {
      vi.useFakeTimers();
      const { handover, delivered, nudged, keepBusy } = setupNudge();
      handover.arm('s1', 'resume', { floorMs: 0, escRetry: true });
      keepBusy(CEILING_MS);
      await flush();
      expect(nudged).toEqual(['s1']);
      expect(delivered).toEqual([]);

      vi.advanceTimersByTime(SILENCE_MS);
      await flush();
      expect(delivered).toEqual(['resume']);
      handover.dispose();
    });

    it('still busy after the retry: pastes anyway at the second ceiling', async () => {
      vi.useFakeTimers();
      const { handover, delivered, nudged, keepBusy } = setupNudge();
      handover.arm('s1', 'resume', { floorMs: 0, escRetry: true });
      keepBusy(CEILING_MS * 2);
      await flush();
      expect(nudged).toEqual(['s1']);
      expect(delivered).toEqual(['resume']);
      handover.dispose();
    });

    it('never nudges a handover armed without escRetry (Esc would abort a /compact)', async () => {
      vi.useFakeTimers();
      const { handover, delivered, nudged, keepBusy } = setupNudge();
      handover.arm('s1', 'compact note');
      keepBusy(CEILING_MS);
      await flush();
      expect(nudged).toEqual([]);
      expect(delivered).toEqual(['compact note']);
      handover.dispose();
    });
  });

  it('sendNow pastes immediately inside the floor, once, and settles', async () => {
    vi.useFakeTimers();
    const { handover, delivered } = setup();

    handover.arm('s1', 'forced');
    const settled = handover.whenSettled('s1');
    handover.sendNow('s1');
    await flush();
    await settled;
    vi.advanceTimersByTime(CEILING_MS);
    await flush();

    expect(delivered).toEqual([{ sessionId: 's1', text: 'forced' }]);
    expect(handover.isPending('s1')).toBe(false);
    handover.dispose();
  });

  it('delivers exactly once — re-arming replaces the text and the old timers never double up', async () => {
    vi.useFakeTimers();
    const { handover, delivered } = setup();

    handover.arm('s1', 'stale');
    handover.arm('s1', 'fresh');
    vi.advanceTimersByTime(CEILING_MS * 2);
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'fresh' }]);
    handover.dispose();
  });

  it('cancel and session close both suppress delivery and report the loss', async () => {
    vi.useFakeTimers();
    const { handover, sessionManager, delivered, losses } = setup();

    handover.arm('s1', 'cancelled text');
    handover.cancel('s1');
    handover.arm('s2', 'closed text');
    sessionManager.emit('session:removed', { sessionId: 's2' });
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
    const { handover, delivered, output } = setup();

    handover.arm('s1', 'for one');
    handover.arm('s2', 'for two');
    vi.advanceTimersByTime(FLOOR_MS - 1000);
    output('s2');
    vi.advanceTimersByTime(1000);
    await flush();
    expect(delivered).toEqual([{ sessionId: 's1', text: 'for one' }]);
    expect(handover.isPending('s2')).toBe(true);

    vi.advanceTimersByTime(SILENCE_MS);
    await flush();
    expect(delivered).toEqual([
      { sessionId: 's1', text: 'for one' },
      { sessionId: 's2', text: 'for two' },
    ]);
    handover.dispose();
  });

  describe('PreCompact hook (G3)', () => {
    it('delivers immediately, ignoring the floor', async () => {
      vi.useFakeTimers();
      const { handover, delivered } = setup();

      // The CLI said the context is being discarded NOW.
      handover.arm('s1', 'precompact text');
      handover.deliverFromPreCompact('s1');
      await flush();

      expect(delivered).toEqual([{ sessionId: 's1', text: 'precompact text' }]);
      expect(handover.isPending('s1')).toBe(false);
      handover.dispose();
    });

    it('never double-delivers — the later silence finds nothing', async () => {
      vi.useFakeTimers();
      const { handover, delivered } = setup();

      handover.arm('s1', 'once only');
      handover.deliverFromPreCompact('s1');
      await flush();
      vi.advanceTimersByTime(CEILING_MS);
      await flush();

      expect(delivered).toEqual([{ sessionId: 's1', text: 'once only' }]);
      handover.dispose();
    });

    it('is a no-op when no handover is pending', async () => {
      vi.useFakeTimers();
      const { handover, delivered, losses } = setup();

      handover.deliverFromPreCompact('s1');
      await flush();

      expect(delivered).toEqual([]);
      expect(losses).toEqual([]);
      handover.dispose();
    });
  });

  describe('whenSettled', () => {
    function setupSlowPaste() {
      let finishPaste!: () => void;
      const order: string[] = [];
      const handover = new HandoverDelivery(
        new EventEmitter(),
        new EventEmitter() as any,
        () => new Promise<void>(resolve => { order.push('paste-start'); finishPaste = resolve; }),
        () => {},
        { floorMs: FLOOR_MS, ceilingMs: CEILING_MS, silenceMs: SILENCE_MS },
      );
      return { handover, order, finishPaste: () => finishPaste() };
    }

    it('resolves at once with nothing armed', async () => {
      const { handover } = setup();
      await expect(handover.whenSettled('s1')).resolves.toBeUndefined();
      handover.dispose();
    });

    it('resolves only after the handover paste has landed', async () => {
      vi.useFakeTimers();
      const { handover, order, finishPaste } = setupSlowPaste();
      handover.arm('s1', 'note');
      void handover.whenSettled('s1').then(() => order.push('settled'));

      vi.advanceTimersByTime(FLOOR_MS);
      await flush();
      // Off the pending map already, but the paste is still being written.
      expect(handover.isPending('s1')).toBe(false);
      expect(order).toEqual(['paste-start']);

      finishPaste();
      await flush();
      expect(order).toEqual(['paste-start', 'settled']);
      handover.dispose();
    });

    it('resolves when the handover is cancelled or its session closes', async () => {
      const { handover, sessionManager } = setup();
      handover.arm('s1', 'a');
      handover.arm('s2', 'b');
      const settled: string[] = [];
      void handover.whenSettled('s1').then(() => settled.push('s1'));
      void handover.whenSettled('s2').then(() => settled.push('s2'));

      handover.cancel('s1');
      sessionManager.emit('session:removed', { sessionId: 's2' });
      await flush();
      expect(settled).toEqual(['s1', 's2']);
      handover.dispose();
    });

    it('stays listed for a reloaded renderer while its paste is still being written', async () => {
      vi.useFakeTimers();
      const { handover, finishPaste } = setupSlowPaste();
      handover.arm('s1', 'note');
      vi.advanceTimersByTime(FLOOR_MS);
      await flush();
      expect(handover.pendingIds()).toEqual(['s1']);

      finishPaste();
      await flush();
      expect(handover.pendingIds()).toEqual([]);
      handover.dispose();
    });

    it('a note armed mid-paste is not unlocked by the earlier paste finishing', async () => {
      vi.useFakeTimers();
      const { handover, finishPaste } = setupSlowPaste();
      const delivered: string[] = [];
      handover.on('handover-delivered', ({ sessionId }) => delivered.push(sessionId));
      handover.arm('s1', 'first');
      vi.advanceTimersByTime(FLOOR_MS);
      await flush();

      handover.arm('s1', 'second');
      finishPaste();
      await flush();
      expect(delivered).toEqual([]);
      expect(handover.pendingIds()).toEqual(['s1']);
      handover.dispose();
    });

    it('keeps waiting through a re-arm until the newer note is pasted', async () => {
      vi.useFakeTimers();
      const { handover } = setup();
      handover.arm('s1', 'first');
      let settled = false;
      void handover.whenSettled('s1').then(() => { settled = true; });

      handover.arm('s1', 'second');
      await flush();
      expect(settled).toBe(false);

      vi.advanceTimersByTime(FLOOR_MS);
      await flush();
      expect(settled).toBe(true);
      handover.dispose();
    });
  });

  it('a note the SessionStart hook carried is not re-pasted, but a kick-off prompt still starts the turn', async () => {
    // Regression: SessionStart context never starts a model turn, so settling
    // here left a freshly cleared session sitting idle with its handover.
    vi.useFakeTimers();
    const { handover, delivered } = setup();
    const events: string[] = [];
    handover.on('handover-delivered', ({ sessionId }) => events.push(sessionId));
    handover.arm('s1', 'resume');

    handover.markDeliveredByHook('s1');
    expect(handover.peek('s1')).toBeUndefined();
    expect(events).toEqual([]);

    vi.advanceTimersByTime(FLOOR_MS);
    await flush();

    expect(delivered).toEqual([{ sessionId: 's1', text: HANDOVER_KICKOFF }]);
    expect(events).toEqual(['s1']);
    expect(handover.pendingIds()).toEqual([]);
    handover.dispose();
  });

  describe('runWhenIdle (gate before a compact)', () => {
    function setupGate() {
      const ptyOutput = new EventEmitter();
      const sessionManager = new EventEmitter();
      const nudged: string[] = [];
      const ran: string[] = [];
      const handover = new HandoverDelivery(
        ptyOutput, sessionManager as any, async () => {}, () => {},
        { floorMs: 0, ceilingMs: CEILING_MS, silenceMs: SILENCE_MS, nudge: id => nudged.push(id) },
      );
      const output = () => ptyOutput.emit('data', 's1', 'x');
      const run = (label: string) => handover.runWhenIdle('s1', async () => { ran.push(label); });
      return { handover, sessionManager, nudged, ran, output, run };
    }

    it('runs at once when the terminal has been quiet for the silence window', async () => {
      vi.useFakeTimers();
      const { handover, ran, output, run } = setupGate();
      output();
      vi.advanceTimersByTime(SILENCE_MS);
      run('compact');
      await flush();
      expect(ran).toEqual(['compact']);
      handover.dispose();
    });

    it('waits out ongoing output, each chunk restarting the window', async () => {
      vi.useFakeTimers();
      const { handover, ran, output, run } = setupGate();
      output();
      run('compact');
      vi.advanceTimersByTime(SILENCE_MS - 1);
      output();
      vi.advanceTimersByTime(SILENCE_MS - 1);
      await flush();
      expect(ran).toEqual([]);
      vi.advanceTimersByTime(1);
      await flush();
      expect(ran).toEqual(['compact']);
      handover.dispose();
    });

    it('still busy at the ceiling: sends Esc, settles briefly, then runs', async () => {
      vi.useFakeTimers();
      const { handover, nudged, ran, output, run } = setupGate();
      output();
      run('compact');
      for (let t = 0; t < CEILING_MS; t += 1000) { vi.advanceTimersByTime(1000); output(); }
      await flush();
      expect(nudged).toEqual(['s1']);
      expect(ran).toEqual([]);
      vi.advanceTimersByTime(ESC_SETTLE_MS);
      await flush();
      expect(ran).toEqual(['compact']);
      handover.dispose();
    });

    it('a closed session never runs its queued compact', async () => {
      vi.useFakeTimers();
      const { handover, sessionManager, ran, output, run } = setupGate();
      output();
      run('compact');
      sessionManager.emit('session:removed', { sessionId: 's1' });
      vi.advanceTimersByTime(CEILING_MS + ESC_SETTLE_MS);
      await flush();
      expect(ran).toEqual([]);
      handover.dispose();
    });

    it('a second request while waiting replaces the first: one compact', async () => {
      vi.useFakeTimers();
      const { handover, ran, output, run } = setupGate();
      output();
      run('first');
      run('second');
      vi.advanceTimersByTime(SILENCE_MS);
      await flush();
      expect(ran).toEqual(['second']);
      handover.dispose();
    });
  });
});
