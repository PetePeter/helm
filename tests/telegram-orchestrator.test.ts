/**
 * Tests for Telegram orchestrator bidirectional session sync (P-0337).
 *
 * Gap 2: forum_topic_closed → session removed + PTY killed
 * Gap 3: forum_topic_edited → sessionManager.renameSession called with stripped name
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/telegram/pinned-dashboard.js', () => ({
  PinnedDashboard: vi.fn(function (this: any) {
    this.dispose = vi.fn();
  }),
}));

vi.mock('../src/telegram/relay-service.js', () => ({
  TelegramRelayService: vi.fn(function (this: any) {
    this.handleReaction = vi.fn();
  }),
}));

vi.mock('../src/telegram/callback-handler.js', () => ({
  setupCallbackHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../src/telegram/topic-input.js', () => ({
  setupTopicInput: vi.fn(() => vi.fn()),
}));

vi.mock('../src/telegram/command-handler.js', () => ({
  setupCommandHandler: vi.fn(() => vi.fn()),
}));

import { initTelegramModules } from '../src/telegram/orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBot() {
  const listeners: Record<string, Function[]> = {};
  return {
    on: vi.fn((event: string, fn: Function) => {
      (listeners[event] ??= []).push(fn);
    }),
    removeListener: vi.fn(),
    emit: (event: string, ...args: unknown[]) => {
      listeners[event]?.forEach(fn => fn(...args));
    },
    _listeners: listeners,
  };
}

function makeTopicManager(session: any = null) {
  return {
    findSessionByTopicId: vi.fn((_id: number) => session),
    handleTopicClosed: vi.fn(),
    closeSessionTopic: vi.fn().mockResolvedValue(undefined),
    renameSessionTopic: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSessionManager() {
  return {
    removeSession: vi.fn(),
    renameSession: vi.fn(),
  };
}

function makePtyManager() {
  return { kill: vi.fn() };
}

function makeConfigLoader(instanceName = 'Home') {
  return {
    getTelegramConfig: vi.fn(() => ({ instanceName })),
  };
}

function makeHelmControlService() {
  return {};
}

// ---------------------------------------------------------------------------
// Gap 2: forum_topic_closed → close session + kill PTY
// ---------------------------------------------------------------------------

describe('forum_topic_closed → close Helm session', () => {
  it('kills PTY and removes session when a known topic is closed', () => {
    const session = { id: 'sess-1', name: 'Claude', topicId: 42 };
    const bot = makeBot() as any;
    const topicManager = makeTopicManager(session);
    const sessionManager = makeSessionManager();
    const ptyManager = makePtyManager();

    initTelegramModules(
      bot, topicManager as any, {} as any, sessionManager as any,
      ptyManager as any, makeConfigLoader() as any, makeHelmControlService() as any,
    );

    bot.emit('message', { forum_topic_closed: {}, message_thread_id: 42 });

    expect(topicManager.closeSessionTopic).toHaveBeenCalledWith(session);
    expect(topicManager.handleTopicClosed).toHaveBeenCalledWith(42);
    expect(ptyManager.kill).toHaveBeenCalledWith('sess-1');
    expect(sessionManager.removeSession).toHaveBeenCalledWith('sess-1');
  });

  it('does not crash when topic ID is unknown', () => {
    const bot = makeBot() as any;
    const topicManager = makeTopicManager(null); // no session found
    const sessionManager = makeSessionManager();
    const ptyManager = makePtyManager();

    initTelegramModules(
      bot, topicManager as any, {} as any, sessionManager as any,
      ptyManager as any, makeConfigLoader() as any, makeHelmControlService() as any,
    );

    expect(() => {
      bot.emit('message', { forum_topic_closed: {}, message_thread_id: 999 });
    }).not.toThrow();

    expect(ptyManager.kill).not.toHaveBeenCalled();
    expect(sessionManager.removeSession).not.toHaveBeenCalled();
  });

  it('ignores messages without forum_topic_closed', () => {
    const session = { id: 'sess-1', topicId: 42 };
    const bot = makeBot() as any;
    const topicManager = makeTopicManager(session);
    const sessionManager = makeSessionManager();
    const ptyManager = makePtyManager();

    initTelegramModules(
      bot, topicManager as any, {} as any, sessionManager as any,
      ptyManager as any, makeConfigLoader() as any, makeHelmControlService() as any,
    );

    bot.emit('message', { text: 'hello', message_thread_id: 42 });

    expect(sessionManager.removeSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gap 3: forum_topic_edited → rename Helm session
// ---------------------------------------------------------------------------

describe('forum_topic_edited → rename Helm session', () => {
  it('renames session stripping [instanceName] prefix', () => {
    const session = { id: 'sess-1', name: 'Claude', topicId: 42 };
    const bot = makeBot() as any;
    const topicManager = makeTopicManager(session);
    const sessionManager = makeSessionManager();

    initTelegramModules(
      bot, topicManager as any, {} as any, sessionManager as any,
      makePtyManager() as any, makeConfigLoader('Home') as any, makeHelmControlService() as any,
    );

    bot.emit('message', {
      forum_topic_edited: { name: '[Home] NewName' },
      message_thread_id: 42,
    });

    expect(sessionManager.renameSession).toHaveBeenCalledWith('sess-1', 'NewName');
  });

  it('renames session keeping name as-is when no prefix present', () => {
    const session = { id: 'sess-1', name: 'Claude', topicId: 42 };
    const bot = makeBot() as any;
    const topicManager = makeTopicManager(session);
    const sessionManager = makeSessionManager();

    initTelegramModules(
      bot, topicManager as any, {} as any, sessionManager as any,
      makePtyManager() as any, makeConfigLoader('Home') as any, makeHelmControlService() as any,
    );

    bot.emit('message', {
      forum_topic_edited: { name: 'RawName' },
      message_thread_id: 42,
    });

    expect(sessionManager.renameSession).toHaveBeenCalledWith('sess-1', 'RawName');
  });

  it('ignores forum_topic_edited when name is absent (icon-only edit)', () => {
    const session = { id: 'sess-1', topicId: 42 };
    const bot = makeBot() as any;
    const topicManager = makeTopicManager(session);
    const sessionManager = makeSessionManager();

    initTelegramModules(
      bot, topicManager as any, {} as any, sessionManager as any,
      makePtyManager() as any, makeConfigLoader() as any, makeHelmControlService() as any,
    );

    bot.emit('message', {
      forum_topic_edited: {},  // no name property
      message_thread_id: 42,
    });

    expect(sessionManager.renameSession).not.toHaveBeenCalled();
  });

  it('ignores forum_topic_edited for unknown topic IDs', () => {
    const bot = makeBot() as any;
    const topicManager = makeTopicManager(null);
    const sessionManager = makeSessionManager();

    initTelegramModules(
      bot, topicManager as any, {} as any, sessionManager as any,
      makePtyManager() as any, makeConfigLoader() as any, makeHelmControlService() as any,
    );

    bot.emit('message', {
      forum_topic_edited: { name: '[Home] Foo' },
      message_thread_id: 999,
    });

    expect(sessionManager.renameSession).not.toHaveBeenCalled();
  });
});
