/**
 * TopicManager unit tests
 *
 * Tests: ensureTopic, ensureAllTopics, close/rename, lookup,
 * topic naming with instance prefix, persistence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TopicManager } from '../src/telegram/topic-manager.js';
import type { SessionInfo } from '../src/types/session.js';

// ---------------------------------------------------------------------------
// Mock persistence — prevent real disk writes
// ---------------------------------------------------------------------------

vi.mock('../src/session/persistence.js', () => ({
  saveSessions: vi.fn(),
}));

import { saveSessions } from '../src/session/persistence.js';

// ---------------------------------------------------------------------------
// Helpers: mock bot + mock session manager
// ---------------------------------------------------------------------------

function makeMockBot() {
  return {
    createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 100, name: 'topic' }),
    closeForumTopic: vi.fn().mockResolvedValue(true),
    deleteForumTopic: vi.fn().mockResolvedValue(true),
    reopenForumTopic: vi.fn().mockResolvedValue(true),
    editForumTopic: vi.fn().mockResolvedValue(true),
    sendToTopic: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    isRunning: vi.fn().mockReturnValue(true),
  };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-1',
    name: 'my-session',
    cliType: 'claude-code',
    processId: 1234,
    workingDir: '/projects/app',
    ...overrides,
  };
}

function makeMockSessionManager(sessions: SessionInfo[]) {
  const sessionMap = new Map(sessions.map(s => [s.id, s]));
  return {
    getAllSessions: vi.fn(() => [...sessionMap.values()]),
    getSession: vi.fn((id: string) => sessionMap.get(id) ?? null),
  };
}

function makeMockTopicRegistry(records: any[] = []) {
  return {
    list: vi.fn(() => records),
    upsert: vi.fn((record: any) => {
      const existing = records.findIndex(item => item.topicId === record.topicId);
      const next = { ...record, createdAt: Date.now(), updatedAt: Date.now() };
      if (existing >= 0) records[existing] = next;
      else records.push(next);
    }),
    remove: vi.fn((topicId: number) => {
      const index = records.findIndex(item => item.topicId === topicId);
      if (index >= 0) records.splice(index, 1);
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TopicManager', () => {
  let bot: ReturnType<typeof makeMockBot>;
  let session: SessionInfo;
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  let topicRegistry: ReturnType<typeof makeMockTopicRegistry>;
  let tm: TopicManager;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = makeMockBot();
    session = makeSession();
    sessionManager = makeMockSessionManager([session]);
    topicRegistry = makeMockTopicRegistry();
    tm = new TopicManager(bot as any, sessionManager as any, 'Home', topicRegistry as any);
  });

  // =========================================================================
  // ensureTopic
  // =========================================================================

  describe('ensureTopic', () => {
    it('creates a new topic when session has no topicId', async () => {
      const topicId = await tm.ensureTopic(session);

      expect(topicId).toBe(100);
      expect(bot.createForumTopic).toHaveBeenCalledWith('[Home] my-session (app)');
      // Should send initial info message to the new topic
      expect(bot.sendToTopic).toHaveBeenCalledWith(
        100,
        expect.stringContaining('my-session'),
      );
    });

    it('probes existing topicId and reuses if alive', async () => {
      session.topicId = 42;
      // sendToTopic returns non-null → topic alive
      bot.sendToTopic.mockResolvedValue({ message_id: 2 });

      const topicId = await tm.ensureTopic(session);

      expect(topicId).toBe(42);
      // Should probe by sending a "reconnected" message
      expect(bot.sendToTopic).toHaveBeenCalledWith(42, '🔄 Hub reconnected.');
      // Should NOT create a new topic
      expect(bot.createForumTopic).not.toHaveBeenCalled();
    });

    it('creates new topic when probe fails (dead topic)', async () => {
      session.topicId = 42;
      // First sendToTopic (probe) returns null → dead
      bot.sendToTopic.mockResolvedValueOnce(null);
      // Second sendToTopic (initial info message after creation) → success
      bot.sendToTopic.mockResolvedValueOnce({ message_id: 1 });

      const topicId = await tm.ensureTopic(session);

      expect(topicId).toBe(100);
      expect(bot.createForumTopic).toHaveBeenCalledWith('[Home] my-session (app)');
    });

    it('stores topicId on session and calls saveSessions', async () => {
      await tm.ensureTopic(session);

      expect(session.topicId).toBe(100);
      expect(saveSessions).toHaveBeenCalled();
      expect(topicRegistry.upsert).toHaveBeenCalledWith({
        topicId: 100,
        sessionId: 'sess-1',
        sessionName: 'my-session',
      });
    });

    it('returns null when topic creation fails', async () => {
      bot.createForumTopic.mockResolvedValue(null);

      const topicId = await tm.ensureTopic(session);

      expect(topicId).toBeNull();
    });
  });

  // =========================================================================
  // ensureAllTopics
  // =========================================================================

  describe('ensureAllTopics', () => {
    it('creates topics for all sessions', async () => {
      const s1 = makeSession({ id: 'a', name: 'alpha' });
      const s2 = makeSession({ id: 'b', name: 'beta' });
      const mgr = makeMockSessionManager([s1, s2]);
      const topicMgr = new TopicManager(bot as any, mgr as any, 'Work', makeMockTopicRegistry() as any);

      let topicCounter = 200;
      bot.createForumTopic.mockImplementation(async () => ({
        message_thread_id: topicCounter++,
        name: 'topic',
      }));

      await topicMgr.ensureAllTopics();

      expect(bot.createForumTopic).toHaveBeenCalledTimes(2);
      expect(bot.createForumTopic).toHaveBeenCalledWith('[Work] alpha (app)');
      expect(bot.createForumTopic).toHaveBeenCalledWith('[Work] beta (app)');
    });

    it('skips sessions that already have valid topics', async () => {
      session.topicId = 42;
      bot.sendToTopic.mockResolvedValue({ message_id: 1 }); // probe alive

      await tm.ensureAllTopics();

      expect(bot.createForumTopic).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // closeSessionTopic
  // =========================================================================

  describe('closeSessionTopic', () => {
    it('deletes the forum topic permanently', async () => {
      session.topicId = 42;

      await tm.closeSessionTopic(session);

      expect(bot.deleteForumTopic).toHaveBeenCalledWith(42);
      expect(topicRegistry.remove).toHaveBeenCalledWith(42);
    });

    it('no-ops when session has no topicId', async () => {
      await tm.closeSessionTopic(session);
      expect(bot.deleteForumTopic).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // deleteTopic
  // =========================================================================

  describe('deleteTopic', () => {
    it('calls bot.deleteForumTopic() and clears session topicId', async () => {
      session.topicId = 42;

      await tm.deleteTopic('sess-1');

      expect(bot.deleteForumTopic).toHaveBeenCalledWith(42);
      expect(session.topicId).toBeUndefined();
      expect(topicRegistry.remove).toHaveBeenCalledWith(42);
    });

    it('no-ops when session has no topicId', async () => {
      await tm.deleteTopic('sess-1');
      expect(bot.deleteForumTopic).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleTopicClosed
  // =========================================================================

  describe('handleTopicClosed', () => {
    it('clears topicId without removing session', () => {
      session.topicId = 42;

      tm.handleTopicClosed(42);

      expect(session.topicId).toBeUndefined();
      expect(topicRegistry.remove).toHaveBeenCalledWith(42);
      expect(sessionManager.getSession).toHaveBeenCalledWith('sess-1'); // session still exists
    });

    it('no-ops when topicId does not match any session', () => {
      session.topicId = 42;

      tm.handleTopicClosed(999);

      expect(session.topicId).toBe(42); // unchanged
    });
  });

  // =========================================================================
  // renameSessionTopic
  // =========================================================================

  describe('renameSessionTopic', () => {
    it('calls editForumTopic with formatted name', async () => {
      session.topicId = 42;
      session.name = 'renamed';

      await tm.renameSessionTopic(session);

      expect(bot.editForumTopic).toHaveBeenCalledWith(42, '[Home] renamed (app)');
    });

    it('no-ops when session has no topicId', async () => {
      await tm.renameSessionTopic(session);
      expect(bot.editForumTopic).not.toHaveBeenCalled();
    });

    // Regression: every session:updated retried a failed or timed-out rename,
    // logging thousands of editForumTopic errors a day.
    it('does not retry the same name after a failed edit', async () => {
      session.topicId = 42;
      bot.editForumTopic.mockResolvedValue(false);

      await tm.renameSessionTopic(session);
      await tm.renameSessionTopic(session);

      expect(bot.editForumTopic).toHaveBeenCalledTimes(1);
    });

    it('tries again once the name actually changes', async () => {
      session.topicId = 42;
      bot.editForumTopic.mockResolvedValue(false);
      await tm.renameSessionTopic(session);

      session.name = 'renamed';
      await tm.renameSessionTopic(session);

      expect(bot.editForumTopic).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Lookups
  // =========================================================================

  describe('findSessionByTopicId', () => {
    it('returns session matching topicId', () => {
      session.topicId = 77;

      const found = tm.findSessionByTopicId(77);

      expect(found).not.toBeNull();
      expect(found!.id).toBe('sess-1');
    });

    it('returns null for unknown topicId', () => {
      session.topicId = 77;
      expect(tm.findSessionByTopicId(999)).toBeNull();
    });

    it('returns null when no sessions have topics', () => {
      expect(tm.findSessionByTopicId(1)).toBeNull();
    });
  });

  describe('getTopicId', () => {
    it('returns topicId for a session', () => {
      session.topicId = 55;
      expect(tm.getTopicId('sess-1')).toBe(55);
    });

    it('returns null for session without topicId', () => {
      expect(tm.getTopicId('sess-1')).toBeNull();
    });

    it('returns null for unknown session', () => {
      expect(tm.getTopicId('unknown')).toBeNull();
    });
  });

  // =========================================================================
  // stale topic cleanup
  // =========================================================================

  describe('stale topic cleanup', () => {
    it('previews Helm-known topic mappings without deleting topics', async () => {
      session.topicId = 42;
      bot.sendToTopic.mockResolvedValue({ message_id: 1 });

      const preview = await tm.previewStaleTopics();

      expect(preview).toMatchObject({
        totalSessions: 1,
        mappedTopics: 1,
        alive: 1,
        dead: 0,
        failed: 0,
      });
      expect(preview.probes[0]).toMatchObject({
        sessionId: 'sess-1',
        topicId: 42,
        status: 'alive',
      });
      expect(bot.deleteForumTopic).not.toHaveBeenCalled();
    });

    it('clears dead topic mappings on confirmed cleanup', async () => {
      session.topicId = 42;
      bot.sendToTopic.mockResolvedValue(null);

      const result = await tm.cleanupStaleTopics();

      expect(result.cleared).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.skipped).toBe(0);
      expect(session.topicId).toBeUndefined();
      expect(saveSessions).toHaveBeenCalled();
      expect(bot.deleteForumTopic).not.toHaveBeenCalled();
    });

    it('skips alive topics for active sessions', async () => {
      session.topicId = 42;
      bot.sendToTopic.mockResolvedValue({ message_id: 1 });

      const result = await tm.cleanupStaleTopics();

      expect(result.skipped).toBe(1);
      expect(result.cleared).toBe(0);
      expect(session.topicId).toBe(42);
    });

    it('reports no-op cleanup when there are no mapped topics', async () => {
      const result = await tm.cleanupStaleTopics();

      expect(result.mappedTopics).toBe(0);
      expect(result.cleared).toBe(0);
      expect(result.deleted).toBe(0);
      expect(bot.sendToTopic).not.toHaveBeenCalled();
    });

    it('deletes orphan topics recorded in the Helm topic registry', async () => {
      const orphanRegistry = makeMockTopicRegistry([{
        topicId: 77,
        sessionId: 'old-session',
        sessionName: 'old',
        createdAt: 1,
        updatedAt: 1,
      }]);
      const topicMgr = new TopicManager(bot as any, sessionManager as any, 'Home', orphanRegistry as any);

      const result = await topicMgr.cleanupStaleTopics();

      expect(result.deleted).toBe(1);
      expect(result.cleared).toBe(0);
      expect(bot.deleteForumTopic).toHaveBeenCalledWith(77);
      expect(orphanRegistry.remove).toHaveBeenCalledWith(77);
    });

    it('keeps orphan registry entries when Telegram deletion fails', async () => {
      const orphanRegistry = makeMockTopicRegistry([{
        topicId: 77,
        sessionId: 'old-session',
        sessionName: 'old',
        createdAt: 1,
        updatedAt: 1,
      }]);
      bot.deleteForumTopic.mockResolvedValue(false);
      const topicMgr = new TopicManager(bot as any, sessionManager as any, 'Home', orphanRegistry as any);

      const result = await topicMgr.cleanupStaleTopics();

      expect(result.deleted).toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(orphanRegistry.remove).not.toHaveBeenCalledWith(77);
    });
  });

  // =========================================================================
  // Topic naming
  // =========================================================================

  describe('topic naming', () => {
    it('formats topic name as [InstanceName] session-name', async () => {
      await tm.ensureTopic(session);

      expect(bot.createForumTopic).toHaveBeenCalledWith('[Home] my-session (app)');
    });

    it('uses updated instance name after setInstanceName', async () => {
      tm.setInstanceName('Office');
      await tm.ensureTopic(session);

      expect(bot.createForumTopic).toHaveBeenCalledWith('[Office] my-session (app)');
    });
  });
});
