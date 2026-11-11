import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session/manager.js';
import { StateDetector, type ActivityChange } from '../src/session/state-detector.js';
import type { SessionInfo } from '../src/types/session.js';

const NOW = 1_700_000_000_000;

describe('session freeze activity integration', () => {
  let sessions: SessionManager;
  let detector: StateDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    sessions = new SessionManager();
    vi.spyOn(sessions as any, 'persistSessions').mockImplementation(() => {});
    detector = new StateDetector();

    const syncFreezeState = (session: Pick<SessionInfo, 'id' | 'frozen'>) => {
      detector.setSessionFrozen(session.id, session.frozen === true);
    };
    sessions.on('session:added', syncFreezeState);
    sessions.on('session:updated', syncFreezeState);

    detector.on('activity-change', (event: ActivityChange) => {
      const session = sessions.getSession(event.sessionId);
      if (!session) return;

      const updates: Partial<SessionInfo> = { activityLevel: event.level };
      if (event.lastOutputAt !== undefined && event.lastOutputAt > 0) {
        updates.lastOutputAt = event.lastOutputAt;
        if (event.level !== 'active') updates.lastActiveAt = event.lastOutputAt;
      }
      sessions.updateSession(event.sessionId, updates);
    });
  });

  afterEach(() => {
    detector.dispose();
    vi.useRealTimers();
  });

  it('syncs restored and changed freezes, preserves lastActiveAt, and resumes after thaw', () => {
    const lastActiveAt = NOW - 1_000;
    sessions.addSession({
      id: 's1',
      name: 'worker',
      cliType: 'test',
      processId: 1,
      frozen: true,
      activityLevel: 'inactive',
      lastActiveAt,
    }, true);

    // A restored frozen session is idled through the activity event without
    // changing its persisted last-active timestamp.
    expect(sessions.getSession('s1')?.activityLevel).toBe('idle');
    expect(sessions.getSession('s1')?.lastActiveAt).toBe(lastActiveAt);

    // Frozen sessions also ignore lifecycle hooks.
    detector.markHookActivity('s1', 'hook PreToolUse');
    detector.markHookTurnEnded('s1', 'hook Stop');
    expect(detector.getLastOutputTime('s1')).toBe(0);
    expect(sessions.getSession('s1')?.lastActiveAt).toBe(lastActiveAt);

    // A real thaw event allows activity to resume.
    sessions.setSessionFrozen('s1', false, NOW);
    detector.markHookActivity('s1', 'hook PreToolUse');
    expect(sessions.getSession('s1')?.activityLevel).toBe('active');

    // A changed freeze event idles the row without stamping a synthetic output time.
    sessions.setSessionFrozen('s1', true, NOW + 1_000);
    expect(sessions.getSession('s1')?.activityLevel).toBe('idle');
    expect(sessions.getSession('s1')?.lastActiveAt).toBe(lastActiveAt);
    const lastOutputAt = detector.getLastOutputTime('s1');

    detector.markHookTurnEnded('s1', 'hook Stop');
    expect(detector.getLastOutputTime('s1')).toBe(lastOutputAt);
    expect(sessions.getSession('s1')?.lastActiveAt).toBe(lastActiveAt);
  });

  it('freezes activity in one session:updated event and preserves lastActiveAt', () => {
    const lastActiveAt = NOW - 2_000;
    sessions.addSession({
      id: 's1',
      name: 'worker',
      cliType: 'test',
      processId: 1,
      activityLevel: 'active',
      lastActiveAt,
    }, true);

    const updated = vi.fn();
    sessions.on('session:updated', updated);
    const frozen = sessions.setSessionFrozen('s1', true, NOW + 1_000);

    expect(updated).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({
      id: 's1',
      frozen: true,
      activityLevel: 'idle',
    }));
    expect(frozen.lastActiveAt).toBe(lastActiveAt);
  });

  it('restores frozen inactive records as idle without activity listeners', () => {
    const restored = new SessionManager();
    const lastActiveAt = NOW - 3_000;
    const added = vi.fn();
    restored.on('session:added', added);

    restored.addSession({
      id: 'restored',
      name: 'worker',
      cliType: 'test',
      processId: 1,
      frozen: true,
      activityLevel: 'inactive',
      lastActiveAt,
    }, true);

    expect(restored.getSession('restored')).toMatchObject({
      frozen: true,
      activityLevel: 'idle',
      lastActiveAt,
    });
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ activityLevel: 'idle' }));
  });
});
