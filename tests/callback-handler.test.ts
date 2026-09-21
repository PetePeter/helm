import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeProjectPath } from '../src/session/project-identity.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/session/initial-prompt.js', () => ({
  scheduleInitialPrompt: vi.fn(),
}));

const mockDeliverPromptSequenceToSession = vi.fn();
vi.mock('../src/session/sequence-delivery.js', () => ({
  deliverPromptSequenceToSession: (...args: any[]) => mockDeliverPromptSequenceToSession(...args),
}));

// Mock keyboards module — return simple stubs
vi.mock('../src/telegram/keyboards.js', () => ({
  directoryListKeyboard: vi.fn((sessions: any[]) => ({
    text: `📂 ${sessions.length} sessions`,
    keyboard: [[{ text: 'stub', callback_data: 'stub' }]],
  })),
  sessionListKeyboard: vi.fn((_sessions: any[], dir: string) => ({
    text: `📂 ${dir}`,
    keyboard: [[{ text: 'stub', callback_data: 'stub' }]],
  })),
  sessionControlKeyboard: vi.fn((session: any) => ({
    text: `🔨 ${session.name}`,
    keyboard: [[{ text: 'stub', callback_data: 'stub' }]],
  })),
  spawnToolKeyboard: vi.fn(() => [[{ text: 'stub', callback_data: 'stub' }]]),
  spawnDirKeyboard: vi.fn(() => [[{ text: 'stub', callback_data: 'stub' }]]),
  spawnProjectKeyboard: vi.fn(() => [[{ text: 'stub', callback_data: 'stub' }]]),
  // Path registry: in tests, keys are raw paths; resolvePathIndex returns them as-is
  resolvePathIndex: vi.fn((key: string) => key),
}));

import { setupCallbackHandler } from '../src/telegram/callback-handler.js';
import { scheduleInitialPrompt } from '../src/session/initial-prompt.js';
import type { TelegramBotCore } from '../src/telegram/bot.js';
import type { TopicManager } from '../src/telegram/topic-manager.js';
import type { SessionManager } from '../src/session/manager.js';
import type { PtyManager } from '../src/session/pty-manager.js';
import type { ConfigLoader } from '../src/config/loader.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockBot() {
  return {
    on: vi.fn(),
    removeListener: vi.fn(),
    answerCallback: vi.fn(),
    getChatId: vi.fn(() => null),
    getBot: vi.fn(() => ({
      editMessageText: vi.fn(),
      sendMessage: vi.fn(),
    })),
    sendToTopic: vi.fn(),
  } as unknown as TelegramBotCore;
}

function createMockTopicManager() {
  return {
    previewStaleTopics: vi.fn(),
    cleanupStaleTopics: vi.fn(),
  } as unknown as TopicManager;
}

function createMockSessionManager(sessions: Record<string, any> = {}) {
  return {
    getAllSessions: vi.fn(() => Object.values(sessions)),
    getSession: vi.fn((id: string) => sessions[id] ?? null),
    hasSession: vi.fn((id: string) => id in sessions),
    removeSession: vi.fn((id: string) => { delete sessions[id]; }),
    addSession: vi.fn(),
  } as unknown as SessionManager;
}

function createMockPtyManager() {
  return {
    write: vi.fn(),
    kill: vi.fn(),
  } as unknown as PtyManager;
}

function createMockConfigLoader(
  tools: string[] = [],
  sequences: Record<string, Array<{ label: string; sequence: string }>> = {},
  dirs: Array<{ name: string; path: string }> = [],
) {
  // `tools` doubles as the CLI type id list; each gets a Title-ish display name
  // so the wizard's label/id split is exercised.
  const displayName = (id: string) => `${id} (display)`;
  return {
    getCliTypes: vi.fn(() => tools),
    getCliTypeName: vi.fn((id: string) => (tools.includes(id) ? displayName(id) : null)),
    resolveCliType: vi.fn((ref: string) => {
      const id = tools.includes(ref)
        ? ref
        : tools.find((t) => displayName(t).toLowerCase() === ref.toLowerCase());
      return id ? { id, config: { name: displayName(id), displayName: displayName(id) } } : null;
    }),
    getSequences: vi.fn(() => sequences),
    getWorkingDirectories: vi.fn(() => dirs),
    getCliTypeEntry: vi.fn(),
    getSpawnConfig: vi.fn(),
    getMcpConfig: vi.fn(() => ({ enabled: true, port: 47373, authToken: 'helm-token' })),
    reloadActiveProfileIfChanged: vi.fn(),
  } as unknown as ConfigLoader;
}

function makeQuery(data: string, chatId = 123, messageId = 456, threadId = 789) {
  return {
    id: 'q1',
    data,
    from: { id: 1000, is_bot: false, first_name: 'Test' },
    message: {
      chat: { id: chatId },
      message_id: messageId,
      message_thread_id: threadId,
      date: Date.now(),
    },
    chat_instance: 'test',
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setupCallbackHandler', () => {
  let bot: ReturnType<typeof createMockBot>;
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let ptyManager: ReturnType<typeof createMockPtyManager>;
  let configLoader: ReturnType<typeof createMockConfigLoader>;
  let handler: (query: any) => Promise<void>;

  beforeEach(() => {
    bot = createMockBot();
    sessionManager = createMockSessionManager();
    ptyManager = createMockPtyManager();
    configLoader = createMockConfigLoader();

    setupCallbackHandler(
      bot as any,
      createMockTopicManager(),
      sessionManager as any,
      ptyManager as any,
      configLoader as any,
    );

    // Extract the handler that was registered
    handler = (bot.on as any).mock.calls[0][1];
  });

  it('registers a callback_query listener on the bot', () => {
    expect(bot.on).toHaveBeenCalledWith('callback_query', expect.any(Function));
  });

  it('returns a dispose function that removes the listener', () => {
    const dispose = setupCallbackHandler(
      bot as any, createMockTopicManager(), sessionManager as any,
      ptyManager as any, configLoader as any,
    );

    dispose();
    expect(bot.removeListener).toHaveBeenCalledWith('callback_query', expect.any(Function));
  });

  it('ignores queries with no data', async () => {
    await handler({ id: 'q1', from: { id: 1 }, chat_instance: 'x' });
    expect(bot.answerCallback).not.toHaveBeenCalled();
  });

  describe('sessions:list', () => {
    it('edits message with directory list keyboard', async () => {
      const sessions = { s1: { id: 's1', name: 'Test', workingDir: '/a' } };
      sessionManager = createMockSessionManager(sessions);
      setupCallbackHandler(
        bot as any, createMockTopicManager(), sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('sessions:list'));
      expect(sessionManager.getAllSessions).toHaveBeenCalled();
      expect(bot.answerCallback).toHaveBeenCalledWith('q1');
    });
  });

  describe('dir:{path}', () => {
    it('filters sessions by directory and edits message', async () => {
      const sessions = {
        s1: { id: 's1', name: 'A', workingDir: '/proj' },
        s2: { id: 's2', name: 'B', workingDir: '/other' },
      };
      sessionManager = createMockSessionManager(sessions);
      setupCallbackHandler(
        bot as any, createMockTopicManager(), sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('dir:/proj'));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1');
    });
  });

  describe('sess:{sessionId}', () => {
    it('shows session controls for a valid session', async () => {
      const sessions = { s1: { id: 's1', name: 'Test', cliType: 'claude', state: 'idle' } };
      sessionManager = createMockSessionManager(sessions);
      setupCallbackHandler(
        bot as any, createMockTopicManager(), sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('sess:s1'));
      expect(sessionManager.getSession).toHaveBeenCalledWith('s1');
      expect(bot.answerCallback).toHaveBeenCalledWith('q1');
    });

    it('answers with error for unknown session', async () => {
      await handler(makeQuery('sess:unknown'));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '❌ Session not found');
    });
  });

  describe('topic:{sessionId}', () => {
    it('just acknowledges', async () => {
      await handler(makeQuery('topic:s1'));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '📌 Go to topic');
    });
  });

  describe('topic_create:{sessionId}', () => {
    it('creates the topic, refreshes the keyboard, and acknowledges', async () => {
      const ensureTopic = vi.fn(async () => 99);
      const mockTopicManager = { ensureTopic } as unknown as TopicManager;

      const session = { id: 's1', name: 'Test', cliType: 'claude', state: 'idle' };
      const sessions: Record<string, any> = { s1: session };
      sessionManager = createMockSessionManager(sessions);

      const innerBot = { editMessageText: vi.fn(), sendMessage: vi.fn() };
      (bot.getBot as any).mockReturnValue(innerBot);
      (bot as any).getChatId = vi.fn(() => -1003706536310);

      setupCallbackHandler(
        bot as any, mockTopicManager as any, sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('topic_create:s1'));

      expect(ensureTopic).toHaveBeenCalledWith(session);
      expect(innerBot.editMessageText).toHaveBeenCalled();
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '📌 Topic ready — tap Go to Topic');
    });

    it('answers with error when session not found', async () => {
      const mockTopicManager = { ensureTopic: vi.fn() } as unknown as TopicManager;
      setupCallbackHandler(
        bot as any, mockTopicManager as any, sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('topic_create:nonexistent'));

      expect((mockTopicManager as any).ensureTopic).not.toHaveBeenCalled();
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '❌ Session not found');
    });

    it('reports failure when topic creation returns null', async () => {
      const ensureTopic = vi.fn(async () => null);
      const mockTopicManager = { ensureTopic } as unknown as TopicManager;
      const sessions = { s1: { id: 's1', name: 'Test', cliType: 'claude' } };
      sessionManager = createMockSessionManager(sessions);

      setupCallbackHandler(
        bot as any, mockTopicManager as any, sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('topic_create:s1'));

      expect(ensureTopic).toHaveBeenCalled();
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '❌ Failed to create topic');
    });
  });

  describe('topic_cleanup:*', () => {
    it('shows a guarded cleanup preview', async () => {
      const mockTopicManager = {
        previewStaleTopics: vi.fn(async () => ({
          totalSessions: 2,
          mappedTopics: 2,
          alive: 1,
          dead: 1,
          failed: 0,
          probes: [],
        })),
        cleanupStaleTopics: vi.fn(),
      } as unknown as TopicManager;
      const innerBot = { editMessageText: vi.fn(), sendMessage: vi.fn() };
      (bot.getBot as any).mockReturnValue(innerBot);

      setupCallbackHandler(
        bot as any, mockTopicManager as any, sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('topic_cleanup:preview'));

      expect((mockTopicManager as any).previewStaleTopics).toHaveBeenCalled();
      expect(innerBot.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Topic Cleanup Preview'),
        expect.objectContaining({
          reply_markup: expect.objectContaining({
            inline_keyboard: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ callback_data: 'topic_cleanup:confirm' }),
              ]),
            ]),
          }),
        }),
      );
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', 'Preview ready');
    });

    it('runs cleanup only after confirmation', async () => {
      const mockTopicManager = {
        previewStaleTopics: vi.fn(),
        cleanupStaleTopics: vi.fn(async () => ({
          totalSessions: 2,
          mappedTopics: 2,
          alive: 1,
          dead: 1,
          failed: 0,
          probes: [],
          deleted: 0,
          cleared: 1,
          skipped: 1,
          failures: [],
        })),
      } as unknown as TopicManager;
      const innerBot = { editMessageText: vi.fn(), sendMessage: vi.fn() };
      (bot.getBot as any).mockReturnValue(innerBot);

      setupCallbackHandler(
        bot as any, mockTopicManager as any, sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('topic_cleanup:confirm'));

      expect((mockTopicManager as any).cleanupStaleTopics).toHaveBeenCalled();
      expect(innerBot.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Cleared dead mappings: 1'),
        expect.any(Object),
      );
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', 'Cleanup complete');
    });

    it('cancels cleanup without running it', async () => {
      const mockTopicManager = createMockTopicManager();
      const innerBot = { editMessageText: vi.fn(), sendMessage: vi.fn() };
      (bot.getBot as any).mockReturnValue(innerBot);

      setupCallbackHandler(
        bot as any, mockTopicManager as any, sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('topic_cleanup:cancel'));

      expect((mockTopicManager as any).cleanupStaleTopics).not.toHaveBeenCalled();
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', 'Cleanup cancelled');
    });
  });

  describe('talk:{sessionId}', () => {
    it('ensures topic, delivers nudge as a prompt sequence, and answers callback', async () => {
      const mockTopicManager = {
        ensureTopic: vi.fn(async () => 42),
      } as unknown as TopicManager;

      const sessions = { s1: { id: 's1', name: 'Test', cliType: 'claude' } };
      sessionManager = createMockSessionManager(sessions);
      setupCallbackHandler(
        bot as any, mockTopicManager as any, sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('talk:s1'));

      expect(mockTopicManager.ensureTopic).toHaveBeenCalled();
      expect(mockDeliverPromptSequenceToSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 's1',
        text: expect.stringContaining('User is now available'),
        ptyManager,
        sessionManager,
        configLoader,
      }));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', expect.stringContaining('Test'));
    });

    it('answers with error when session not found', async () => {
      await handler(makeQuery('talk:nonexistent'));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', 'Session not found');
    });
  });

  describe('continue:{sessionId}', () => {
    it('writes carriage return to PTY', async () => {
      await handler(makeQuery('continue:s1'));
      expect(ptyManager.write).toHaveBeenCalledWith('s1', '\r');
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '🚀 Sent continue (Enter)');
    });
  });

  describe('cancel:{sessionId}', () => {
    it('writes Ctrl+C to PTY', async () => {
      await handler(makeQuery('cancel:s1'));
      expect(ptyManager.write).toHaveBeenCalledWith('s1', '\x03');
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '✋ Sent cancel (Ctrl+C)');
    });
  });

  describe('accept:{sessionId}', () => {
    it('writes Enter to PTY', async () => {
      await handler(makeQuery('accept:s1'));
      expect(ptyManager.write).toHaveBeenCalledWith('s1', '\r');
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '✅ Sent accept (Enter)');
    });
  });

  describe('removed mirroring callbacks', () => {
    it.each(['prompt:s1', 'send:confirm:s1', 'send:cancel:s1', 'output:s1', 'commands:s1', 'cmd:s1:yes'])(
      'treats %s as unknown',
      async (callbackData) => {
        await handler(makeQuery(callbackData));
        expect(bot.answerCallback).toHaveBeenCalledWith('q1', '❓ Unknown action');
      },
    );
  });

  describe('spawn:start / spawn:tool / spawn:dir', () => {
    it('shows tool selection on spawn:start', async () => {
      configLoader = createMockConfigLoader(['claude', 'codex']);
      setupCallbackHandler(
        bot as any, createMockTopicManager(), sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('spawn:start'));
      expect(configLoader.getCliTypes).toHaveBeenCalled();
      expect(bot.answerCallback).toHaveBeenCalledWith('q1');
    });

    it('shows directory selection on spawn:tool:{name}', async () => {
      configLoader = createMockConfigLoader(['claude'], {}, [{ name: 'proj', path: '/proj' }]);
      const mockProjectStore = { list: vi.fn().mockReturnValue([]) };
      setupCallbackHandler(
        bot as any, createMockTopicManager(), sessionManager as any,
        ptyManager as any, configLoader as any,
        undefined, mockProjectStore as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('spawn:tool:claude'));
      expect(mockProjectStore.list).toHaveBeenCalled();
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', 'Selected: claude (display)');
    });

    it('spawns a session on spawn:dir after tool selection', async () => {
      // Set up mocks for actual spawning
      const mockPtyManager = {
        write: vi.fn(),
        spawn: vi.fn(() => ({ pid: 42 })),
      } as unknown as PtyManager;

      const mockTopicManager = {
        ensureTopic: vi.fn(),
      } as unknown as TopicManager;

      const mockSessionManager = {
        getAllSessions: vi.fn(() => []),
        getSession: vi.fn(() => ({ id: 'test', name: 'claude', cliType: 'claude' })),
        addSession: vi.fn(),
      } as unknown as SessionManager;

      configLoader = createMockConfigLoader(['claude'], {}, [{ name: 'proj', path: '/proj' }]);
      const claudeEntry = {
        name: 'claude (display)',
        displayName: 'claude (display)',
        command: 'claude',
        spawnCommand: 'claude --session-id {cliSessionName}',
        env: [
          { name: 'TEST_LITERAL', value: 'literal-value' },
          { name: 'TEST_REF', value: '%TELEGRAM_SPAWN_TEST_REF%' },
        ],
      };
      (configLoader as any).getCliTypeEntry = vi.fn(() => claudeEntry);
      (configLoader as any).resolveCliType = vi.fn((ref: string) =>
        (ref === 'claude' || ref === 'claude (display)') ? { id: 'claude', config: claudeEntry } : null);
      process.env.TELEGRAM_SPAWN_TEST_REF = 'resolved-value';

      const innerBot = { editMessageText: vi.fn(), sendMessage: vi.fn() };
      (bot.getBot as any).mockReturnValue(innerBot);

      setupCallbackHandler(
        bot as any, mockTopicManager as any, mockSessionManager as any,
        mockPtyManager as any, configLoader as any,
      );
      const spawnHandler = (bot.on as any).mock.calls.at(-1)[1];

      // Step 1: select tool (stores wizard state for user 1000)
      await spawnHandler(makeQuery('spawn:tool:claude'));

      // Step 2: select directory (triggers actual spawn)
      await spawnHandler(makeQuery('spawn:dir:/proj'));

      expect(mockPtyManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: normalizeProjectPath('/proj'),
          env: expect.objectContaining({
            TEST_LITERAL: 'literal-value',
            TEST_REF: 'resolved-value',
            HELM_SESSION_ID: expect.any(String),
            HELM_SESSION_NAME: 'claude (display)',
            HELM_MCP_TOKEN: expect.any(String),
            HELM_MCP_URL: 'http://127.0.0.1:47373/mcp',
          }),
        }),
      );
      expect(mockSessionManager.addSession).toHaveBeenCalledWith(
        expect.objectContaining({ cliType: 'claude', workingDir: normalizeProjectPath('/proj') }),
      );
      expect(scheduleInitialPrompt).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
      // ensureTopic is handled by session:added event in handlers.ts, not by handleSpawnExec
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '🚀 Spawned claude (display)!');
      delete process.env.TELEGRAM_SPAWN_TEST_REF;
    });

    it('reports error when spawn:dir called without prior tool selection', async () => {
      await handler(makeQuery('spawn:dir:/proj'));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '❌ No tool selected or wizard expired. Start over with /spawn');
    });
  });

  describe('status:all', () => {
    it('sends status overview when sessions exist', async () => {
      const sessions = {
        s1: { id: 's1', name: 'A', cliType: 'claude', state: 'implementing' },
        s2: { id: 's2', name: 'B', cliType: 'codex', state: 'idle' },
      };
      sessionManager = createMockSessionManager(sessions);

      // Stable inner bot mock so getBot() always returns the same object
      const innerBot = { editMessageText: vi.fn(), sendMessage: vi.fn() };
      (bot.getBot as any).mockReturnValue(innerBot);

      setupCallbackHandler(
        bot as any, createMockTopicManager(), sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('status:all'));
      expect(innerBot.sendMessage).toHaveBeenCalled();
      const sentText = innerBot.sendMessage.mock.calls[0][1] as string;
      expect(sentText).toContain('Session Status');
      expect(sentText).toContain('A');
      expect(sentText).toContain('B');
    });

    it('answers with "No active sessions" when empty', async () => {
      await handler(makeQuery('status:all'));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', 'No active sessions');
    });
  });

  describe('closeall', () => {
    it('kills PTYs and removes all sessions', async () => {
      const sessions = {
        s1: { id: 's1', name: 'A', cliType: 'claude', topicId: 10 },
        s2: { id: 's2', name: 'B', cliType: 'codex', topicId: 20 },
      };
      sessionManager = createMockSessionManager(sessions);

      setupCallbackHandler(
        bot as any, createMockTopicManager(), sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('closeall'));

      expect(ptyManager.kill).toHaveBeenCalledWith('s1');
      expect(ptyManager.kill).toHaveBeenCalledWith('s2');
      expect(sessionManager.removeSession).toHaveBeenCalledWith('s1');
      expect(sessionManager.removeSession).toHaveBeenCalledWith('s2');
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '🗑️ Closed 2 session(s)');
    });

    it('reports "No sessions to close" when empty', async () => {
      await handler(makeQuery('closeall'));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', 'No sessions to close');
    });

    it('continues closing remaining sessions when one fails', async () => {
      const sessions = {
        s1: { id: 's1', name: 'A', cliType: 'claude' },
        s2: { id: 's2', name: 'B', cliType: 'codex' },
      };
      sessionManager = createMockSessionManager(sessions);
      (ptyManager.kill as any).mockImplementationOnce(() => { throw new Error('boom'); });

      setupCallbackHandler(
        bot as any, createMockTopicManager(), sessionManager as any,
        ptyManager as any, configLoader as any,
      );
      handler = (bot.on as any).mock.calls.at(-1)[1];

      await handler(makeQuery('closeall'));

      // First session fails, second succeeds
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '🗑️ Closed 1 session(s)');
    });
  });

  describe('unknown action', () => {
    it('answers with unknown action', async () => {
      await handler(makeQuery('foobar:xyz'));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '❓ Unknown action');
    });
  });

  describe('error handling', () => {
    it('catches errors and answers with error message', async () => {
      // Make ptyManager.write throw
      (ptyManager.write as any).mockImplementation(() => { throw new Error('boom'); });

      await handler(makeQuery('continue:s1'));
      expect(bot.answerCallback).toHaveBeenCalledWith('q1', '❌ Error processing action');
    });
  });
});
