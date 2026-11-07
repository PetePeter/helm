/**
 * Delivery is a serialized per-session transaction.
 *
 * The transaction is nudge -> payload -> settle -> submit. Two concurrent
 * senders — phone chat and inter-session, or a send and a recovery resend — used
 * to each nudge and then write independently, interleaving one message's resize
 * and payload with the other's. A lock inside the write alone would not fix it:
 * both callers can nudge before either writes.
 *
 * These tests drive two genuinely overlapping deliveries against a real
 * PtyManager and a fake PTY that records resizes and writes in one ordered
 * stream, so an unserialized implementation shows up as interleaved bytes
 * rather than as a missing mutex. Every test here was run red against the
 * unlocked code before the lock existed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PtyManager, type PtyFactory, type PtyProcess } from '../src/session/pty-manager.js';
import { DeliveryLock } from '../src/session/delivery-lock.js';
import { deliverPromptSequenceToSession } from '../src/session/sequence-delivery.js';
import { SUBMIT_SETTLE_DELAY_MS } from '../src/session/delivery-context.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Long enough to drain a whole transaction plus its settle delays. */
const DRAIN_MS = 5000;

/**
 * A fake PTY recording resizes and writes into ONE ordered stream. Keeping both
 * in a single array is the point: the bug is a resize landing between another
 * message's payload and its submit, which two separate logs would hide.
 */
function createRecordingPty(events: string[]) {
  const pty: PtyProcess = {
    pid: 1,
    write: (data: string) => { events.push(`write:${data}`); },
    resize: (cols: number, rows: number) => { events.push(`resize:${cols}x${rows}`); },
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  };
  return pty;
}

function makeHarness(sessionIds: string[]) {
  const events: string[] = [];
  const ptys = new Map(sessionIds.map(id => [id, createRecordingPty(events)]));
  const queue = [...sessionIds];
  const factory: PtyFactory = { spawn: () => ptys.get(queue.shift()!)! };
  const ptyManager = new PtyManager(factory);
  for (const id of sessionIds) ptyManager.spawn({ sessionId: id, command: '' });

  const sessionManager = {
    getSession: (id: string) => ({ id, name: id, cliType: 'claude-code' }),
  };
  const configLoader = {
    getCliTypeEntry: () => ({ submitSuffix: '\\r' }),
  };
  const deliveryLock = new DeliveryLock();

  type Verify = Parameters<typeof deliverPromptSequenceToSession>[0]['verifyDelivery'];
  const deliver = (sessionId: string, text: string, verifyDelivery?: Verify) => deliverPromptSequenceToSession({
    sessionId,
    text,
    ptyManager,
    sessionManager: sessionManager as never,
    configLoader: configLoader as never,
    deliveryLock,
    verifyDelivery,
  });

  return { events, ptyManager, deliver, deliveryLock };
}

/** The full ordered event stream one delivery of `text` produces, start to finish. */
function transactionOf(text: string): string[] {
  return ['resize:120x29', 'resize:120x30', `write:${text}`, 'write:\r'];
}

describe('delivery transaction serialization', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('two concurrent deliveries to one session never interleave', async () => {
    const { events, deliver } = makeHarness(['s1']);

    // Both started before either is awaited — genuinely overlapping, not sequential.
    const a = deliver('s1', 'AAA');
    const b = deliver('s1', 'BBB');
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    await Promise.all([a, b]);

    // Each message's resize, payload and submit stay contiguous, in order.
    expect(events).toEqual([...transactionOf('AAA'), ...transactionOf('BBB')]);
  });

  it('keeps the second sender out until the first has submitted, not merely written', async () => {
    const { events, deliver } = makeHarness(['s1']);

    const a = deliver('s1', 'AAA');
    const b = deliver('s1', 'BBB');

    // Far enough for the first nudge and payload, well short of its settle delay.
    await vi.advanceTimersByTimeAsync(SUBMIT_SETTLE_DELAY_MS / 2 + 40);

    // The gap between payload and submit is exactly where the old race let the
    // second sender in — with its nudge, no less.
    expect(events).toEqual(['resize:120x29', 'resize:120x30', 'write:AAA']);

    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    await Promise.all([a, b]);
  });

  it('runs deliveries to different sessions in parallel — the lock is per session', async () => {
    const { events, deliver } = makeHarness(['s1', 's2']);

    const a = deliver('s1', 'AAA');
    const b = deliver('s2', 'BBB');
    await vi.advanceTimersByTimeAsync(SUBMIT_SETTLE_DELAY_MS / 2 + 40);

    // Both payloads are out before either has submitted: a global lock would
    // have held the second session behind the first session's settle delay.
    expect(events.filter(e => e.startsWith('write:'))).toEqual(['write:AAA', 'write:BBB']);

    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    await Promise.all([a, b]);
  });

  it('lets user keystrokes through while a bulk delivery holds the session', async () => {
    const { events, ptyManager, deliver } = makeHarness(['s1']);

    const a = deliver('s1', 'AAA');
    await vi.advanceTimersByTimeAsync(SUBMIT_SETTLE_DELAY_MS / 2 + 40);

    // The user typing must never queue behind a delivery — PtyManager.write is
    // deliberately outside the gate.
    ptyManager.write('s1', 'x');
    expect(events).toContain('write:x');

    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    await a;
  });

  it('does not hold the session across the verification polling window', async () => {
    // A tail that never advances drives verification into its full budget.
    // If the gate were held across that window, the second sender would be
    // stuck behind another message's diagnosis — and recovery, which re-acquires
    // the gate, would be waiting on its own caller.
    const { events, deliver } = makeHarness(['s1']);

    const verified = deliver('s1', 'AAA', { delayMs: 0, retrySubmit: false });
    await vi.advanceTimersByTimeAsync(SUBMIT_SETTLE_DELAY_MS * 2);

    // First transaction is done; verification is now polling.
    expect(events).toEqual(transactionOf('AAA'));

    const second = deliver('s1', 'BBB');
    await vi.advanceTimersByTimeAsync(SUBMIT_SETTLE_DELAY_MS * 2);
    await second;

    // The second message got through while verification was still running.
    expect(events).toEqual([...transactionOf('AAA'), ...transactionOf('BBB')]);

    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    await verified;
  });

  it('queues a recovery resend behind an in-flight delivery instead of interleaving', async () => {
    // No tail probe at all, so verification reports no_signal and recovery
    // replays the whole payload through the same gate.
    const { events, deliver } = makeHarness(['s1']);

    const verified = deliver('s1', 'AAA', { delayMs: 0, retrySubmit: true });
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    const result = await verified;

    // Recovery re-sent, and its payload and submit stay contiguous rather than
    // being spliced into anything. It re-acquires the gate but does not nudge
    // again — the geometry was already fixed by the original transaction.
    expect(result?.retryCount).toBe(1);
    expect(events).toEqual([...transactionOf('AAA'), 'write:AAA', 'write:\r']);
  });

  it('keeps a recovery resend from interleaving with a fresh delivery', async () => {
    const { events, deliver } = makeHarness(['s1']);

    const verified = deliver('s1', 'AAA', { delayMs: 0, retrySubmit: true });
    // Let the first transaction finish and verification start failing.
    await vi.advanceTimersByTimeAsync(SUBMIT_SETTLE_DELAY_MS * 2);

    // A second sender arrives while recovery is about to replay.
    const second = deliver('s1', 'BBB');
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    await Promise.all([verified, second]);

    // Whatever the order the two ended up in, neither was cut in half.
    const writes = events.filter(e => e.startsWith('write:'));
    for (let i = 0; i < writes.length; i += 2) {
      expect(writes[i + 1]).toBe('write:\r');
    }
    expect(writes).toContain('write:BBB');
  });

  it('releases the session when a delivery throws mid-transaction', async () => {
    const { events, ptyManager, deliver } = makeHarness(['s1']);
    const boom = new Error('write exploded');
    let armed = true;
    const original = ptyManager.write.bind(ptyManager);
    vi.spyOn(ptyManager, 'write').mockImplementation((id, data, intent) => {
      if (armed && data === 'AAA') { armed = false; throw boom; }
      return original(id, data, intent);
    });

    const failing = deliver('s1', 'AAA');
    // Attach a handler immediately: the rejection lands while the fake clock is
    // being advanced, long before the assertion below would observe it.
    const failed = failing.then(() => undefined, (err: unknown) => err);
    const after = deliver('s1', 'BBB');
    await vi.advanceTimersByTimeAsync(DRAIN_MS);

    await expect(failed).resolves.toBe(boom);
    await after;

    // The queued delivery still ran — a thrown transaction must not wedge the session.
    expect(events).toContain('write:BBB');
  });
});
