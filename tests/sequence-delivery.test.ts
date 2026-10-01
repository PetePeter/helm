import { describe, expect, it, vi } from 'vitest';
import { deliverPromptSequenceToSession, setDeliveryObserver } from '../src/session/sequence-delivery.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeMocks(overrides?: { submitSuffix?: string; cliType?: string }) {
  const submitSuffix = overrides?.submitSuffix ?? '\\r';
  const cliType = overrides?.cliType ?? 'claude-code';
  const ptyManager = {
    write: vi.fn(),
    deliverText: vi.fn(() => Promise.resolve()),
    nudgeResize: vi.fn(() => Promise.resolve()),
    has: vi.fn(() => true),
    getTerminalTail: undefined as any,
  };
  const sessionManager = {
    getSession: vi.fn(() => ({ id: 's1', name: 'Test', cliType })),
  };
  const configLoader = {
    getCliTypeEntry: vi.fn(() => ({ submitSuffix })),
  };
  return { ptyManager, sessionManager, configLoader };
}

function deliver(input: string, mocks: ReturnType<typeof makeMocks>, opts?: { origin?: 'user' | 'system'; impliedSubmit?: boolean; deliveryContext?: 'background' | 'interactive'; verifyDelivery?: { label?: string; delayMs?: number; retrySubmit?: boolean } }) {
  return deliverPromptSequenceToSession({
    sessionId: 's1',
    text: input,
    ptyManager: mocks.ptyManager as any,
    sessionManager: mocks.sessionManager as any,
    configLoader: mocks.configLoader as any,
    ...opts,
  });
}

describe('deliverPromptSequenceToSession', () => {
  it('tells the delivery observer each delivery and its origin (time tracking)', async () => {
    const seen: string[] = [];
    setDeliveryObserver((id, origin) => seen.push(`${id}:${origin}`));
    try {
      await deliver('from the phone', makeMocks(), { origin: 'user' });
      await deliver('from another agent', makeMocks());
    } finally {
      setDeliveryObserver(null);
    }
    expect(seen).toEqual(['s1:user', 's1:system']);
  });

  it('plain text delivers via deliverText and submits via deliverText with submitSuffix', async () => {
    const mocks = makeMocks();

    await deliver('hello', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'hello');
    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
    expect(mocks.ptyManager.write).not.toHaveBeenCalledWith('s1', '\r');
  });

  it('{NoSend} suppresses implied submit', async () => {
    const mocks = makeMocks();

    // {NoSend} is a recognized token — smart escaping preserves it
    await deliver('hello{NoSend}', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'hello');
    expect(mocks.ptyManager.deliverText).not.toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
  });

  it('{Send} submits at token position with no extra final submit', async () => {
    const mocks = makeMocks();

    // {Send} is a recognized token — smart escaping preserves it
    await deliver('part1{Send}part2', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'part1');
    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'part2');
    // Only one submit for the explicit {Send}, no final implied submit
    const submitCalls = mocks.ptyManager.deliverText.mock.calls.filter(
      (c: any[]) => c[0] === 's1' && c[2]?.submitSuffix === '\r',
    );
    expect(submitCalls).toHaveLength(1);
  });

  it('{Wait 500} delays between actions', async () => {
    vi.useFakeTimers();
    try {
      const mocks = makeMocks();

      const promise = deliver('before{Wait 500}after', mocks);

      // Flush the pre-delivery nudgeResize await so 'before' is delivered before the wait
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'before');
      expect(mocks.ptyManager.deliverText).not.toHaveBeenCalledWith('s1', 'after');

      // Advance past the 500ms wait plus the submit settle delay that fires afterwards
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'after');
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects recipient CLI submit suffix (bash \\n)', async () => {
    const mocks = makeMocks({ submitSuffix: '\\n' });

    await deliver('hello', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\n' });
  });

  it('passes background delivery context to text chunks and submit suffix when requested', async () => {
    const mocks = makeMocks();

    await deliver('hello', mocks, { deliveryContext: 'background' });

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'hello', { deliveryContext: 'background' });
    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '', {
      deliveryContext: 'background',
      submitSuffix: '\r',
    });
  });

  it('JSON braces in text are preserved as literal text', async () => {
    const mocks = makeMocks();

    // {"key":"value"} is NOT a recognized token — smart escaping escapes braces
    // to {{"key":"value"}}, which the parser renders as literal {"key":"value"}
    await deliver('{"key":"value"}', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '{"key":"value"}');
  });

  it('mixed JSON and {Send} token both work correctly', async () => {
    const mocks = makeMocks();

    // JSON gets escaped, {Send} is preserved as a recognized token
    await deliver('analyze {"a":1} then {Enter}', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'analyze {"a":1} then ');
    expect(mocks.ptyManager.deliverText).not.toHaveBeenCalledWith('s1', 'analyze {"a":1} then \n');
  });

  it('throws when session not found', async () => {
    const mocks = makeMocks();
    mocks.sessionManager.getSession.mockReturnValue(null);

    await expect(deliver('hello', mocks)).rejects.toThrow('Session not found');
  });

  it('multiple {Send} tokens submit at each position', async () => {
    const mocks = makeMocks();

    await deliver('a{Send}b{Send}c', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'a');
    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'b');
    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'c');

    // Two explicit {Send} submissions, no final implied submit
    const submitCalls = mocks.ptyManager.deliverText.mock.calls.filter(
      (c: any[]) => c[0] === 's1' && c[2]?.submitSuffix === '\r',
    );
    expect(submitCalls).toHaveLength(2);
  });

  it('{Enter} behaves same as {Send}', async () => {
    const mocks = makeMocks();

    await deliver('hello{Enter}world', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'hello');
    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'world');

    // One submit for {Enter}, no final implied submit
    const submitCalls = mocks.ptyManager.deliverText.mock.calls.filter(
      (c: any[]) => c[0] === 's1' && c[2]?.submitSuffix === '\r',
    );
    expect(submitCalls).toHaveLength(1);
  });

  it('combo tokens like {Ctrl+C} are preserved and executed', async () => {
    const mocks = makeMocks();

    await deliver('{Ctrl+C}', mocks);

    // Ctrl+C maps to \x03 via comboToPtySequence
    expect(mocks.ptyManager.write).toHaveBeenCalledWith('s1', '\x03');
  });

  it('modifier tokens like {Ctrl Down} are preserved', async () => {
    const mocks = makeMocks();

    await deliver('{Ctrl Down}text{Ctrl Up}', mocks);

    // modifier actions produce no PTY data (actionToPtyData returns null)
    // but text 'text' should be delivered
    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'text');
  });

  it('F-key tokens are preserved', async () => {
    const mocks = makeMocks();

    await deliver('{F5}', mocks);

    // F5 maps to \x1b[15~
    expect(mocks.ptyManager.write).toHaveBeenCalledWith('s1', '\x1b[15~');
  });

  it('{NoEnter} suppresses implied submit (alias for NoSend)', async () => {
    const mocks = makeMocks();

    await deliver('hello{NoEnter}', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'hello');
    expect(mocks.ptyManager.deliverText).not.toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
  });

  it('unrecognized brace groups like {variable} are escaped to literal text', async () => {
    const mocks = makeMocks();

    await deliver('value: {variable} end', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'value: {variable} end');
  });

  it('text with no braces passes through unchanged', async () => {
    const mocks = makeMocks();

    await deliver('plain text no braces', mocks);

    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'plain text no braces');
  });

  describe('nested literal braces', () => {
    it('preserves nested JSON like {"a":{"b":1}}', async () => {
      const mocks = makeMocks();
      await deliver('{"a":{"b":1}}', mocks);
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '{"a":{"b":1}}');
    });

    it('preserves code with nested object literals', async () => {
      const mocks = makeMocks();
      await deliver('function x() { return { a: 1 }; }', mocks);
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'function x() { return { a: 1 }; }');
    });

    it('preserves HELM_MSG-like nested JSON envelope', async () => {
      const mocks = makeMocks();
      const envelope = '[HELM_MSG] {"type":"reply","sessionId":"s1","data":{"key":"val"}} [/HELM_MSG]';
      await deliver(envelope, mocks);
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', envelope);
    });

    it('preserves nested JSON and still honors trailing {NoSend}', async () => {
      const mocks = makeMocks();
      await deliver('{"a":{"b":1}}{NoSend}', mocks);
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '{"a":{"b":1}}');
      expect(mocks.ptyManager.deliverText).not.toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
    });

    it('preserves nested JSON and still honors trailing {Send}', async () => {
      const mocks = makeMocks();
      await deliver('{"a":{"b":1}}{Send}more text', mocks);
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '{"a":{"b":1}}');
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'more text');
      const submitCalls = mocks.ptyManager.deliverText.mock.calls.filter(
        (c: any[]) => c[0] === 's1' && c[2]?.submitSuffix === '\r',
      );
      expect(submitCalls).toHaveLength(1);
    });

    it('preserves deeply nested JSON (3 levels)', async () => {
      const mocks = makeMocks();
      await deliver('{"a":{"b":{"c":1}}}', mocks);
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '{"a":{"b":{"c":1}}}');
    });

    it('handles mixed text, nested JSON, and recognized tokens', async () => {
      const mocks = makeMocks();
      await deliver('check {"config":{"debug":true}} and {Enter}continue', mocks);
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'check {"config":{"debug":true}} and ');
      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'continue');
    });
  });

  describe('submit routing', () => {
    it('implied submit routes through deliverText with submitSuffix option, not write', async () => {
      const mocks = makeMocks();
      await deliver('hello', mocks);

      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
      expect(mocks.ptyManager.write).not.toHaveBeenCalledWith('s1', '\r');
    });

    it('no submit when impliedSubmit is false and no explicit {Send}', async () => {
      const mocks = makeMocks();
      await deliver('hello', mocks, { impliedSubmit: false });

      expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'hello');
      expect(mocks.ptyManager.deliverText).not.toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
      expect(mocks.ptyManager.write).not.toHaveBeenCalledWith('s1', '\r');
    });

    it('explicit {Send} submit passes correct submitSuffix per CLI config', async () => {
      const mocks = makeMocks({ submitSuffix: '\\r\\n' });
      await deliver('go{Send}', mocks);

      const submitCalls = mocks.ptyManager.deliverText.mock.calls.filter(
        (c: any[]) => c[0] === 's1' && c[2]?.submitSuffix === '\r\n',
      );
      expect(submitCalls).toHaveLength(1);
    });
  });

  describe('submit delay', () => {
    it('submit fires a settle delay after text flush (real timers)', async () => {
      // Verify SUBMIT_SETTLE_DELAY_MS is respected at runtime — the gap is what stops
      // an Ink TUI from swallowing Enter while it is still ingesting the paste.
      // We record the timestamp inside deliverText and compare to when the submit arrives.
      const mocks = makeMocks({ cliType: 'cmd' });
      let textFlushAt = 0;
      let submitAt = 0;

      mocks.ptyManager.deliverText.mockImplementation(async (_sid: string, _chunk: string, opts?: any) => {
        if (opts?.submitSuffix !== undefined) {
          submitAt = Date.now();
        } else {
          textFlushAt = Date.now();
        }
      });

      await deliver('hello', mocks);

      expect(submitAt).toBeGreaterThan(0);
      expect(textFlushAt).toBeGreaterThan(0);
      expect(submitAt - textFlushAt).toBeGreaterThanOrEqual(390); // 10ms tolerance
    });

    it('explicit {Enter} token submits exactly once even with the delay', async () => {
      // Regression: the 200ms delay must not cause double-submit when sequence
      // contains an explicit {Enter} token (which itself triggers submit).
      const mocks = makeMocks({ cliType: 'cmd' });

      await deliver('hello{Enter}', mocks);

      const submitCalls = mocks.ptyManager.deliverText.mock.calls.filter(
        (c: any[]) => c[0] === 's1' && c[2]?.submitSuffix !== undefined,
      );
      expect(submitCalls).toHaveLength(1);
    });
  });

  describe('delivery verification (activity-timestamp polling)', () => {
    it('confirms delivery when tail activity advances twice after delivery', async () => {
      const { TerminalOutputBuffer } = await import('../src/session/terminal-output-buffer.js');
      const text = 'hello please execute this prompt now';
      const mocks = makeMocks();
      const buffer = new TerminalOutputBuffer();
      buffer.append('s1', 'baseline\n');
      mocks.ptyManager.getTerminalTail = ((sid: string, lines: number, mode: any, strip?: boolean) =>
        buffer.tail(sid, lines, mode, strip)) as any;

      // Note: the submit settle delay runs inside deliver() before verification starts.
      // Phase 1 advance: shortly into the verification window.
      setTimeout(() => buffer.append('s1', 'echo of input\n'), 450);
      // Phase 2 advance: must beat firstAdvance + 250ms gap.
      setTimeout(() => buffer.append('s1', 'response part 1\n'), 800);

      const result = await deliver(text, mocks, {
        verifyDelivery: { label: 'test delivery', delayMs: 0 },
      });

      expect(result?.status).toBe('confirmed');
      // Only the initial submit — a landed delivery needs no recovery.
      const submitCalls = mocks.ptyManager.deliverText.mock.calls.filter((c: any[]) => c[2]?.submitSuffix === '\r');
      expect(submitCalls).toHaveLength(1);
    });

    it('re-submits and reports retry_failed when the CLI stalls on the prompt', async () => {
      const { TerminalOutputBuffer } = await import('../src/session/terminal-output-buffer.js');
      const text = 'hello please execute this prompt now';
      const mocks = makeMocks();
      const buffer = new TerminalOutputBuffer();
      buffer.append('s1', 'baseline\n');
      mocks.ptyManager.getTerminalTail = ((sid: string, lines: number, mode: any, strip?: boolean) =>
        buffer.tail(sid, lines, mode, strip)) as any;

      // One advance — no further activity. Fires after the submit settle delay so
      // verification observes it as a fresh Phase 1 advance, then nothing more.
      setTimeout(() => buffer.append('s1', 'echo of input\n'), 450);

      const result = await deliver(text, mocks, {
        verifyDelivery: { label: 'test delivery', delayMs: 0 },
      });

      expect(result?.status).toBe('retry_failed');
      // Initial submit plus two recovery re-submits, none of which carried the text again.
      const submitCalls = mocks.ptyManager.deliverText.mock.calls.filter((c: any[]) => c[2]?.submitSuffix === '\r');
      expect(submitCalls).toHaveLength(3);
      expect(submitCalls.every((c: any[]) => c[1] === '')).toBe(true);
    });

    it('re-sends the whole payload when the CLI never showed any activity', async () => {
      const { TerminalOutputBuffer } = await import('../src/session/terminal-output-buffer.js');
      const mocks = makeMocks();
      const buffer = new TerminalOutputBuffer();
      buffer.append('s1', 'baseline only\n');
      mocks.ptyManager.getTerminalTail = ((sid: string, lines: number, mode: any, strip?: boolean) =>
        buffer.tail(sid, lines, mode, strip)) as any;

      const text = 'hello please execute this prompt now';
      const result = await deliver(text, mocks, {
        verifyDelivery: { label: 'test delivery', delayMs: 0 },
      });

      expect(result?.status).toBe('retry_failed');
      expect(result?.retryCount).toBe(1);
      // The whole payload is replayed through the sequence executor: text chunk then submit.
      const textCalls = mocks.ptyManager.deliverText.mock.calls.filter((c: any[]) => c[1] === text);
      expect(textCalls).toHaveLength(2);
    });
  });
});

describe('deliverPromptSequenceToSession — API tools', () => {
  it('skips terminal-activity verification: an API session takes the line synchronously', async () => {
    const mocks = makeMocks();
    mocks.configLoader.getCliTypeEntry.mockReturnValue({ submitSuffix: '\r', api: { baseUrl: 'x', model: 'm', allowedTools: [] } } as any);
    // Verification would read the terminal tail; an API session must never reach it.
    mocks.ptyManager.getTerminalTail = vi.fn(() => { throw new Error('verification must not run'); });

    const result = await deliver('hi', mocks, { verifyDelivery: { label: 'test', delayMs: 0 } });

    expect(result).toBeUndefined();
    expect(mocks.ptyManager.deliverText).toHaveBeenCalledWith('s1', 'hi');
  });
});
