/** AutoFreezer: a session past its CLI's long cache freezes itself. */

import { describe, expect, it, vi } from 'vitest';
import { AutoFreezer } from '../src/session/auto-freezer.js';
import { SessionManager } from '../src/session/manager.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIN = 60_000;
const NOW = 10_000 * MIN;

function setup(patch: Record<string, unknown> = {}) {
  const sessions = new SessionManager();
  sessions.addSession({ id: 's1', name: 'worker', cliType: 'test', processId: 1, workingDir: 'C:/w', ...patch });
  const freezer = new AutoFreezer(sessions, () => ({ cacheExpireMinutes: 60 }), { now: () => NOW });
  return { sessions, freezer };
}

describe('AutoFreezer', () => {
  it('freezes a session whose last prompt is past the long cache', () => {
    const { sessions, freezer } = setup({ lastPromptAt: NOW - 61 * MIN });
    freezer.tick();
    expect(sessions.getSession('s1')?.frozen).toBe(true);
  });

  it('leaves a session inside the window, a never-prompted one, and the operator alone', () => {
    for (const patch of [{ lastPromptAt: NOW - 59 * MIN }, {}, { lastPromptAt: NOW - 61 * MIN, role: 'operator' }]) {
      const { sessions, freezer } = setup(patch);
      freezer.tick();
      expect(sessions.getSession('s1')?.frozen).toBeFalsy();
    }
  });

  it('thawing restarts the clock so the session does not refreeze on the next tick', () => {
    const { sessions, freezer } = setup({ lastPromptAt: NOW - 61 * MIN });
    freezer.tick();
    sessions.setSessionFrozen('s1', false, NOW);
    freezer.tick();
    expect(sessions.getSession('s1')?.frozen).toBe(false);
  });
});
