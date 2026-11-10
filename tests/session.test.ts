/**
 * Session manager unit tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../src/session/manager.js';
import type { SessionInfo } from '../src/types/session.js';

describe('SessionManager', () => {
  let manager: SessionManager;
  const mockSession1: SessionInfo = {
    id: 'session-1',
    name: 'Claude Code 1',
    cliType: 'claude-code',
    processId: 1001,
  };

  const mockSession2: SessionInfo = {
    id: 'session-2',
    name: 'Copilot CLI 1',
    cliType: 'copilot-cli',
    processId: 1002,
  };

  const mockSession3: SessionInfo = {
    id: 'session-3',
    name: 'Claude Code 2',
    cliType: 'claude-code',
    processId: 1003,
  };

  beforeEach(() => {
    manager = new SessionManager();
  });

  describe('addSession', () => {
    it('adds a new session and sets it as active when first session', () => {
      let addedEvent: any = null;
      manager.on('session:added', (event) => {
        addedEvent = event;
      });

      manager.addSession(mockSession1);

      expect(manager.getSessionCount()).toBe(1);
      expect(manager.getActiveSession()).toEqual(mockSession1);
      expect(addedEvent).toMatchObject({
        id: mockSession1.id,
        name: mockSession1.name,
        cliType: mockSession1.cliType,
      });
      expect(addedEvent.timestamp).toBeDefined();
    });

    it('adds subsequent sessions without changing active session', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);

      expect(manager.getSessionCount()).toBe(2);
      expect(manager.getActiveSession()).toEqual(mockSession1);
    });

    it('throws error when adding duplicate session ID', () => {
      manager.addSession(mockSession1);

      expect(() => manager.addSession(mockSession1)).toThrow(
        `Session with id "${mockSession1.id}" already exists`
      );
    });

    it('emits session:added event with timestamp', () => {
      const timestampSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567890);

      let emittedEvent: any = null;
      manager.on('session:added', (event) => {
        emittedEvent = event;
      });

      manager.addSession(mockSession1);

      expect(emittedEvent.timestamp).toBe(1234567890);
      timestampSpy.mockRestore();
    });
  });

  describe('removeSession', () => {
    it('removes an existing session', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);

      let removedEvent: any = null;
      manager.on('session:removed', (event) => {
        removedEvent = event;
      });

      manager.removeSession(mockSession1.id);

      expect(manager.getSessionCount()).toBe(1);
      expect(manager.getSession(mockSession1.id)).toBeNull();
      expect(removedEvent).toEqual({
        sessionId: mockSession1.id,
        session: expect.objectContaining({ id: mockSession1.id }),
        timestamp: expect.any(Number),
      });
    });

    it('continues notifying later listeners when one removal listener throws', () => {
      manager.addSession(mockSession1);
      const laterListener = vi.fn();
      const failingListener = vi.fn(() => { throw new Error('observer failure'); });
      manager.once('session:removed', failingListener);
      manager.on('session:removed', laterListener);

      expect(() => manager.removeSession(mockSession1.id)).not.toThrow();
      expect(manager.getSession(mockSession1.id)).toBeNull();
      expect(laterListener).toHaveBeenCalledOnce();
      expect(manager.listenerCount('session:removed')).toBe(1);
    });

    it('sets next session as active when removing active session', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);
      manager.addSession(mockSession3);

      manager.removeSession(mockSession1.id);

      expect(manager.getActiveSession()?.id).toBe(mockSession2.id);
    });

    it('sets null as active when removing only session', () => {
      manager.addSession(mockSession1);

      let changedEvent: any = null;
      manager.on('session:changed', (event) => {
        changedEvent = event;
      });

      manager.removeSession(mockSession1.id);

      expect(manager.getActiveSession()).toBeNull();
      expect(changedEvent).toEqual({
        sessionId: null,
        previousSessionId: mockSession1.id,
        timestamp: expect.any(Number),
      });
    });

    it('throws error when removing non-existent session', () => {
      expect(() => manager.removeSession('non-existent')).toThrow(
        'Session with id "non-existent" does not exist'
      );
    });

    it('rejects ordinary removal of a locked session but permits forced cleanup', () => {
      manager.addSession({ ...mockSession1, locked: true });

      expect(() => manager.removeSession(mockSession1.id)).toThrow('is locked and cannot be closed');
      expect(manager.getSession(mockSession1.id)).not.toBeNull();

      manager.removeSession(mockSession1.id, { force: true });
      expect(manager.getSession(mockSession1.id)).toBeNull();
    });
  });

  describe('nextSession', () => {
    it('cycles to next session in order', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);
      manager.addSession(mockSession3);

      let changedEvent: any = null;
      manager.on('session:changed', (event) => {
        changedEvent = event;
      });

      manager.nextSession();

      expect(manager.getActiveSession()?.id).toBe(mockSession2.id);
      expect(changedEvent).toMatchObject({
        sessionId: mockSession2.id,
        previousSessionId: mockSession1.id,
      });
    });

    it('wraps around to first session when at end', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);
      manager.setActiveSession(mockSession2.id);

      manager.nextSession();

      expect(manager.getActiveSession()?.id).toBe(mockSession1.id);
    });

    it('does nothing when no sessions exist', () => {
      manager.nextSession();
      expect(manager.getActiveSession()).toBeNull();
    });

    it('activates first session when none active but sessions exist', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);

      // Manually clear active session (simulating edge case)
      (manager as any).activeSessionId = null;

      manager.nextSession();

      expect(manager.getActiveSession()?.id).toBe(mockSession1.id);
    });
  });

  describe('previousSession', () => {
    it('cycles to previous session in order', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);
      manager.addSession(mockSession3);
      manager.setActiveSession(mockSession2.id);

      manager.previousSession();

      expect(manager.getActiveSession()?.id).toBe(mockSession1.id);
    });

    it('wraps around to last session when at start', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);
      manager.addSession(mockSession3);

      manager.previousSession();

      expect(manager.getActiveSession()?.id).toBe(mockSession3.id);
    });

    it('does nothing when no sessions exist', () => {
      manager.previousSession();
      expect(manager.getActiveSession()).toBeNull();
    });
  });

  describe('getActiveSession', () => {
    it('returns null when no sessions', () => {
      expect(manager.getActiveSession()).toBeNull();
    });

    it('returns the active session', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);
      manager.setActiveSession(mockSession2.id);

      expect(manager.getActiveSession()).toEqual(mockSession2);
    });
  });

  describe('setActiveSession', () => {
    it('sets a session as active', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);

      let changedEvent: any = null;
      manager.on('session:changed', (event) => {
        changedEvent = event;
      });

      manager.setActiveSession(mockSession2.id);

      expect(manager.getActiveSession()?.id).toBe(mockSession2.id);
      expect(changedEvent).toMatchObject({
        sessionId: mockSession2.id,
        previousSessionId: mockSession1.id,
      });
    });

    it('does not emit event when setting same session as active', () => {
      manager.addSession(mockSession1);

      const emitSpy = vi.spyOn(manager, 'emit');

      manager.setActiveSession(mockSession1.id);

      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('throws error when setting non-existent session as active', () => {
      expect(() => manager.setActiveSession('non-existent')).toThrow(
        'Session with id "non-existent" does not exist'
      );
    });
  });

  describe('getSession', () => {
    it('returns session by ID', () => {
      manager.addSession(mockSession1);

      expect(manager.getSession(mockSession1.id)).toEqual(mockSession1);
    });

    it('returns null for non-existent session', () => {
      expect(manager.getSession('non-existent')).toBeNull();
    });
  });

  describe('getAllSessions', () => {
    it('returns empty array when no sessions', () => {
      expect(manager.getAllSessions()).toEqual([]);
    });

    it('returns all sessions in order', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);
      manager.addSession(mockSession3);

      const sessions = manager.getAllSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions[0]).toEqual(mockSession1);
      expect(sessions[1]).toEqual(mockSession2);
      expect(sessions[2]).toEqual(mockSession3);
    });
  });

  describe('getSessionCount', () => {
    it('returns zero when no sessions', () => {
      expect(manager.getSessionCount()).toBe(0);
    });

    it('returns number of sessions', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);

      expect(manager.getSessionCount()).toBe(2);
    });
  });

  describe('hasSession', () => {
    it('returns true for existing session', () => {
      manager.addSession(mockSession1);
      expect(manager.hasSession(mockSession1.id)).toBe(true);
    });

    it('returns false for non-existent session', () => {
      expect(manager.hasSession('non-existent')).toBe(false);
    });
  });

  describe('renameSession', () => {
    beforeEach(() => {
      manager.addSession(mockSession1);
    });

    it('renames an existing session', () => {
      const result = manager.renameSession(mockSession1.id, 'New Name');

      expect(result.name).toBe('New Name');
      expect(manager.getSession(mockSession1.id)?.name).toBe('New Name');
    });

    it('trims whitespace from new name', () => {
      const result = manager.renameSession(mockSession1.id, '  Spaced Name  ');

      expect(result.name).toBe('Spaced Name');
    });

    it('emits session:changed event when renamed', () => {
      let changedEvent: any = null;
      manager.on('session:changed', (event) => {
        changedEvent = event;
      });

      manager.renameSession(mockSession1.id, 'Renamed');

      expect(changedEvent).toMatchObject({
        sessionId: mockSession1.id,
      });
      expect(changedEvent.timestamp).toBeDefined();
    });

    it('throws error for non-existent session', () => {
      expect(() => manager.renameSession('non-existent', 'Name'))
        .toThrow('Session with id "non-existent" does not exist');
    });

    it('throws error for empty name', () => {
      expect(() => manager.renameSession(mockSession1.id, '   '))
        .toThrow('Session name cannot be empty');
    });

    it('throws error for name exceeding 50 characters', () => {
      const longName = 'a'.repeat(51);
      expect(() => manager.renameSession(mockSession1.id, longName))
        .toThrow('Session name cannot exceed 50 characters');
    });

    it('returns same session if name unchanged', () => {
      const result = manager.renameSession(mockSession1.id, mockSession1.name);

      expect(result).toEqual(mockSession1);
    });

    it('persists sessions after rename', () => {
      const persistSpy = vi.spyOn(manager as any, 'persistSessions');

      manager.renameSession(mockSession1.id, 'Persisted Name');

      expect(persistSpy).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('removes all sessions and clears active session', () => {
      manager.addSession(mockSession1);
      manager.addSession(mockSession2);

      let changedEvent: any = null;
      manager.on('session:changed', (event) => {
        changedEvent = event;
      });

      manager.clear();

      expect(manager.getSessionCount()).toBe(0);
      expect(manager.getActiveSession()).toBeNull();
      // The active session before clear is the first one added
      expect(changedEvent).toEqual({
        sessionId: null,
        previousSessionId: mockSession1.id,
        timestamp: expect.any(Number),
      });
    });

    it('does not emit event when no active session', () => {
      manager.addSession(mockSession1);
      (manager as any).activeSessionId = null;

      const emitSpy = vi.spyOn(manager, 'emit');

      manager.clear();

      expect(emitSpy).not.toHaveBeenCalledWith('session:changed', expect.anything());
    });
  });

  describe('updateSession', () => {
    it('emits session:updated when metadata changes', () => {
      manager.addSession(mockSession1);
      const handler = vi.fn();
      manager.on('session:updated', handler);

      manager.updateSession(mockSession1.id, { aiagentState: 'implementing' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        id: mockSession1.id,
        aiagentState: 'implementing',
        timestamp: expect.any(Number),
      }));
    });
  });
});
