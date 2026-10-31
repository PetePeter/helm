import { describe, expect, it, vi } from 'vitest';
import { verifyDeliveryAfterDelay } from '../src/session/delivery-verification.js';
import type { DeliveryVerificationRequest } from '../src/session/delivery-verification.js';
import { TerminalOutputBuffer } from '../src/session/terminal-output-buffer.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SESSION_ID = 's1';

function makeRequest(
  buffer: TerminalOutputBuffer,
  overrides: Partial<DeliveryVerificationRequest> = {},
): DeliveryVerificationRequest {
  return {
    sessionId: SESSION_ID,
    text: 'hello world this is a delivery',
    submitSuffix: '\r',
    delayMs: 0, // fast-mode budgets
    ptyManager: {
      getTerminalTail: (sid, lines, mode, stripBlankLines) =>
        buffer.tail(sid, lines, mode, stripBlankLines),
    },
    ...overrides,
  };
}

describe('verifyDeliveryAfterDelay — activity-timestamp polling', () => {
  it('returns confirmed when tail activity advances twice after delivery', async () => {
    const buffer = new TerminalOutputBuffer();
    // Seed baseline: one append before verification starts.
    buffer.append(SESSION_ID, 'baseline\n');

    const request = makeRequest(buffer);
    const promise = verifyDeliveryAfterDelay(request);

    // Phase 1 advance: lastOutputAt > baseline.
    setTimeout(() => buffer.append(SESSION_ID, 'echo of input\n'), 30);
    // Phase 2 advance: must be > firstAdvanceAt + 250ms (MIN_PROGRESS_GAP_MS).
    setTimeout(() => buffer.append(SESSION_ID, 'response part 1\n'), 350);

    const result = await promise;
    expect(result.status).toBe('confirmed');
    expect(result.retryAttempted).toBe(false);
  });

  it('returns no_signal when tail activity never advances', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline only\n');

    const request = makeRequest(buffer);
    const result = await verifyDeliveryAfterDelay(request);
    expect(result.status).toBe('no_signal');
  });

  it('returns suspected_stuck when tail advances once but then stalls', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline\n');

    const request = makeRequest(buffer);
    const promise = verifyDeliveryAfterDelay(request);

    // Single advance during phase 1 window; nothing further.
    setTimeout(() => buffer.append(SESSION_ID, 'echo of input\n'), 30);

    const result = await promise;
    expect(result.status).toBe('suspected_stuck');
  });

  it('returns unverifiable when getTerminalTail is unavailable', async () => {
    const request: DeliveryVerificationRequest = {
      sessionId: SESSION_ID,
      text: 'something',
      submitSuffix: '\r',
      delayMs: 0,
      ptyManager: {},
    };
    const result = await verifyDeliveryAfterDelay(request);
    expect(result.status).toBe('unverifiable');
  });

  it('returns unverifiable with "no payload delivered" when text and submitSuffix are empty', async () => {
    const buffer = new TerminalOutputBuffer();
    const request = makeRequest(buffer, { text: '', submitSuffix: '' });
    const result = await verifyDeliveryAfterDelay(request);
    expect(result.status).toBe('unverifiable');
    expect(result.detail).toContain('no payload delivered');
  });

  it('does not attempt recovery when retrySubmit is false', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline\n');
    const deliverText = vi.fn();
    const request = makeRequest(buffer, {
      retrySubmit: false,
      ptyManager: {
        getTerminalTail: (sid, lines, mode, strip) => buffer.tail(sid, lines, mode, strip),
        deliverText,
      },
    });

    const result = await verifyDeliveryAfterDelay(request);

    expect(result.status).toBe('no_signal');
    expect(result.retryAttempted).toBe(false);
    expect(deliverText).not.toHaveBeenCalled();
  });
});

/**
 * Recovery: the CLI took the text into its prompt but never submitted it (the
 * "stuck on the prompt" bug), or never saw it at all. Detection already existed;
 * these cover the remedy.
 */
describe('verifyDeliveryAfterDelay — recovery', () => {
  /**
   * A CLI that accepted the input: it echoes, then keeps emitting as it generates.
   * The verifier reads two advances after its baseline as "moving".
   */
  function respondLikeGeneratingCli(buffer: TerminalOutputBuffer): void {
    buffer.append(SESSION_ID, 'ack\n');
    setTimeout(() => buffer.append(SESSION_ID, 'thinking\n'), 150);
    setTimeout(() => buffer.append(SESSION_ID, 'generating\n'), 450);
  }

  it('re-sends the submit suffix when stuck, and reports retry_confirmed once it moves', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline\n');
    const deliverText = vi.fn(async () => respondLikeGeneratingCli(buffer));

    const request = makeRequest(buffer, {
      writeIntent: 'system',
      ptyManager: {
        getTerminalTail: (sid, lines, mode, strip) => buffer.tail(sid, lines, mode, strip),
        deliverText,
      },
    });
    const promise = verifyDeliveryAfterDelay(request);
    // Echo of our input only — the CLI parked the text on its prompt.
    setTimeout(() => buffer.append(SESSION_ID, 'echo of input\n'), 30);

    const result = await promise;

    expect(result.status).toBe('retry_confirmed');
    expect(result.retryCount).toBe(1);
    expect(result.retryAttempted).toBe(true);
  });

  it('stuck recovery re-sends ONLY the suffix — never the text', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline\n');
    const deliverText = vi.fn(async () => respondLikeGeneratingCli(buffer));

    const request = makeRequest(buffer, {
      writeIntent: 'system',
      ptyManager: {
        getTerminalTail: (sid, lines, mode, strip) => buffer.tail(sid, lines, mode, strip),
        deliverText,
      },
    });
    const promise = verifyDeliveryAfterDelay(request);
    setTimeout(() => buffer.append(SESSION_ID, 'echo of input\n'), 30);
    await promise;

    expect(deliverText).toHaveBeenCalledTimes(1);
    expect(deliverText).toHaveBeenCalledWith(
      SESSION_ID,
      '',
      expect.objectContaining({ submitSuffix: '\r', writeIntent: 'system' }),
    );
  });

  it('gives up as retry_failed after two suffix re-sends that change nothing', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline\n');
    const deliverText = vi.fn(async (_sessionId: string, _text: string) => {});

    const request = makeRequest(buffer, {
      ptyManager: {
        getTerminalTail: (sid, lines, mode, strip) => buffer.tail(sid, lines, mode, strip),
        deliverText,
      },
    });
    const promise = verifyDeliveryAfterDelay(request);
    setTimeout(() => buffer.append(SESSION_ID, 'echo of input\n'), 30);

    const result = await promise;

    expect(result.status).toBe('retry_failed');
    expect(result.retryCount).toBe(2);
    expect(deliverText).toHaveBeenCalledTimes(2);
    expect(deliverText.mock.calls.every(call => call[1] === '')).toBe(true);
  });

  it('re-sends the full text exactly once when nothing arrived at all', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline\n');
    const deliverText = vi.fn(async () => respondLikeGeneratingCli(buffer));

    const request = makeRequest(buffer, {
      ptyManager: {
        getTerminalTail: (sid, lines, mode, strip) => buffer.tail(sid, lines, mode, strip),
        deliverText,
      },
    });

    const result = await verifyDeliveryAfterDelay(request);

    expect(result.status).toBe('retry_confirmed');
    expect(result.retryCount).toBe(1);
    expect(deliverText).toHaveBeenCalledTimes(1);
    expect(deliverText).toHaveBeenCalledWith(
      SESSION_ID,
      'hello world this is a delivery',
      expect.objectContaining({ submitSuffix: '\r' }),
    );
  });
});

describe('verifyDeliveryAfterDelay — prompt-submit hook confirmation', () => {
  // A TUI composer repaint after paste ticks the tail twice without submitting.
  function repaintTwice(buffer: TerminalOutputBuffer): void {
    setTimeout(() => buffer.append(SESSION_ID, 'pasted into composer\n'), 20);
    setTimeout(() => buffer.append(SESSION_ID, 'composer redraw\n'), 300);
  }

  function hookRequest(
    buffer: TerminalOutputBuffer,
    lastAt: () => number | undefined,
    deliverText = vi.fn(async (_sid: string, _text: string, _opts?: object) => {}),
  ) {
    return {
      deliverText,
      request: makeRequest(buffer, {
        promptSubmit: { since: Date.now() - 1, lastAt },
        ptyManager: {
          getTerminalTail: (sid, lines, mode, strip) => buffer.tail(sid, lines, mode, strip),
          deliverText,
        },
      }),
    };
  }

  it('re-sends Enter when the tail moves but the submit hook never fires', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline\n');
    let submittedAt = Date.now() - 10_000; // an earlier turn proved hooks fire
    const { request, deliverText } = hookRequest(buffer, () => submittedAt, vi.fn(async () => {
      submittedAt = Date.now();
    }));
    repaintTwice(buffer);

    const result = await verifyDeliveryAfterDelay(request);

    expect(result.status).toBe('retry_confirmed');
    expect(result.retryCount).toBe(1);
    expect(deliverText).toHaveBeenCalledWith(SESSION_ID, '', expect.objectContaining({ submitSuffix: '\r' }));
  });

  it('confirms without recovery when the submit hook fires', async () => {
    const buffer = new TerminalOutputBuffer();
    let submittedAt = Date.now() - 10_000; // an earlier turn proved hooks fire
    const { request, deliverText } = hookRequest(buffer, () => submittedAt);
    setTimeout(() => { submittedAt = Date.now(); }, 30);

    const result = await verifyDeliveryAfterDelay(request);

    expect(result.status).toBe('confirmed');
    expect(deliverText).not.toHaveBeenCalled();
  });

  it('counts a submit hook that fired before verification started', async () => {
    const buffer = new TerminalOutputBuffer();
    const { request, deliverText } = hookRequest(buffer, () => Date.now());

    const result = await verifyDeliveryAfterDelay(request);

    expect(result.status).toBe('confirmed');
    expect(deliverText).not.toHaveBeenCalled();
  });

  it('ignores a submit hook from before the delivery', async () => {
    const buffer = new TerminalOutputBuffer();
    const stale = Date.now() - 10_000;
    const { request, deliverText } = hookRequest(buffer, () => stale);
    repaintTwice(buffer);

    const result = await verifyDeliveryAfterDelay(request);

    expect(result.status).toBe('retry_failed');
    expect(result.retryCount).toBe(2);
    // Enter only — the composer already holds the text.
    expect(deliverText.mock.calls.every(call => call[1] === '')).toBe(true);
  });

  it('uses the hook on the first delivery to a hooked session with no submit yet', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline\n');
    const { request, deliverText } = hookRequest(buffer, () => 0);
    repaintTwice(buffer);

    const result = await verifyDeliveryAfterDelay(request);

    expect(result.status).toBe('retry_failed');
    expect(deliverText.mock.calls.every(call => call[1] === '')).toBe(true);
  });

  it('falls back to tail timing when the session has never reported a submit hook', async () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append(SESSION_ID, 'baseline\n');
    const { request, deliverText } = hookRequest(buffer, () => undefined);
    repaintTwice(buffer);

    const result = await verifyDeliveryAfterDelay(request);

    expect(result.status).toBe('confirmed');
    expect(deliverText).not.toHaveBeenCalled();
  });
});
