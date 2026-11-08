/**
 * Tests for session restore wiring in registerIPCHandlers.
 * Verifies restoreSessions() is called at startup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need to mock the SessionManager class to verify method calls
const mockRestoreSessions = vi.fn().mockReturnValue([]);
const testConfigRoot = mkdtempSync(join(tmpdir(), 'helm-handlers-restore-'));

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
    this.setWriteGate = vi.fn();
  }),
}));

vi.mock('../src/session/state-detector.js', () => ({
  StateDetector: vi.fn(function (this: any) {
    this.on = vi.fn();
    this.setSessionFrozen = vi.fn();
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
    this.setActiveSessionIdGetter = vi.fn();
    this.setMobileNotifier = vi.fn();
  }),
}));

const mockConfigLoader = {
    load: vi.fn(),
    getUserProfileId: vi.fn().mockReturnValue('1'),
    getProfileConfigDir: vi.fn().mockReturnValue(join(testConfigRoot, 'profile-1')),
    getGlobalConfigDir: vi.fn().mockReturnValue(join(testConfigRoot, 'global')),
    getCliTypes: vi.fn().mockReturnValue([]),
    getCliTypeEntry: vi.fn(),
    getBindings: vi.fn(),
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
    getMobileLanConfig: vi.fn().mockReturnValue({
      enabled: false,
      port: 47475,
    }),
    getPatterns: vi.fn().mockReturnValue([]),
    addBookmarkedDir: vi.fn(),
    setProjectStore: vi.fn(),
    // G5 suggester weights: the fixture hands back the defaults.
    getSuggestionScoring: vi.fn().mockReturnValue({
      adjacencyPerAnchor: 1.0,
      adjacencyMax: 2.0,
      scope: 0.75,
      recencyMax: 0.75,
      recencyWindowDays: 30,
      usagePerCooccurrence: 1.0,
      usageMax: 2.0,
    }),
    getHookInjectionOverrides: vi.fn().mockReturnValue({}),
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
vi.mock('../src/session/draft-manager.js', () => ({
  DraftManager: vi.fn(function (this: any) {
    this.on = vi.fn();
    this.pruneOrphans = vi.fn();
    this.clearSession = vi.fn();
  }),
}));

vi.mock('../src/session/plan-manager.js', () => ({
  PlanManager: vi.fn(function (this: any) {
    this.on = vi.fn();
    this.claimedPlanFor = vi.fn().mockReturnValue(null);
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
    this.setApiContextSizeLookup = vi.fn();
    this.sessionChangeFeed = { attach: vi.fn(), on: vi.fn(), off: vi.fn(), seq: 0 };
    this.setArtifactManager = vi.fn();
    this.setDraftManager = vi.fn();
    this.setTodoManager = vi.fn();
    this.setArtifactUploadService = vi.fn();
    this.setMemoryManager = vi.fn();
    this.setMessManager = vi.fn();
    this.getSuggestedPlanService = vi.fn().mockReturnValue(undefined);
    this.setHandoverDelivery = vi.fn();
    this.setCompactSnapshot = vi.fn();
    this.setReminderDelivery = vi.fn();
    this.setChatBroker = vi.fn();
    this.setMessageFlightSink = vi.fn();
    this.setMobileDeps = vi.fn();
    this.setArtifactAttachmentDeletedHandler = vi.fn();
    this.setPhoneRinger = vi.fn();
    this.setCallTransferrer = vi.fn();
    this.setRingRetry = vi.fn();
    this.setRemoteService = vi.fn();
  }),
}));

vi.mock('../src/mcp/localhost-mcp-server.js', () => ({
  LocalhostMcpServer: vi.fn(function (this: any) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.setLoopDriver = vi.fn();
  }),
}));

vi.mock('../src/electron/window-manager.js', () => ({
  WindowManager: vi.fn(function (this: any) {
    this.on = vi.fn();
    this.getMainWindow = vi.fn().mockReturnValue(null);
    this.getWindow = vi.fn().mockReturnValue(null);
    this.getWindowForSession = vi.fn().mockReturnValue(null);
    this.getAllWindows = vi.fn().mockReturnValue([]);
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
import { ConfigLoader } from '../src/config/loader.js';
import { logger } from '../src/utils/logger.js';
import { SessionManager } from '../src/session/manager.js';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { LocalhostMcpServer } from '../src/mcp/localhost-mcp-server.js';

describe('registerIPCHandlers restore wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls restoreSessions() on startup', () => {
    registerIPCHandlers(undefined, new ConfigLoader() as any);
    expect(mockRestoreSessions).toHaveBeenCalledOnce();
  });

});

describe('registerIPCHandlers ring reminder injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends ordinary ring memories through the registered ContextInjector and omits ideas', async () => {
    registerIPCHandlers(undefined, new ConfigLoader() as any);

    const sessionManager = (SessionManager as any).mock.instances.at(-1);
    sessionManager.hasSession.mockReturnValue(true);
    sessionManager.getSession.mockReturnValue({
      id: 'ring-session',
      role: 'operator',
      projectId: 'ring-project',
      cliType: 'claude',
    });
    const helmControl = (HelmControlService as any).mock.instances.at(-1);
    const memoryManager = helmControl.setMemoryManager.mock.calls.at(-1)[0];
    const ordinary = memoryManager.createForSession('ring-session', {
      tldr: '[RING-ME] Tell the operator the release is ready',
      content: 'Ordinary reminder.',
    });
    const idea = memoryManager.createForSession('ring-session', {
      kind: 'idea',
      tldr: '[RING-ME] Investigate an unexplained release signal',
      content: 'Observation that still needs evidence.',
    });
    const hookReceiver = (LocalhostMcpServer as any).mock.calls.at(-1)[3];

    const response = await hookReceiver.receive(
      { cli: 'claude', event: 'SessionStart', payload: { source: 'startup' } },
      'ring-session',
    );
    const body = JSON.stringify(response.body);

    expect(body).toContain(ordinary.tldr);
    expect(body).not.toContain(idea.tldr);
  });
});
