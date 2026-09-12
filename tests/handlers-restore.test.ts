/**
 * Tests for session restore wiring in registerIPCHandlers.
 * Verifies restoreSessions() is called at startup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to mock the SessionManager class to verify method calls
const mockRestoreSessions = vi.fn().mockReturnValue([]);

vi.mock('../src/session/manager.js', () => ({
  SessionManager: vi.fn(function (this: any) {
    this.restoreSessions = mockRestoreSessions;
    this.on = vi.fn();
    this.getAllSessions = vi.fn().mockReturnValue([]);
    this.getSession = vi.fn();
    this.hasSession = vi.fn();
    this.addSession = vi.fn();
    this.removeSession = vi.fn();
    this.setActiveSession = vi.fn();
  }),
}));

vi.mock('../src/session/pty-manager.js', () => ({
  PtyManager: vi.fn(function (this: any) {
    this.on = vi.fn();
    this.spawn = vi.fn();
    this.write = vi.fn();
    this.deliverText = vi.fn();
    this.kill = vi.fn();
    this.killAll = vi.fn();
    this.resize = vi.fn();
    this.has = vi.fn();
    this.getPid = vi.fn();
    this.getSessionIds = vi.fn(() => []);
    this.setActivityMarker = vi.fn();
  }),
}));

vi.mock('../src/session/state-detector.js', () => ({
  StateDetector: vi.fn(function (this: any) {
    this.on = vi.fn();
    this.dispose = vi.fn();
    this.processOutput = vi.fn();
    this.removeSession = vi.fn();
  }),
}));

vi.mock('../src/session/pipeline-queue.js', () => ({
  PipelineQueue: vi.fn(function (this: any) {
    this.enqueue = vi.fn();
    this.dequeue = vi.fn();
    this.getAll = vi.fn().mockReturnValue([]);
    this.getPosition = vi.fn();
    this.triggerHandoff = vi.fn();
  }),
}));

vi.mock('../src/session/notification-manager.js', () => ({
  NotificationManager: vi.fn(function (this: any) {
    this.dispose = vi.fn();
    this.setScreenLockChecker = vi.fn();
    this.setTelegramNotifier = vi.fn();
    this.setActiveSessionIdGetter = vi.fn();
    this.setMobileNotifier = vi.fn();
  }),
}));

const mockConfigLoader = {
    load: vi.fn(),
    getCliTypes: vi.fn().mockReturnValue([]),
    getCliTypeEntry: vi.fn(),
    getBindings: vi.fn(),
    getTelegramConfig: vi.fn().mockReturnValue({
      enabled: false,
      botToken: '',
      chatId: 0,
      instanceName: 'test',
      allowedUserIds: [],
    }),
    getMcpConfig: vi.fn().mockReturnValue({
      enabled: false,
      port: 5555,
      authToken: '',
    }),
    getFleetConfig: vi.fn().mockReturnValue({
      enabled: false,
      host: '0.0.0.0',
      port: 47474,
    }),
    getPatterns: vi.fn().mockReturnValue([]),
    addBookmarkedDir: vi.fn(),
    setProjectStore: vi.fn(),
};

vi.mock('../src/config/loader.js', () => ({
  ConfigLoader: vi.fn(function (this: any) {
    Object.assign(this, mockConfigLoader);
  }),
}));

vi.mock('../src/output/keyboard.js', () => ({
  keyboard: {},
}));

vi.mock('../src/utils/logger.js', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger, default: logger };
});

// Mock all the setup* functions
vi.mock('../src/electron/ipc/session-handlers.js', () => ({
  setupSessionHandlers: vi.fn().mockReturnValue(vi.fn()),
}));
vi.mock('../src/electron/ipc/config-handlers.js', () => ({
  setupConfigHandlers: vi.fn(),
}));
vi.mock('../src/electron/ipc/profile-handlers.js', () => ({
  setupProfileHandlers: vi.fn(),
}));
vi.mock('../src/electron/ipc/tools-handlers.js', () => ({
  setupToolsHandlers: vi.fn(),
}));
vi.mock('../src/electron/ipc/keyboard-handlers.js', () => ({
  setupKeyboardHandlers: vi.fn(),
}));
vi.mock('../src/electron/ipc/system-handlers.js', () => ({
  setupSystemHandlers: vi.fn(),
  cleanupWorkTempFiles: vi.fn(),
}));
vi.mock('../src/electron/ipc/pty-handlers.js', () => ({
  setupPtyHandlers: vi.fn(),
  cancelAllPrompts: vi.fn(),
}));
vi.mock('../src/electron/ipc/telegram-handlers.js', () => ({
  setupTelegramHandlers: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('../src/telegram/bot.js', () => ({
  TelegramBotCore: vi.fn(function (this: any) {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.isRunning = vi.fn().mockReturnValue(false);
    this.on = vi.fn();
    this.removeListener = vi.fn();
    this.emit = vi.fn();
  }),
}));
vi.mock('../src/telegram/topic-manager.js', () => ({
  TopicManager: vi.fn(function (this: any) {
    this.ensureTopic = vi.fn();
    this.ensureAllTopics = vi.fn().mockResolvedValue(undefined);
    this.setInstanceName = vi.fn();
    this.renameSessionTopic = vi.fn().mockResolvedValue(undefined);
  }),
}));
vi.mock('../src/telegram/notifier.js', () => ({
  TelegramNotifier: vi.fn(function (this: any) {
    this.dispose = vi.fn();
  }),
}));

vi.mock('../src/telegram/orchestrator.js', () => ({
  initTelegramModules: vi.fn().mockReturnValue({
    textInput: {},
    outputSummarizer: {},
    terminalMirror: {},
    dashboard: { start: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() },
    // The relay is a ChatBridge now — handler setup registers it with the broker.
    relayService: { provider: 'telegram', isAvailable: () => false, sendToSession: vi.fn() },
    feedPtyOutput: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

vi.mock('../src/session/draft-manager.js', () => ({
  DraftManager: vi.fn(function (this: any) {
    this.importAll = vi.fn();
    this.on = vi.fn();
  }),
}));

vi.mock('../src/session/plan-manager.js', () => ({
  PlanManager: vi.fn(function (this: any) {
    this.on = vi.fn();
  }),
}));

vi.mock('../src/session/pattern-matcher.js', () => ({
  PatternMatcher: vi.fn(function (this: any) {
    this.processOutput = vi.fn();
  }),
}));

vi.mock('../src/session/incoming-plans-watcher.js', () => ({
  IncomingPlansWatcher: vi.fn(function (this: any) {
    this.on = vi.fn();
  }),
}));

vi.mock('../src/session/persistence.js', () => ({
  loadDrafts: vi.fn().mockReturnValue([]),
  saveDrafts: vi.fn(),
  loadScheduledTasks: vi.fn().mockReturnValue([]),
  loadPlanContexts: vi.fn(() => []),
  savePlanContexts: vi.fn(),
  loadPlanContextBindings: vi.fn(() => []),
  savePlanContextBindings: vi.fn(),
  loadProjectRecords: vi.fn(() => []),
}));

vi.mock('../src/electron/ipc/editor-handlers.js', () => ({
  setupEditorHandlers: vi.fn(),
}));

vi.mock('../src/electron/ipc/draft-handlers.js', () => ({
  setupDraftHandlers: vi.fn(),
}));

vi.mock('../src/electron/ipc/plan-handlers.js', () => ({
  setupPlanHandlers: vi.fn(),
}));

vi.mock('../src/mcp/helm-control-service.js', () => ({
  HelmControlService: vi.fn(function (this: any) {
    this.on = vi.fn();
    this.setNotificationManager = vi.fn();
    this.setRuntimeGroupManager = vi.fn();
    this.setArtifactManager = vi.fn();
    this.setMemoryManager = vi.fn();
    this.setHandoverDelivery = vi.fn();
    this.setChatBroker = vi.fn();
    this.setMobileDeps = vi.fn();
  }),
}));

vi.mock('../src/mcp/localhost-mcp-server.js', () => ({
  LocalhostMcpServer: vi.fn(function (this: any) {
    this.start = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../src/electron/window-manager.js', () => ({
  WindowManager: vi.fn(function (this: any) {
    this.on = vi.fn();
    this.getMainWindow = vi.fn().mockReturnValue(null);
    this.getWindow = vi.fn().mockReturnValue(null);
    this.getWindowIdForSession = vi.fn().mockReturnValue(undefined);
  }),
}));

vi.mock('../renderer/paste-handler.js', () => ({
  setupKeyboardRelay: vi.fn(),
  deliverBulkText: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  powerMonitor: {
    on: vi.fn(),
  },
}));

import { registerIPCHandlers } from '../src/electron/ipc/handlers.js';
import { logger } from '../src/utils/logger.js';
import { TelegramBotCore } from '../src/telegram/bot.js';
import { TopicManager } from '../src/telegram/topic-manager.js';
import { SessionManager } from '../src/session/manager.js';

describe('registerIPCHandlers restore wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls restoreSessions() on startup', () => {
    registerIPCHandlers(() => null);
    expect(mockRestoreSessions).toHaveBeenCalledOnce();
  });

});

// ---------------------------------------------------------------------------
// Gap 1: session:updated → renameSessionTopic (P-0337)
// ---------------------------------------------------------------------------

describe('registerIPCHandlers session:updated → renameSessionTopic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function getSessionUpdatedHandler(): Function | undefined {
    const smInstance = (SessionManager as any).mock.instances[0];
    const call = (smInstance?.on as any)?.mock?.calls?.find(([e]: [string]) => e === 'session:updated');
    return call?.[1];
  }

  it('calls renameSessionTopic when bot is running and session:updated fires', async () => {
    const botInstance = Object.create(null);
    (TelegramBotCore as any).mockImplementationOnce(function (this: any) {
      Object.assign(this, botInstance);
      this.start = vi.fn();
      this.stop = vi.fn();
      this.isRunning = vi.fn().mockReturnValue(true);
      this.on = vi.fn();
      this.removeListener = vi.fn();
      this.emit = vi.fn();
    });

    registerIPCHandlers(() => null);

    const handler = getSessionUpdatedHandler();
    expect(handler).toBeDefined();

    const event = { id: 'sess-1', name: 'renamed', topicId: 42, timestamp: Date.now() };
    handler!(event);

    const tmInstance = (TopicManager as any).mock.instances[0];
    expect(tmInstance.renameSessionTopic).toHaveBeenCalledWith(event);
  });

  it('does not call renameSessionTopic when bot is not running', () => {
    registerIPCHandlers(() => null);

    const handler = getSessionUpdatedHandler();
    expect(handler).toBeDefined();

    const event = { id: 'sess-1', name: 'renamed', topicId: 42, timestamp: Date.now() };
    handler!(event);

    const tmInstance = (TopicManager as any).mock.instances[0];
    expect(tmInstance.renameSessionTopic).not.toHaveBeenCalled();
  });
});
