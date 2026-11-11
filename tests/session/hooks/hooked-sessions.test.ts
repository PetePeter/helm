/**
 * A session is "hooked" when its CLI type's hooks are installed: from then on
 * hook events alone drive its dot and cache timer. Resolved at spawn (and on a
 * CLI switch) against a real SessionManager and StateDetector.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../../src/session/manager.js';
import { StateDetector } from '../../../src/session/state-detector.js';
import { trackHookedSessions } from '../../../src/session/hooks/hooked-sessions.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('trackHookedSessions', () => {
  const detector = new StateDetector();
  afterEach(() => detector.dispose());

  function setup(installed: Set<string>) {
    const sessions = new SessionManager();
    trackHookedSessions(sessions, detector, async cliType => installed.has(cliType));
    return sessions;
  }

  it('marks a session hooked when its CLI type has hooks installed', async () => {
    const sessions = setup(new Set(['claude']));
    sessions.addSession({ id: 'a', name: 'a', cliType: 'claude', processId: 1 });
    sessions.addSession({ id: 'b', name: 'b', cliType: 'plain', processId: 2 });
    await flush();

    expect(sessions.getSession('a')?.hooked).toBe(true);
    expect(detector.isHooked('a')).toBe(true);
    expect(sessions.getSession('b')?.hooked).toBeUndefined();
    expect(detector.isHooked('b')).toBe(false);
  });

  it('resolves sessions that already existed (restored before wiring)', async () => {
    const sessions = new SessionManager();
    sessions.addSession({ id: 'a', name: 'a', cliType: 'claude', processId: 1 });
    trackHookedSessions(sessions, detector, async () => true);
    await flush();

    expect(sessions.getSession('a')?.hooked).toBe(true);
  });

  it('re-resolves on a CLI switch, and a hookless new type turns it off', async () => {
    const sessions = setup(new Set(['claude']));
    sessions.addSession({ id: 'a', name: 'a', cliType: 'claude', processId: 1 });
    await flush();

    sessions.updateSession('a', { keepWarmUntil: Date.now() + 60_000 });
    sessions.updateSession('a', { cliType: 'plain' });
    await flush();

    expect(sessions.getSession('a')?.hooked).toBe(false);
    // Keep-warm needs hooks: left on, it would only exempt the session from freezing.
    expect(sessions.getSession('a')?.keepWarmUntil).toBeUndefined();
    expect(detector.isHooked('a')).toBe(false);
  });

  it('never downgrades a session a hook event already proved hooked', async () => {
    const sessions = setup(new Set());
    sessions.addSession({ id: 'a', name: 'a', cliType: 'project-hooks', processId: 1 });
    detector.markHookActivity('a', 'hook SessionStart');
    sessions.updateSession('a', { hooked: true });
    await flush();

    expect(sessions.getSession('a')?.hooked).toBe(true);
    expect(detector.isHooked('a')).toBe(true);
  });
});
