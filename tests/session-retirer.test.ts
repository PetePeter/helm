/**
 * SessionRetirer: closing a CLI session first asks its LLM to save key memories
 * and close itself. The row stays (marked retiring) until the LLM calls
 * session_close, a second close arrives, the session goes quiet after taking
 * the prompt, or 5 minutes pass.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionRetirer, RETIRE_TIMEOUT_MS } from '../src/session/session-retirer.js';
import { SessionManager } from '../src/session/manager.js';
import { renderHookInjection } from '../src/session/hooks/hook-injections.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NOW = 1_000_000_000;

function setup(patch: Record<string, unknown> = {}, config: { saveMemoriesOnClose?: boolean } = {}) {
  const sessions = new SessionManager();
  sessions.addSession({
    id: 's1', name: 'worker', cliType: 'claude', processId: 1, workingDir: 'C:/w', hooked: true,
    lastPromptAt: NOW - 60_000, activityLevel: 'inactive', ...patch,
  });
  const sent: Array<[string, string]> = [];
  const closed: string[] = [];
  const clock = { now: NOW };
  let sendFails = false;
  const retirer = new SessionRetirer({
    sessionManager: sessions,
    send: async (id, text) => { if (sendFails) throw new Error('pty gone'); sent.push([id, text]); },
    cliConfig: () => config,
    hardClose: ({ id }) => { closed.push(id); sessions.removeSession(id); },
    prompt: () => renderHookInjection('closeSaveMemories'),
    now: () => clock.now,
  });
  const close = (options?: { force?: boolean }) => retirer.close(sessions.getSession('s1')!, options);
  return { sessions, retirer, close, sent, closed, clock, failSend: () => { sendFails = true; } };
}

describe('SessionRetirer', () => {
  it('retires instead of closing: row stays, marked, and the LLM gets the save-memories prompt', async () => {
    const { sessions, retirer, close, sent, closed } = setup();
    expect(await close()).toBe('retiring');
    expect(closed).toEqual([]);
    expect(sessions.getSession('s1')?.retiringAt).toBe(NOW);
    expect(sent).toEqual([['s1', renderHookInjection('closeSaveMemories')]]);
  });

  it('closes at once when the CLI type switched it off', async () => {
    const { retirer, close, sent, closed } = setup({}, { saveMemoriesOnClose: false });
    expect(await close()).toBe('closed');
    expect(closed).toEqual(['s1']);
    expect(sent).toEqual([]);
  });

  it('a second close of a retiring session — the LLM itself or the user — closes it for real', async () => {
    const { retirer, close, closed } = setup();
    await close();
    expect(await close()).toBe('closed');
    expect(closed).toEqual(['s1']);
  });

  it('force skips the prompt', async () => {
    const { retirer, close, sent, closed } = setup();
    expect(await close({ force: true })).toBe('closed');
    expect(sent).toEqual([]);
    expect(closed).toEqual(['s1']);
  });

  it.each([
    ['an API tool', { apiTool: true }],
    ['a ComfyUI tool', { comfyUiTool: true }],
    ['a remote row', { remote: { peerId: 'p', sessionId: 'x' } }],
    ['a never-prompted session', { lastPromptAt: undefined }],
    ['a frozen session (takes no input)', { frozen: true }],
  ])('closes %s at once', async (_label, patch) => {
    const { retirer, close, sent, closed } = setup(patch);
    expect(await close()).toBe('closed');
    expect(sent).toEqual([]);
    expect(closed).toEqual(['s1']);
  });

  it('closes when the prompt cannot be delivered', async () => {
    const { retirer, close, closed, failSend } = setup();
    failSend();
    expect(await close()).toBe('closed');
    expect(closed).toEqual(['s1']);
  });

  it('gives up after 5 minutes', async () => {
    const { retirer, close, closed, clock } = setup();
    await close();
    clock.now = NOW + RETIRE_TIMEOUT_MS - 1;
    retirer.tick();
    expect(closed).toEqual([]);
    clock.now = NOW + RETIRE_TIMEOUT_MS;
    retirer.tick();
    expect(closed).toEqual(['s1']);
  });

  it('closes once the session took the prompt and went quiet, not while it works', async () => {
    const { sessions, retirer, close, closed, clock } = setup();
    await close();
    retirer.tick();
    expect(closed).toEqual([]); // prompt not taken yet
    clock.now = NOW + 1_000;
    sessions.updateSession('s1', { lastPromptAt: clock.now, activityLevel: 'active' });
    retirer.tick();
    expect(closed).toEqual([]); // saving memories
    sessions.updateSession('s1', { activityLevel: 'inactive' });
    retirer.tick();
    expect(closed).toEqual(['s1']);
  });

  it('retiringAt is never persisted', async () => {
    const { sessions, retirer, close } = setup();
    await close();
    const { serializeSession } = await import('../src/session/session-persistence.js');
    expect(serializeSession(sessions.getSession('s1')!)).not.toHaveProperty('retiringAt');
  });
});
