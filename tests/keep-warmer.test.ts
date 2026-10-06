/**
 * KeepWarmer: a session with keep-warm on gets a tiny prompt 10 s before its
 * CLI's short prompt cache would lapse (4:50 for a 5-minute cache). It stops by itself after
 * the window it was switched on for, and never touches a frozen or busy session.
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
    id: 's1', name: 'worker', cliType: 'test', processId: 1, workingDir: 'C:/w',
    keepWarmUntil: NOW + HOUR, lastPromptAt: NOW - KEEP_WARM_AFTER_MS, ...patch,
  });
  const sent: Array<[string, string]> = [];
  const warmer = new KeepWarmer(sessions, async (id, text) => { sent.push([id, text]); }, () => ({ cacheWarnMinutes: 5 }), { now: () => NOW });
  return { sessions, warmer, sent };
}

describe('KeepWarmer', () => {
  it("pings 10 s before each CLI type's short cache lapses", () => {
    expect(keepWarmAfterMs({ cacheWarnMinutes: 5 })).toBe(290_000);
    expect(keepWarmAfterMs({ cacheWarnMinutes: 60 })).toBe(3_590_000);
  });

  it('pings a keep-warm session once its last prompt is 4:50 old, and restarts its clock', async () => {
    const { sessions, warmer, sent } = setup();
    await warmer.tick();
    expect(sent).toEqual([['s1', KEEP_WARM_PROMPT]]);
    expect(sessions.getSession('s1')?.lastPromptAt).toBe(NOW);
  });

  it("sends the CLI type's own keepWarmPrompt inside the fixed markers", async () => {
    const sessions = new SessionManager();
    sessions.addSession({ id: 's1', name: 'w', cliType: 'codex', processId: 1, keepWarmUntil: NOW + HOUR, lastPromptAt: NOW - HOUR });
    const sent: string[] = [];
    const warmer = new KeepWarmer(sessions, async (_id, text) => { sent.push(text); }, () => ({ keepWarmPrompt: 'still there?' }), { now: () => NOW });
    await warmer.tick();
    expect(sent).toEqual(['{Esc}[HEARTBEAT_START] still there?[HEARTBEAT_END]']);
  });

  it('falls back to the default text when the configured one is blank', () => {
    expect(buildKeepWarmPrompt('   ')).toBe(KEEP_WARM_PROMPT);
    expect(KEEP_WARM_PROMPT).toBe(`{Esc}[HEARTBEAT_START] ${KEEP_WARM_DEFAULT_TEXT}[HEARTBEAT_END]`);
  });

  it('keeps exactly one marker pair, whatever the configured text carries', () => {
    // An older config stored the whole ping; a stray marker would close the pair early.
    expect(buildKeepWarmPrompt('{Esc}[HEARTBEAT_START] ping [heartbeat_end] more[HEARTBEAT_END]'))
      .toBe('{Esc}[HEARTBEAT_START] ping  more[HEARTBEAT_END]');
    expect(buildKeepWarmPrompt('[HEARTBEAT_START][HEARTBEAT_END]')).toBe(KEEP_WARM_PROMPT);
  });

  it('keeps a multi-line text on one line so the pair bounds a single prompt', () => {
    expect(buildKeepWarmPrompt('one\n  two\r\nthree')).toBe('{Esc}[HEARTBEAT_START] one two three[HEARTBEAT_END]');
  });

  it('does nothing inside the window, while busy, frozen, or without keep-warm', async () => {
    for (const patch of [
      { lastPromptAt: NOW - KEEP_WARM_AFTER_MS + 1 },
      { activityLevel: 'active' },
      { frozen: true },
      { keepWarmUntil: undefined },
    ]) {
      const { warmer, sent } = setup(patch);
      await warmer.tick();
      expect(sent).toEqual([]);
    }
  });

  it('switches itself off once its window has passed', async () => {
    const { sessions, warmer, sent } = setup({ keepWarmUntil: NOW - 1 });
    await warmer.tick();
    expect(sent).toEqual([]);
    expect(sessions.getSession('s1')?.keepWarmUntil).toBeUndefined();
  });
});
