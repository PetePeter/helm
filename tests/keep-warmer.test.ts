/**
 * KeepWarmer: a session with keep-warm on gets a tiny prompt 10 s before its
 * CLI's short prompt cache would lapse (4:50 for a 5-minute cache). It stops by itself after
 * the window it was switched on for, never touches a frozen or hookless session, and
 * leaves the clock to the hooks: an unanswered ping is retried a minute later.
 */
import { describe, expect, it, vi } from 'vitest';
import { KeepWarmer, keepWarmAfterMs } from '../src/session/keep-warmer.js';
import { buildKeepWarmPrompt, KEEP_WARM_DEFAULT_TEXT } from '../src/session/keep-warm-prompt.js';
import { SessionManager } from '../src/session/manager.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The ping a CLI type with no keepWarmPrompt gets. */
const KEEP_WARM_PROMPT = buildKeepWarmPrompt();
const NOW = 1_000_000_000;
const HOUR = 3_600_000;
/** The test CLI's short cache is 5 min, so the ping is due at 4:50. */
const KEEP_WARM_AFTER_MS = 290_000;

function setup(patch: Record<string, unknown> = {}) {
  const sessions = new SessionManager();
  sessions.addSession({
    id: 's1', name: 'worker', cliType: 'test', processId: 1, workingDir: 'C:/w', hooked: true,
    keepWarm: true, lastPromptAt: NOW - KEEP_WARM_AFTER_MS, ...patch,
  });
  const sent: Array<[string, string]> = [];
  const clock = { now: NOW };
  const warmer = new KeepWarmer(sessions, async (id, text) => { sent.push([id, text]); }, () => ({ cacheWarnMinutes: 5 }), { now: () => clock.now });
  return { sessions, warmer, sent, clock };
}

describe('KeepWarmer', () => {
  it("pings 10 s before each CLI type's short cache lapses", () => {
    expect(keepWarmAfterMs({ cacheWarnMinutes: 5 })).toBe(290_000);
    expect(keepWarmAfterMs({ cacheWarnMinutes: 60 })).toBe(3_590_000);
  });

  it('pings once its last prompt is 4:50 old and leaves the clock to the hooks', async () => {
    const { sessions, warmer, sent } = setup();
    await warmer.tick();
    expect(sent).toEqual([['s1', KEEP_WARM_PROMPT]]);
    expect(sessions.getSession('s1')?.lastPromptAt).toBe(NOW - KEEP_WARM_AFTER_MS);
  });

  it('holds while green — a hook fired recently, so the CLI is still working — then pings once blue', async () => {
    const { sessions, warmer, sent } = setup({ activityLevel: 'active' });
    await warmer.tick();
    expect(sent).toEqual([]);
    sessions.updateSession('s1', { activityLevel: 'inactive' });
    await warmer.tick();
    expect(sent).toHaveLength(1);
  });

  it('retries an unanswered ping a minute later, not sooner', async () => {
    const { warmer, sent, clock } = setup();
    await warmer.tick();
    clock.now = NOW + 59_999;
    await warmer.tick();
    expect(sent).toHaveLength(1);
    clock.now = NOW + 60_000;
    await warmer.tick();
    expect(sent).toHaveLength(2);
  });

  it('stops pinging once a hook restarts the clock', async () => {
    const { sessions, warmer, sent, clock } = setup();
    await warmer.tick();
    sessions.updateSession('s1', { lastPromptAt: NOW + 1_000 });
    clock.now = NOW + 60_000;
    await warmer.tick();
    expect(sent).toHaveLength(1);
  });

  it("sends the CLI type's own keepWarmPrompt inside the fixed markers", async () => {
    const sessions = new SessionManager();
    sessions.addSession({ id: 's1', name: 'w', cliType: 'codex', processId: 1, hooked: true, keepWarm: true, lastPromptAt: NOW - HOUR });
    const sent: string[] = [];
    const warmer = new KeepWarmer(sessions, async (_id, text) => { sent.push(text); }, () => ({ keepWarmPrompt: 'still there?' }), { now: () => NOW });
    await warmer.tick();
    expect(sent).toEqual(['[HEARTBEAT_START] still there?[HEARTBEAT_END]']);
  });

  it('falls back to the default text when the configured one is blank', () => {
    expect(buildKeepWarmPrompt('   ')).toBe(KEEP_WARM_PROMPT);
    expect(KEEP_WARM_PROMPT).toBe(`[HEARTBEAT_START] ${KEEP_WARM_DEFAULT_TEXT}[HEARTBEAT_END]`);
  });

  it('keeps exactly one marker pair, whatever the configured text carries', () => {
    // An older config stored the whole ping; a stray marker would close the pair early.
    expect(buildKeepWarmPrompt('{Esc}[HEARTBEAT_START] ping [heartbeat_end] more[HEARTBEAT_END]'))
      .toBe('[HEARTBEAT_START] ping  more[HEARTBEAT_END]');
    expect(buildKeepWarmPrompt('[HEARTBEAT_START][HEARTBEAT_END]')).toBe(KEEP_WARM_PROMPT);
  });

  it('keeps a multi-line text on one line so the pair bounds a single prompt', () => {
    expect(buildKeepWarmPrompt('one\n  two\r\nthree')).toBe('[HEARTBEAT_START] one two three[HEARTBEAT_END]');
  });

  it('does nothing inside the window, frozen, hookless, or without keep-warm', async () => {
    for (const patch of [
      { lastPromptAt: NOW - KEEP_WARM_AFTER_MS + 1 },
      { hooked: false },
      { frozen: true },
      { keepWarm: undefined },
    ]) {
      const { warmer, sent } = setup(patch);
      await warmer.tick();
      expect(sent).toEqual([]);
    }
  });

  it('never switches itself off — still pinging a day later', async () => {
    const { sessions, warmer, sent, clock } = setup({ lastPromptAt: NOW + 24 * HOUR - KEEP_WARM_AFTER_MS });
    clock.now = NOW + 24 * HOUR;
    await warmer.tick();
    expect(sent).toHaveLength(1);
    expect(sessions.getSession('s1')?.keepWarm).toBe(true);
  });
});
