/**
 * IPC Handler Orchestrator
 *
 * Creates shared dependencies and delegates to domain-specific handler modules.
 * This is the single entry point called from main.ts — individual handler files
 * are never imported directly by the application.
 */

import { BrowserWindow, app, dialog, ipcMain, net, powerMonitor } from 'electron';
import { getMessageFlightTimeoutMs } from '../../session/message-flight.js';
import { SessionManager } from '../../session/manager.js';
import { PtyManager } from '../../session/pty-manager.js';
import { StateDetector } from '../../session/state-detector.js';
import { PipelineQueue } from '../../session/pipeline-queue.js';
import { NotificationManager } from '../../session/notification-manager.js';
import { DraftManager } from '../../session/draft-manager.js';
import { PlanManager } from '../../session/plan-manager.js';
import { ProjectStore } from '../../session/project-store.js';
import { ContextManager } from '../../session/context-manager.js';
import { SkillManager } from '../../session/skill-manager.js';
import { SkillAnalyticsManager } from '../../session/skill-analytics-manager.js';
import { PatternMatcher } from '../../session/pattern-matcher.js';
import { HandoverDelivery } from '../../session/handover-delivery.js';
import { deliverPromptSequenceToSession } from '../../session/sequence-delivery.js';
import { ChatBroker } from '../../session/chat/chat-broker.js';
import { createChatAttachmentRegistrar } from '../../session/chat/chat-attachment-registrar.js';
import { setupHandoverHandlers } from './handover-handlers.js';
import { ScheduledTaskManager } from '../../session/scheduled-task-manager.js';
import { ScheduledTaskHistoryManager } from '../../session/scheduled-task-history-manager.js';
import { RecycleBinManager, recordRemovedSession } from '../../session/recycle-bin-manager.js';
import { RuntimeGroupManager } from '../../session/runtime-group-manager.js';
import { saveRuntimeGroups, loadRuntimeGroups } from '../../session/runtime-group-persistence.js';
import { ArtifactManager } from '../../session/artifact-manager.js';
import { ArtifactAttachmentManager } from '../../session/artifact-attachment-manager.js';
import { saveArtifacts, loadArtifacts } from '../../session/artifact-persistence.js';
import { pruneOrphanArtifacts } from '../../session/artifact-orphan-prune.js';
import { ArtifactTempRegistry, attachSessionTempCleanup } from '../../session/artifact-temp-registry.js';
import { MemoryPersistence } from '../../session/memory-persistence.js';
import { MemoryAttachmentManager } from '../../session/memory-attachment-manager.js';
import { MemoryManager } from '../../session/memory-manager.js';
import { setupPowerMonitor } from '../../session/power-monitor.js';
import { ConfigLoader } from '../../config/loader.js';
import { keyboard } from '../../output/keyboard.js';
import { logger } from '../../utils/logger.js';

import { TelegramBotCore } from '../../telegram/bot.js';
import { TopicManager } from '../../telegram/topic-manager.js';
import { TelegramNotifier } from '../../telegram/notifier.js';
import { initTelegramModules } from '../../telegram/orchestrator.js';

import { setupSessionHandlers } from './session-handlers.js';
import { setupConfigHandlers } from './config-handlers.js';
import { setupEditorHandlers } from './editor-handlers.js';
import { setupToolsHandlers } from './tools-handlers.js';
import { setupKeyboardHandlers } from './keyboard-handlers.js';
import { setupSystemHandlers, cleanupWorkTempFiles } from './system-handlers.js';
import { setupPtyHandlers, cancelAllPrompts } from './pty-handlers.js';
import { setupTelegramHandlers } from './telegram-handlers.js';
import { setupDraftHandlers } from './draft-handlers.js';
import { setupPlanHandlers } from './plan-handlers.js';
import { setupScheduledTaskHandlers } from './scheduled-task-handlers.js';
import { setupRecycleBinHandlers } from './recycle-bin-handlers.js';
import { setupRuntimeGroupHandlers } from './runtime-group-handlers.js';
import { setupArtifactHandlers } from './artifact-handlers.js';
import { setupMemoryHandlers } from './memory-handlers.js';
import { setupMessHandlers } from './mess-handlers.js';
import { setupProjectHandlers } from './project-handlers.js';
import { setupSkillHandlers } from './skill-handlers.js';
import { setupPromptTemplateHandlers } from './prompt-template-handlers.js';
import { loadDrafts, saveDrafts } from '../../session/persistence.js';
import { IncomingPlansWatcher } from '../../session/incoming-plans-watcher.js';
import { WindowManager } from '../window-manager.js';
import { HelmControlService } from '../../mcp/helm-control-service.js';
import { LocalhostMcpServer } from '../../mcp/localhost-mcp-server.js';
import { InboundCallGate } from '../../mcp/peer/inbound-call-gate.js';
import { createDefaultPeerRateLimiter } from '../../mcp/peer/rate-limiter.js';
import { PeerAuditLog } from '../../mcp/peer/peer-audit-log.js';
import { PeerConfigManager } from '../../session/peer-config-manager.js';
import { loadPeers, savePeers } from '../../session/peer-config-persistence.js';
import { setupPairingHandlers } from './pairing-handlers.js';
import { setupPeerManagementHandlers } from './peer-management-handlers.js';
import { setupMobileHandlers } from './mobile-handlers.js';
import { MobileDeviceStore } from '../../mobile/mobile-device-store.js';
import { MobilePairing } from '../../mobile/mobile-pairing.js';
import { MobileLinkManager } from '../../mobile/mobile-link-manager.js';
import { BleLinkClient } from '../../mobile/ble/ble-link-client.js';
import { SocketLinkTransport } from '../../mobile/lan/socket-link-transport.js';
import { loadNoble } from '../../mobile/ble/noble-adapter.js';
import { MobileGate, createDefaultMobileRateLimiter } from '../../mobile/mobile-gate.js';
import { MobileChatBridge } from '../../mobile/mobile-chat-bridge.js';
import { MobileArtifactUploadService } from '../../mobile/mobile-artifact-upload.js';
import { MobileChatJournal } from '../../mobile/mobile-chat-journal.js';
import { MobileAddressAdvertiser } from '../../mobile/mobile-address-advertiser.js';
import { PrimaryLanAddressResolver } from '../../mobile/primary-lan-address.js';
import { MobileAlertNotifier } from '../../mobile/mobile-alert-notifier.js';
import { MobileArtifactNotifier } from '../../mobile/mobile-artifact-notifier.js';
import type { ObservedSession } from '../../mobile/mobile-alert-notifier.js';

/**
 * The ONE MobileGate instance, built during handler setup. Exposed so whoever
 * owns the BLE call path (P-0748) routes inbound phone frames through
 * `getMobileGate()?.handle(...)` — there must be no second gate and no direct
 * path from a mobile frame to callMcpTool.
 */
let activeMobileGate: MobileGate | undefined;
export function getMobileGate(): MobileGate | undefined {
  return activeMobileGate;
}
import {
  loadMobileDevices, saveMobileDevices, loadMobileSecrets, saveMobileSecrets,
  loadMobileChatJournal, saveMobileChatJournal,
} from '../../mobile/mobile-device-persistence.js';
import { FleetController } from '../../mcp/peer/fleet-controller.js';
import type { FleetConfig } from '../../config/loader.js';
import { PinnedCertStore } from '../../mcp/peer/pinned-cert-store.js';
import { SecretStore } from '../../mcp/peer/secret-store.js';
import { loadPeerPins, savePeerPins, loadPeerSecrets, savePeerSecrets } from '../../mcp/peer/peer-secret-persistence.js';
import { asRecord } from '../../mcp/tools/validation.js';
import { PromptTemplateManager } from '../../session/prompt-template-manager.js';
import { MessNotifier } from '../../session/mess-notifier.js';
import { loadPromptTemplates } from '../../session/prompt-template-persistence.js';
import { getConfigDir } from '../../utils/app-paths.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { HookReceiver } from '../../session/hooks/hook-receiver.js';
import { HookTracker } from '../../session/hooks/hook-tracker.js';
import { ContextInjector } from '../../session/hooks/context-injector.js';
import { LoopDriver } from '../../session/hooks/loop-driver.js';
import { Bm25SuggestionScorer, BoostedSuggestionScorer, SuggestionService } from '../../session/hooks/suggestion-scorer.js';
import { SuggestionUsageStore } from '../../session/hooks/suggestion-usage-store.js';
import { createRulesViaHooksFn } from '../../session/hooks/hook-capability.js';
import { createReminderDeliveryFn } from '../../session/reminder-delivery.js';
import { readHookIntegrationStatus, type HookInstallerDeps } from '../../session/hooks/hook-installer.js';
import { hostname } from 'node:os';

const TELEGRAM_AUTOSTART_DELAY_MS = 60_000;
// On restart the previous instance may still be releasing the fixed MCP port.
// Retry the same port (never a fallback) with backoff until it frees.
const MCP_BIND_ATTEMPTS = 20;
const MCP_BIND_RETRY_DELAY_MS = 250;

export interface IpcStartupOptions {
  startupDelayMs?: number;
}


/**
 * Register all IPC handlers.
 *
 * Dependencies are created/imported here and injected into each domain module
 * so handler files never import singletons directly.
 */
export function registerIPCHandlers(
  dirname?: string,
  configLoader: ConfigLoader = new ConfigLoader(),
  options: IpcStartupOptions = {},
): { cleanup: () => Promise<void>; sessionManager: SessionManager; ptyManager: PtyManager; incomingWatcher: IncomingPlansWatcher; windowManager: WindowManager; helmControlService: HelmControlService; runtimeGroupManager: RuntimeGroupManager } {
  logger.info('[IPC] Registering handlers');
  const startupDelayMs = Math.max(0, options.startupDelayMs ?? 0);

  const windowManager = new WindowManager();

  // Clean up stale temp files from previous sessions
  if (dirname) {
    cleanupWorkTempFiles(dirname);
  }

  // Load config eagerly so individual handlers don't need to call load()
  try {
    configLoader.load();
    logger.info(`[IPC] Config loaded: ${configLoader.getCliTypes()}`);
  } catch (error) {
    logger.error(`[IPC] Failed to load config: ${error}`);
  }

  // SessionManager is created here and shared via dependency injection.
  // Projects are the single source of truth for working directories, so the
  // ConfigLoader derives them from the project store.
  const projectStore = new ProjectStore();
  configLoader.setProjectStore(projectStore);

  const sessionManager = new SessionManager(projectStore);
  // Temp copies handed to external apps are attributed to their session so a
  // close reaps them, whether or not the session is still recoverable.
  const artifactTempRegistry = new ArtifactTempRegistry();
  attachSessionTempCleanup(sessionManager, artifactTempRegistry);
  const ptyManager = new PtyManager();
  const stateDetector = new StateDetector();
  const pipelineQueue = new PipelineQueue();
  const draftManager = new DraftManager(saveDrafts);
  const artifactAttachmentManager = new ArtifactAttachmentManager();
  const artifactManager = new ArtifactManager(
    (all) => saveArtifacts(all),
    Date.now,
    (artifactId) => artifactAttachmentManager.deleteForArtifact(artifactId),
  );
  artifactManager.importAll(loadArtifacts());
  const memoryPersistence = new MemoryPersistence();
  const memoryAttachmentManager = new MemoryAttachmentManager();
  // PlanManager is constructed before MemoryManager so provenance can be
  // stamped at write time. It cannot be reconstructed afterwards: a plan's
  // sessionId is overwritten by whoever claims it next.
  const planManager = new PlanManager(projectStore);
  const memoryManager = new MemoryManager({
    persistence: memoryPersistence,
    attachmentManager: memoryAttachmentManager,
    resolveSessionProject: (id) => sessionManager.getSession(id)?.projectId ?? null,
    resolveSessionPlan: (id) => planManager.claimedPlanFor(id)?.id ?? null,
  });
  const contextManager = new ContextManager(planManager);
  const getSkillsPath = (configLoader as ConfigLoader & { getSkillsPath?: () => string }).getSkillsPath;
  const getSkillAnalyticsPath = (configLoader as ConfigLoader & { getSkillAnalyticsPath?: () => string }).getSkillAnalyticsPath;
  const skillManager = new SkillManager(getSkillsPath ? getSkillsPath.call(configLoader) : 'src/config/skills.yaml');
  const skillAnalyticsManager = new SkillAnalyticsManager(getSkillAnalyticsPath ? getSkillAnalyticsPath.call(configLoader) : 'src/config/skill-analytics.json');
  const scheduledTaskHistoryManager = new ScheduledTaskHistoryManager();
  const recycleBinManager = new RecycleBinManager();
  const runtimeGroupManager = new RuntimeGroupManager(saveRuntimeGroups);
  runtimeGroupManager.importAll(loadRuntimeGroups());
  const scheduledTaskManager = new ScheduledTaskManager(sessionManager, ptyManager, planManager, configLoader, scheduledTaskHistoryManager, projectStore);
  const notificationManager = new NotificationManager(windowManager, sessionManager);

  // Power monitor with full session/PTY diagnostics and screen lock tracking
  const powerMonitorResult = setupPowerMonitor(powerMonitor, { sessionManager, ptyManager });
  notificationManager.setScreenLockChecker(powerMonitorResult.isScreenLocked);
  notificationManager.setActiveSessionIdGetter(() => sessionManager.getActiveSession()?.id ?? null);

  // Create HelmControlService before Telegram modules (Telegram relay needs it)
  const helmControlService = new HelmControlService(planManager, sessionManager, ptyManager, configLoader, undefined, contextManager, scheduledTaskManager, projectStore, skillManager, skillAnalyticsManager);
  helmControlService.setNotificationManager(notificationManager);
  helmControlService.setRuntimeGroupManager(runtimeGroupManager);
  helmControlService.setArtifactManager(artifactManager, artifactAttachmentManager);
  // The phone's upload reassembler (protocol 4): slots opened by the gated
  // session_artifact_attachment_add, filled by binary blob records, committed
  // by session_artifact_attachment_commit into the SAME managed storage the
  // desktop's own imports use.
  const artifactUploadService = new MobileArtifactUploadService({
    attachments: artifactAttachmentManager,
  });
  helmControlService.setArtifactUploadService(artifactUploadService);
  helmControlService.setMemoryManager(memoryManager, memoryAttachmentManager, artifactTempRegistry);

  const telegramBot = new TelegramBotCore();
  const topicManager = new TopicManager(telegramBot, sessionManager, configLoader.getTelegramConfig().instanceName);
  const telegramNotifier = new TelegramNotifier(telegramBot, topicManager, sessionManager, () => configLoader.getTelegramConfig());

  // Wire the Telegram notifier to the notification manager for LLM-directed notifications when screen is locked
  notificationManager.setTelegramNotifier(async (sessionId: string, title: string, content: string) => {
    if (!telegramBot.isRunning()) return;
    const session = sessionManager.getSession(sessionId);
    if (!session) return;
    const topicId = await topicManager.ensureTopic(session);
    if (topicId == null) return;
    const text = `${title}\n\n${content}`;
    try {
      await telegramBot.sendToTopic(topicId, text);
    } catch (error) {
      logger.error(`[IPC] Failed to send LLM notification via Telegram: ${error}`);
    }
  });

  // Initialize all telegram modules (Phase 1+2+3)
  const telegramModules = initTelegramModules(
    telegramBot, topicManager, telegramNotifier,
    sessionManager, ptyManager, configLoader, helmControlService, draftManager, projectStore,
  );

  // The chat broker: Telegram and the phone are two registrations in an
  // UNBOUNDED registry, never a hardcoded pair — a LAN surface is wanted later
  // and must be one more `register()` call, nothing else. Fan-out through it is
  // unconditional; see src/session/chat/chat-broker.ts for why.
  const chatBroker = new ChatBroker({
    deliver: async (message) => {
      const target = sessionManager.getSession(message.sessionId);
      if (!target) {
        logger.warn(`[chat] Dropped an inbound ${message.provider} message for unknown session ${message.sessionId}`);
        return;
      }
      await deliverPromptSequenceToSession({
        sessionId: target.id,
        text: message.text,
        ptyManager,
        sessionManager,
        configLoader,
      });
    },
    // A file sent over chat is copied into the session's artifact attachments
    // so a surface with no filesystem access to this machine can still fetch
    // it. Telegram keeps using the path; see chat-attachment-registrar.ts.
    registerAttachment: createChatAttachmentRegistrar({
      artifacts: artifactManager,
      attachments: artifactAttachmentManager,
    }),
  });
  chatBroker.register(telegramModules.relayService);
  helmControlService.setChatBroker(chatBroker);

  // Message-flight gate: every enveloped session_send_text broadcasts a
  // flight to all windows; the paste is held until a renderer acks the
  // landing (the delivery service enforces the timeout release).
  const pendingFlightAcks = new Map<string, () => void>();
  ipcMain.handle('session:message-flight-ack', (_event, flightId: unknown) => {
    if (typeof flightId === 'string') {
      pendingFlightAcks.get(flightId)?.();
      pendingFlightAcks.delete(flightId);
    }
    return { ok: true };
  });
  helmControlService.setMessageFlightSink(flight => new Promise<void>(resolve => {
    pendingFlightAcks.set(flight.flightId, resolve);
    for (const window of windowManager.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('session:message-flight', flight);
    }
    // Late-ack sanitation: drop the registry entry once the sender side has
    // certainly moved on, so the map cannot grow without bound.
    setTimeout(() => {
      if (pendingFlightAcks.get(flight.flightId) === resolve) pendingFlightAcks.delete(flight.flightId);
    }, getMessageFlightTimeoutMs() + 5000).unref?.();
  }));

  // Restore sessions persisted from previous run
  const restored = sessionManager.restoreSessions();
  logger.info(`[IPC] Restored ${restored.length} session(s) from previous run`);

  // Reclaim orphaned artifacts left by a crash (which bypasses the session:removed
  // cleanup). Keep artifacts for any live restored session OR any recycle-bin entry
  // (a recoverable session awaiting restore, which reuses its original id); drop the
  // rest. A bin entry that later expires (30d) has its artifacts reclaimed here on a
  // subsequent startup.
  const liveSessionIds = new Set(sessionManager.getAllSessions().map(s => s.id));
  const binSessionIds = new Set(recycleBinManager.list().map(e => e.sessionId));
  try {
    memoryManager.pruneOrphanedSessions(new Set([...liveSessionIds, ...binSessionIds]));
  } catch (error) {
    logger.error(`[IPC] Failed to prune orphaned memories: ${error}`);
  }
  pruneOrphanArtifacts(
    Object.keys(artifactManager.exportAll()),
    liveSessionIds,
    binSessionIds,
    id => artifactManager.clearSession(id),
  );

  // Prune orphan attachment directories (artifacts deleted in a previous crash)
  const allArtifactIds = new Set(
    Object.values(artifactManager.exportAll()).flat().map(a => a.id),
  );
  artifactAttachmentManager.pruneOrphans(allArtifactIds);

  draftManager.importAll(loadDrafts());
  // PlanManager loads from disk in its constructor — no explicit importAll needed

  // PromptTemplateManager: global tree, persisted to prompt-templates.yaml
  const promptTemplateManager = new PromptTemplateManager();
  const promptTemplatesPath = dirname
    ? join(getConfigDir(dirname), 'prompt-templates.yaml')
    : undefined;
  if (promptTemplatesPath) {
    loadPromptTemplates(promptTemplatesPath, promptTemplateManager);
  }

  const incomingWatcher = new IncomingPlansWatcher(planManager);
  // The shim is seeded into the user config dir alongside the other shipped
  // defaults; the installer writes CLI configs that point HERE at it. Shared by
  // the settings handlers (below) and the G4 rules-via-hooks capability check.
  const hookDeps: HookInstallerDeps = {
    homeDir: () => homedir(),
    shimPath: join(getConfigDir(dirname ?? process.cwd()), 'hooks', 'helm-hook-shim.py'),
  };
  // G1 transport + G2 enforcement: receives CLI lifecycle hooks on POST /hooks,
  // correlates them by session token, logs them, and routes PreToolUse through
  // the deny policy. Session/rules lookups are live reads — no cached policy
  // state — and every failure inside them fails open to allow. The G4
  // responder (ContextInjector) is bound after construction below — it needs
  // managers built later in this setup.
  const hookReceiver = new HookReceiver({
    getSession: (sessionId) => sessionManager.getSession(sessionId),
    getDenyRules: (provider) => configLoader.getHookDenyRules(provider),
  });
  // G4 dual-path capability: does a recipient session inject its inter-session
  // rules via hooks (so the prepended header can be skipped)? Read live, on
  // disk, shared by the MCP delivery service and the Telegram relay. A check
  // that fails answers false — prepend as today, never break delivery.
  const rulesViaHooks = createRulesViaHooksFn(
    (cliTypeId) => configLoader.getCliTypeEntry(cliTypeId),
    (hooks) => readHookIntegrationStatus(hooks, hookDeps),
  );
  // G5: ranking signals behind the same scorer interface. The usage store is
  // ids + term co-occurrence ONLY — never prompt text (docs/cli-hooks.md, G5);
  // the scorer reorders passers only, so nothing crosses the threshold on
  // signal strength. The store is constructed here (not with the suggester
  // below) because the MCP server's fetch recording feeds it.
  const suggestionUsage = new SuggestionUsageStore({ configDir: getConfigDir(dirname ?? process.cwd()) });
  const suggestionScorer = new BoostedSuggestionScorer(new Bm25SuggestionScorer(), {
    getMemoryEdges: () => memoryManager.listEdges(),
    getWorkspacePlanIds: (sessionId) => {
      const claimed = planManager.claimedPlanFor(sessionId);
      if (!claimed) return new Set<string>();
      const ids = new Set<string>([claimed.id]);
      if (claimed.projectId && claimed.sequenceId) {
        for (const item of planManager.getForProject(claimed.projectId)) {
          if (item.sequenceId === claimed.sequenceId) ids.add(item.id);
        }
      }
      const boundContexts = [
        ...contextManager.getContextsForPlan(claimed.id),
        ...(claimed.sequenceId ? contextManager.getContextsForSequence(claimed.sequenceId) : []),
      ];
      for (const context of boundContexts) {
        for (const planId of contextManager.getPlanIdsForContext(context.id)) ids.add(planId);
      }
      return ids;
    },
    usageBoost: (key, terms) => suggestionUsage.boostFor(key, terms),
  }, configLoader.getSuggestionScoring());
  const localhostMcpServer = new LocalhostMcpServer(helmControlService, {
    enabled: configLoader.getMcpConfig().enabled,
    port: configLoader.getMcpConfig().port,
    token: configLoader.getMcpConfig().authToken,
    // G5 usage feedback: correlate a fetch with a recent suggestion. Only
    // identifiable sessions land here; anonymous peers learn nothing.
    onItemFetched: (sessionId, type, id) => suggestionUsage.recordFetch(sessionId, `${type}/${id}`),
  }, ptyManager, hookReceiver);

  // Pattern matcher uses raw deliverText for send-text rule actions.
  const patternMatcher = new PatternMatcher(
    (sessionId, data) => ptyManager.deliverText(sessionId, data),
    (cliType) => configLoader.getPatterns(cliType),
    // This runs on every PTY output chunk. resolveCliType throws on an ambiguous
    // display name (two types sharing a label — reachable by hand-editing
    // cli-types.yaml), and per invariant 7 nothing on the PTY data path may
    // throw. Degrade to the raw reference instead.
    (cliType) => {
      try {
        return configLoader.resolveCliType(cliType)?.id ?? cliType;
      } catch {
        return cliType;
      }
    },
  );

  const cleanupSession = setupSessionHandlers(sessionManager, ptyManager, draftManager, windowManager, configLoader);
  // Forward-declared so config:setFleetConfig can hot-apply the live fleet
  // stack (constructed below, ~line 460). The closure is only invoked at runtime on
  // a user config change, long after the controller exists.
  let fleetController: FleetController | undefined;
  const applyFleetConfig = async (_cfg: FleetConfig): Promise<void> => {
    await fleetController?.applyConfig();
  };
  setupConfigHandlers(
    configLoader,
    localhostMcpServer,
    projectStore,
    applyFleetConfig,
    () => fleetController!.status(),
    hookDeps,
    suggestionUsage,
  );
  setupEditorHandlers(configLoader);
  setupToolsHandlers(configLoader);
  setupKeyboardHandlers(keyboard);
  setupSystemHandlers(dirname ?? process.cwd());
  setupDraftHandlers(draftManager);
  setupProjectHandlers(projectStore, planManager, contextManager, windowManager);
  setupSkillHandlers(skillManager, skillAnalyticsManager);
  setupPlanHandlers(planManager, contextManager, windowManager, incomingWatcher, dirname);
  setupScheduledTaskHandlers(scheduledTaskManager, scheduledTaskHistoryManager, windowManager);
  // Keep lightweight handler fixtures (and embedders that do not enable
  // project services) compatible with the optional Mess surface.
  const messManager = helmControlService.getMessManager?.() ?? null;
  // Created here (not in the mobile block far below) so the recycle bin's
  // purge paths can prune it — the journal's retention is the session's
  // lifetime, and a purged session's replay dies with it.
  const mobileChatJournal = new MobileChatJournal({ persist: saveMobileChatJournal });
  mobileChatJournal.hydrate(loadMobileChatJournal());
  setupRecycleBinHandlers(recycleBinManager, artifactManager, windowManager, artifactTempRegistry, memoryManager, messManager ?? undefined, mobileChatJournal);
  // Expired entries loaded from persisted state were not visible to the runtime
  // expiry event until now; dispatch them after cleanup listeners are attached.
  recycleBinManager.pruneExpired();
  setupRuntimeGroupHandlers(runtimeGroupManager, windowManager);
  setupArtifactHandlers(artifactManager, artifactAttachmentManager, windowManager, dirname, artifactTempRegistry);
  setupMemoryHandlers(memoryManager, memoryAttachmentManager, sessionManager, windowManager, artifactTempRegistry);

  // Memory mutations can originate from MCP or another window. Route the
  // invalidation only to windows that own the changed session; unscoped legacy
  // records are broadcast so they cannot leave a stale view behind.
  memoryManager.on('memory:changed', (event: { sessionId?: string }) => {
    const targets = event.sessionId
      ? [windowManager.getWindowForSession(event.sessionId)].filter((win): win is BrowserWindow => Boolean(win && !win.isDestroyed()))
      : windowManager.getAllWindows();
    for (const win of targets) win.webContents.send('memory:changed', event);
  });

  // Forward artifact mutations/reveals to the main window AND the session's own
  // popout window (mirrors the session:updated dual-window forwarding below), so
  // whichever window is showing the session sees the change. Channel literals are
  // spelled out per-window so the IPC contract test can find the main sender.
  const artifactWindowsFor = (sessionId: string): BrowserWindow[] => {
    const targets: BrowserWindow[] = [];
    const mainWin = windowManager.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) targets.push(mainWin);
    const sessionWindowId = windowManager.getWindowIdForSession(sessionId);
    if (sessionWindowId !== undefined) {
      const sessionWindow = windowManager.getWindow(sessionWindowId);
      if (sessionWindow && !sessionWindow.isDestroyed()) targets.push(sessionWindow);
    }
    return targets;
  };
  artifactManager.on('artifact:changed', (sessionId: string) => {
    for (const win of artifactWindowsFor(sessionId)) {
      win.webContents.send('artifact:changed', { sessionId });
    }
  });
  artifactManager.on('artifact:reveal', (sessionId: string, artifactId: string) => {
    for (const win of artifactWindowsFor(sessionId)) {
      win.webContents.send('artifact:reveal', { sessionId, artifactId });
    }
  });
  setupPtyHandlers(ptyManager, stateDetector, sessionManager, pipelineQueue, windowManager, configLoader, notificationManager, undefined, undefined, undefined, patternMatcher);
  const messNotifier = messManager
    ? new MessNotifier(
      messManager,
      sessionManager,
      stateDetector,
      projectStore,
      helmControlService,
      sessionId => ptyManager.has(sessionId),
      sessionId => {
        // An unresolved CLI type is not an opt-out: only an explicit false silences.
        const cliType = sessionManager.getSession(sessionId)?.cliType;
        return configLoader.getCliTypeEntry(cliType ?? '')?.messReminders !== false;
      },
    )
    : null;
  // Carries a session's handover note across its own compaction: session_compact
  // arms the text while the context still exists, and it is pasted back on the
  // first lull after the compact command.
  const handoverDelivery = new HandoverDelivery(
    stateDetector,
    sessionManager,
    async (sessionId, text) => { await deliverPromptSequenceToSession({
      sessionId,
      text,
      ptyManager,
      sessionManager,
      configLoader,
      verifyDelivery: { label: 'handover', delayMs: 4000, retrySubmit: true },
    }); },
    (sessionId, reason) => {
      // The session's whole working state was riding on this note, and the
      // context that produced it is already gone — silence would be worse.
      const name = sessionManager.getSession(sessionId)?.name ?? sessionId;
      notificationManager.notifyLlmDirected(
        sessionId,
        'Handover lost',
        reason === 'cancelled'
          ? `The pending handover for "${name}" was cancelled and will not be delivered.`
          : reason === 'session-closed'
            ? `"${name}" closed before its handover could be delivered.`
            : `The handover for "${name}" could not be written to its terminal.`,
      );
    },
  );
  helmControlService.setHandoverDelivery(handoverDelivery);
  const cleanupHandover = setupHandoverHandlers(handoverDelivery, windowManager);

  // G3: hook-reported truth. The tracker turns canonical hook events into the
  // SAME state channels the timing fallback already drives — activity edges
  // through StateDetector, session mutations through updateSession, plan
  // moves through PlanManager — plus the PreCompact snapshot artifact. A
  // session without hooks never produces hook events, so for it nothing here
  // runs and behaviour is exactly as before.
  const hookTracker = new HookTracker({
    stateDetector,
    sessionManager,
    planManager,
    flashAttention: (sessionId) => notificationManager.flashAttention(sessionId),
    handoverDelivery,
    draftManager,
    artifactManager,
    artifactAttachments: artifactAttachmentManager,
  });
  hookTracker.watch(hookReceiver);

  // G8 loop driving: the Stop-hook continuation brain. Fed by the same hook
  // stream (progress ticks, user turns, StopFailure) and by plan_complete's
  // completion notice (bound to the MCP server below — it is constructed
  // earlier than the managers this needs, hence the late binding). G10:
  // autoImplement on a plan is the only consent; the global
  // hooks.loopDriving.enabled kill switch (read live) is the only opt-out.
  const loopDriver = new LoopDriver({
    getSession: (sessionId) => sessionManager.getSession(sessionId),
    getPlan: (planId) => planManager.getItem(planId),
    updateSession: (sessionId, updates) => sessionManager.updateSession(sessionId, updates),
    flashAttention: (sessionId) => notificationManager.flashAttention(sessionId),
    getLoopConfig: () => configLoader.getLoopDrivingConfig(),
  });
  loopDriver.watch(hookReceiver);
  localhostMcpServer.setLoopDriver(loopDriver);

  // G4: the injection brain, bound to the receiver built above. SILENT for a
  // session without hook events — nothing here runs, so behaviour is exactly
  // as before. The suggester's candidates are built per prompt: skills visible
  // to the session's project (globals included), plus that project's live
  // (non-dormant) memories. Pointers only, capped, once per item.
  //
  // G5: the suggester now runs on the boosted scorer above, and feeds the
  // usage store what was actually sent.
  const suggestionService = new SuggestionService({
    getCandidates: (projectId) => {
      const skills = skillManager.listForProject(projectId).map((skill) => ({
        type: 'skill' as const,
        id: skill.id,
        name: skill.name,
        description: skill.description,
        allProjects: skill.allProjects,
      }));
      if (!projectId) return skills;
      const memories = memoryManager.listRecords()
        .filter((record) => record.projectId === projectId && record.dormantSince === undefined)
        .map((record) => ({
          type: 'memory' as const,
          id: record.id,
          name: record.tldr,
          description: record.content,
          createdAt: record.createdAt,
          ...(record.planId ? { planId: record.planId } : {}),
        }));
      return [...skills, ...memories];
    },
    scorer: suggestionScorer,
    onSuggested: (sessionId, keys, terms) => suggestionUsage.noteSuggestion(sessionId, keys, terms),
  });
  const contextInjector = new ContextInjector({
    getSession: (sessionId) => sessionManager.getSession(sessionId),
    getClaimedPlan: (sessionId) => {
      const plan = planManager.claimedPlanFor(sessionId);
      return plan ? { humanId: plan.humanId, title: plan.title, status: plan.status } : null;
    },
    getStartablePlans: (dirPath) => planManager.getStartableForDirectory(dirPath).map((plan) => ({
      humanId: plan.humanId, title: plan.title, status: plan.status,
    })),
    getDrafts: (sessionId) => draftManager.getForSession(sessionId).map((draft) => ({ label: draft.label, text: draft.text })),
    getHandover: (sessionId) => handoverDelivery.peek(sessionId),
    suggest: (sessionId, prompt, projectId) => suggestionService.suggest(sessionId, prompt, projectId),
    getProjectIdForDirectory: (dirPath) => planManager.getProjectIdForDirectory(dirPath),
    getReminderMode: (reminder) => configLoader.getReminderDelivery()[reminder],
    loop: loopDriver,
  });
  hookReceiver.setResponder((event) => contextInjector.respond(event));
  // A closed session takes its nudger and suggester ledgers with it — a
  // restored session (same id) starts with clean slates.
  sessionManager.on('session:removed', (event) => {
    contextInjector.forgetSession(event.sessionId);
    suggestionService.forgetSession(event.sessionId);
    suggestionUsage.forgetSession(event.sessionId);
    loopDriver.forgetSession(event.sessionId);
  });
  // Dual-path rules delivery (G9): every surface resolves each standing
  // reminder from the same settings + capability — the delivery services
  // decide whether to prepend, the injector decides whether to inject, and
  // 'off' suppresses both. Defaults reproduce today, so nothing changes until
  // the user sets a mode in the CLI Integrations pane.
  const reminderDelivery = createReminderDeliveryFn(
    rulesViaHooks,
    (reminder) => configLoader.getReminderDelivery()[reminder],
  );
  helmControlService.setReminderDelivery(reminderDelivery);
  telegramModules.relayService.setReminderDelivery(reminderDelivery);

  const cleanupMess = setupMessHandlers(messManager, projectStore, windowManager, sessionManager);
  const cleanupPromptTemplates = promptTemplatesPath
    ? setupPromptTemplateHandlers(promptTemplateManager, promptTemplatesPath)
    : () => {};

  // Wire events ONCE (no-ops when bot not running — notifier checks isRunning).
  // AIAGENT phase changes are now explicit MCP state updates, not PTY text
  // parsing, so StateDetector transitions must not drive Telegram notifications.
  sessionManager.on('session:added', async (event) => {
    // Push to renderer so it can adopt externally-spawned terminals (e.g. Telegram)
    const win = windowManager.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:spawned-externally', event);
    }

    if (!telegramBot.isRunning()) return;
    const session = sessionManager.getSession(event.id);
    if (session) await topicManager.ensureTopic(session);
  });
  sessionManager.on('session:updated', (event) => {
    const win = windowManager.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:updated', event);
    }

    if (telegramBot.isRunning()) {
      topicManager.renameSessionTopic(event).catch(err =>
        logger.error(`[Telegram] Failed to rename topic for ${event.id}: ${err}`),
      );
    }

    const sessionWindowId = windowManager.getWindowIdForSession(event.id);
    if (sessionWindowId === undefined) return;
    const sessionWindow = windowManager.getWindow(sessionWindowId);
    if (sessionWindow && !sessionWindow.isDestroyed()) {
      sessionWindow.webContents.send('session:updated', event);
    }
  });
  sessionManager.on('session:removed', (event) => {
    // Recoverable (has a cliSessionName) closed sessions go to the recycle bin,
    // and their directory is auto-bookmarked so the group header persists. Tag
    // the bin entry with the session's runtime group (if any) so restore can
    // re-attach it, then evict the closed session from that group.
    const runtimeGroup = runtimeGroupManager.groupForSession(event.sessionId);
    // Resolve the session's project for the bin's Project tree level. Use the
    // snapshot's projectId when present, else look up by working dir — findByPath
    // (never resolveForPath) so a close event can't spawn a phantom project.
    const projectRecord =
      (event.session?.projectId ? projectStore.getById(event.session.projectId) : undefined) ??
      (event.session?.workingDir ? projectStore.findByPath(event.session.workingDir) : undefined);
    const binned = recordRemovedSession(
      event,
      recycleBinManager,
      dir => configLoader.addBookmarkedDir(dir),
      runtimeGroup ? { id: runtimeGroup.id, name: runtimeGroup.name } : undefined,
      projectRecord ? { id: projectRecord.id, name: projectRecord.name } : undefined,
    );
    runtimeGroupManager.removeSessionEverywhere(event.sessionId);
    // A recoverable close keeps the Mess cursor so a restored session does not
    // lose unread mail; an ephemeral close has no way back, so the cursor goes.
    try {
      messManager?.onSessionClosed(event.sessionId, binned ? 'recoverable' : 'ephemeral');
    } catch (error) {
      logger.error(`[IPC] Failed to update the Mess cursor for removed session ${event.sessionId}: ${error}`);
    }

    // Artifacts follow the session's recoverability. A recoverable session goes to
    // the recycle bin, so KEEP its artifacts under the same id — restore reuses that
    // id and they come straight back; only Forget/Empty clears them. A non-recoverable
    // (ephemeral) close has no bin entry, so drop its artifacts now.
    if (!binned) {
      try {
        memoryManager.purgeSession(event.sessionId);
      } catch (error) {
        logger.error(`[IPC] Failed to purge memories for removed session ${event.sessionId}: ${error}`);
      }
      artifactManager.clearSession(event.sessionId);
      // No bin entry means no way back, so the phone's replay of this
      // conversation goes now too — same rule the bin's purge paths enforce.
      try {
        mobileChatJournal.pruneSession(event.sessionId);
      } catch (error) {
        logger.error(`[IPC] Failed to prune the chat journal for removed session ${event.sessionId}: ${error}`);
      }
    }

    if (!telegramBot.isRunning()) return;
    telegramNotifier.removeSession(event.sessionId);
    if (event.session?.topicId) {
      topicManager.closeSessionTopic(event.session).catch(err =>
        logger.error(`[Telegram] Failed to close topic for ${event.sessionId}: ${err}`),
      );
    }
  });

  const cleanupTelegram = setupTelegramHandlers(configLoader, telegramBot, topicManager, telegramNotifier, sessionManager, stateDetector, () => helmControlService.invalidateCapabilityCache());

  // Auto-start Telegram bot if configured, but always wait for app startup to settle first.
  const telegramAutoStartTimer = configLoader.getTelegramConfig().autoStart
    ? setTimeout(() => {
        const telegramConfig = configLoader.getTelegramConfig();
        if (!telegramConfig.autoStart) return;
        if (telegramBot.isRunning()) return;
        if (!telegramConfig.botToken || !telegramConfig.chatId) {
          logger.warn('[IPC] Telegram auto-start skipped: botToken or chatId not configured');
          return;
        }
        if (!telegramConfig.allowedUserIds || telegramConfig.allowedUserIds.length === 0) {
          logger.warn('[IPC] Telegram auto-start skipped: no allowedUserIds configured');
          return;
        }
        try {
          telegramBot.start(telegramConfig.botToken, telegramConfig.chatId, telegramConfig.allowedUserIds);
          topicManager.setInstanceName(telegramConfig.instanceName);
          topicManager.ensureAllTopics().catch(err => logger.error(`[Telegram] Failed to ensure topics: ${err}`));
          logger.info('[IPC] Telegram bot auto-started after 60 seconds');
        } catch (err) {
          logger.error(`[IPC] Failed to auto-start Telegram bot: ${err}`);
        }
      }, TELEGRAM_AUTOSTART_DELAY_MS + startupDelayMs)
    : null;

  logger.info('[IPC] All handlers registered');

  // Start scheduled task manager
  scheduledTaskManager.start();

  const startMcpServer = () => {
    void localhostMcpServer.start({ attempts: MCP_BIND_ATTEMPTS, delayMs: MCP_BIND_RETRY_DELAY_MS }).catch((error) => {
    const isAddrInUse = error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE';
    const port = localhostMcpServer.getAddress()?.port ?? configLoader.getMcpConfig().port;
    if (isAddrInUse) {
      dialog.showErrorBox(
        'MCP Server Failed to Start — Port Already in Use',
        `Helm's MCP server could not start because port ${port} is already in use by another process.\n\n` +
        `The MCP feature allows external AI tools to control Helm. Without it, those tools will not work.\n\n` +
        `To fix this:\n` +
        `1. Close the other application using port ${port}, or\n` +
        `2. Change the MCP port in Helm Settings → MCP Server\n\n` +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    logger.error(`[MCP] Failed to start localhost MCP server: ${error}`);
    });
  };
  const mcpStartTimer = startupDelayMs > 0
    ? setTimeout(startMcpServer, startupDelayMs)
    : null;
  if (!mcpStartTimer) startMcpServer();

  // Cross-machine fleet (P-0646) — SEPARATE listener from the 127.0.0.1 MCP
  // server, OFF by default. When disabled this binds nothing. The inbound-call
  // sink is the InboundCallGate (P-0647): allow-list + hard-deny + rate-limit,
  // then dispatch through the EXISTING callMcpTool under a synthetic PROXY
  // identity (never a real local session). We build it here because this scope
  // has the deps (LocalhostMcpServer.dispatchForPeer + the peer registry).
  const peerConfigManager = new PeerConfigManager((peers) => savePeers(peers));
  peerConfigManager.importAll(loadPeers());

  // Shared trust stores — one instance used by pairing (writes pins/secrets),
  // the transport (reads them), and peer-management/unpair (removes them).
  const pinnedCertStore = new PinnedCertStore((pins) => savePeerPins(pins));
  pinnedCertStore.importAll(loadPeerPins());
  const secretStore = new SecretStore((secrets) => savePeerSecrets(secrets));
  secretStore.importAll(loadPeerSecrets());

  // Single audit log instance, reachable by both the inbound gate (appends) and
  // the peer-management handlers (reads for the Audit sub-view).
  const peerAuditLog = new PeerAuditLog();
  const inboundGate = new InboundCallGate({
    peerConfig: peerConfigManager,
    dispatch: (method, params, ctx) =>
      localhostMcpServer.dispatchForPeer(method, asRecord(params), ctx),
    rateLimiter: createDefaultPeerRateLimiter(),
    audit: peerAuditLog,
    sessionLookup: sessionManager,
  });

  // In-app fleet toggle (P-0658): ONE controller owns the LIVE transport +
  // discovery and starts/stops them on config change — no app restart, mirroring
  // LocalhostMcpServer.applyConfig. The shared trust stores are reused across every
  // toggle so pins/secrets/peers persist. The IPC handlers below register EXACTLY
  // ONCE (ipcMain.handle throws on a double-register) and read live state through
  // closures; only the controller ever starts/stops the transport + discovery.
  const broadcastToRenderers = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  fleetController = new FleetController({
    getConfig: () => configLoader.getFleetConfig(),
    onCall: (peerId, method, params) => inboundGate.handle(peerId, method, params),
    pinnedCertStore,
    secretStore,
    peerConfigManager,
    setLinkManager: (mgr) => helmControlService.setPeerLinkManager(mgr),
    // The machine's own hostname — two Helms both advertising "Helm" is useless
    // in a pick-your-peer list.
    alias: hostname(),
    broadcast: broadcastToRenderers,
  });

  // Pairing IPC (4 channels) — registered once, delegating to the controller's live
  // pairing runtime; returns an inert result when fleet is off.
  const disposePairing = setupPairingHandlers({
    getPairingRuntime: () => fleetController!.currentPairingRuntime(),
  });
  // Peer-management IPC — registered once, reading live isEnabled()/getLinkManager().
  const disposePeerManagement = setupPeerManagementHandlers({
    isEnabled: () => configLoader.getFleetConfig().enabled,
    peerConfigManager,
    pinnedCertStore,
    secretStore,
    audit: peerAuditLog,
    getLinkManager: () => fleetController!.currentLinkManager(),
  });
  // Mobile (BLE) device registry + pairing coordinator. Its own registry and its
  // own secret store, kept separate from the fleet's: a revoked phone must never
  // be able to take a peer's trust with it, and the two files have different
  // lifetimes.
  const mobileDeviceStore = new MobileDeviceStore((devices) => saveMobileDevices(devices));
  mobileDeviceStore.importAll(loadMobileDevices());
  const mobileSecretStore = new SecretStore((secrets) => saveMobileSecrets(secrets));
  mobileSecretStore.importAll(loadMobileSecrets());
  const mobilePairing = new MobilePairing({
    deviceStore: mobileDeviceStore,
    secretStore: mobileSecretStore,
    machineId: hostname(),
  });
  // The owner of the phone transports: they scan, it identifies a phone by its
  // machineId over a PSK handshake, and it is the only thing that can say whether
  // a device is genuinely online. The radio itself is loaded lazily, and only
  // once there is a paired phone to reach or a pairing under way.
  // The LAN half. Held in a variable because settings changes hot-apply to it;
  // the manager owns its lifecycle and never learns which transport is which.
  const mobileLanTransport = new SocketLinkTransport({
    ...configLoader.getMobileLanConfig(),
    logger: (message, error) =>
      error ? logger.warn(`[mobile-lan] ${message}: ${error}`) : logger.info(`[mobile-lan] ${message}`),
  });
  const mobileLinkManager = new MobileLinkManager({
    createTransports: () => [new BleLinkClient({
      noble: loadNoble(),
      logger: (message, error) =>
        error ? logger.warn(`${message}: ${error}`) : logger.info(message),
    }), mobileLanTransport],
    deviceStore: mobileDeviceStore,
    secretStore: mobileSecretStore,
    pairing: mobilePairing,
    machineId: hostname(),
  });
  void mobileLinkManager.start()
    .catch((err) => logger.error(`[mobile] Failed to start the BLE link manager: ${err}`));
  // Give the mobile_* tools the SAME coordinator the renderer drives, so a local
  // AI can pair a phone and grant it tools without a human at the UI. Wired here
  // because the control service is built long before the BLE stack exists.
  helmControlService.setMobileDeps({
    pairing: mobilePairing,
    deviceStore: mobileDeviceStore,
    isOnline: (machineId) => mobileLinkManager.isOnline(machineId),
  });
  // Shared by the advertiser and the settings panel so both show the same address.
  const primaryLanAddress = new PrimaryLanAddressResolver();
  const disposeMobile = setupMobileHandlers({
    deviceStore: mobileDeviceStore,
    getPairing: () => mobilePairing,
    isOnline: (machineId) => mobileLinkManager.isOnline(machineId),
    dropLink: (machineId) => mobileLinkManager.dropLink(machineId),
    links: mobileLinkManager,
    getAppVersion: () => app.getVersion(),
    // Electron's net follows the redirect GitHub issues for a release asset and
    // honours the system proxy. A failure here means "could not ask", which the
    // handler deliberately does not report as "no APK was published".
    checkApkAsset: async (url) => {
      const response = await net.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      return response.ok;
    },
    // Persist, then hot-apply to the live transport. Both, in that order: a
    // setting that took effect but was not saved is the worse of the two lies.
    lan: {
      get: () => configLoader.getMobileLanConfig(),
      set: async (config) => {
        configLoader.setMobileLanConfig(config);
        await mobileLanTransport.configure(configLoader.getMobileLanConfig());
        // The new port — or the fact that LAN is now off — has to reach a phone
        // that is connected RIGHT NOW, not at its next reconnect.
        mobileAddressAdvertiser.advertiseAll();
      },
      boundPort: () => mobileLanTransport.boundPort,
      addresses: (port) => primaryLanAddress.addresses(port),
    },
  });
  // The security boundary in front of every inbound phone call (P-0737). Built
  // here because this scope owns the registry, the session manager and the
  // dispatchForPeer seam. It is deliberately the ONLY way a mobile frame may
  // reach a tool — whoever wires the BLE call path (P-0748) must route through
  // `mobileGate.handle`, never through callMcpTool directly.
  activeMobileGate = new MobileGate({
    deviceStore: mobileDeviceStore,
    dispatch: (method, params, ctx) =>
      localhostMcpServer.dispatchForPeer(method, asRecord(params), ctx),
    rateLimiter: createDefaultMobileRateLimiter(),
    sessionLookup: sessionManager,
  });

  // The rolling record of chat messages fanned out to phones, so a phone that
  // was offline — or an app whose process lost its in-memory threads — refetches
  // what it missed when its link next comes up. Created near the recycle bin
  // wiring above (its purge paths own the journal's session-lifetime pruning).

  // The phone as a chat surface, and the ONE path an inbound phone call takes to
  // a tool. The gate is resolved through getMobileGate() rather than captured, so
  // there is a single instance and no way for a second one to appear.
  const mobileChatBridge = new MobileChatBridge({
    links: mobileLinkManager,
    deviceStore: mobileDeviceStore,
    gate: () => getMobileGate(),
    uploads: artifactUploadService,
    negotiatedProtocol: (machineId) => mobileLinkManager.negotiatedProtocol(machineId),
    sessions: {
      getSession: (sessionId) => {
        const session = sessionManager.getSession(sessionId);
        return session
          ? { id: session.id, name: session.name, interactionChannel: session.interactionChannel }
          : null;
      },
      // A phone message moves the conversation off the desktop — same value the
      // Telegram relay sets, so phone and Telegram are one "not at the desk".
      updateSession: (sessionId, patch) => sessionManager.updateSession(sessionId, patch),
    },
    journal: mobileChatJournal,
  });
  mobileChatBridge.start();
  chatBroker.register(mobileChatBridge);

  // Where to dial this desktop, pushed down the authenticated link (P-0752).
  // Without it the phone's address is a typed string that dies silently the day
  // the DHCP lease moves — and mDNS, which is how the fleet lane repairs that,
  // cannot cross a VPN.
  // Only the default-route address: virtual adapters (WSL, VirtualBox, VPN)
  // each cost the phone a dial timeout. See src/mobile/primary-lan-address.ts.
  const mobileAddressAdvertiser = new MobileAddressAdvertiser({
    links: mobileLinkManager,
    refresh: () => primaryLanAddress.refresh(),
    addresses: () => {
      const boundPort = mobileLanTransport.boundPort;
      // Nothing bound means an EMPTY list, which is itself the instruction to
      // stop dialling — not a reason to stay silent.
      return boundPort === null ? [] : primaryLanAddress.addresses(boundPort);
    },
    linkedMachines: () => mobileDeviceStore.list()
      .filter((device) => device.enabled !== false && mobileLinkManager.isOnline(device.machineId))
      .map((device) => device.machineId),
  });
  mobileAddressAdvertiser.start();

  // The phone's notification path: a state change, a notify_user or a flash
  // reaches a pocketed phone over the already-open BLE link. Fed in ADDITION to
  // Telegram, never instead of it — see docs/chat-fan-out.md.
  const mobileAlertNotifier = new MobileAlertNotifier(mobileChatBridge);
  notificationManager.setMobileNotifier(mobileAlertNotifier);
  const observeForAlerts = (session: ObservedSession) => mobileAlertNotifier.observe(session);
  const forgetForAlerts = (event: { sessionId: string }) => mobileAlertNotifier.forget(event.sessionId);
  sessionManager.on('session:updated', observeForAlerts);
  sessionManager.on('session:removed', forgetForAlerts);

  // An artifact an agent just wrote reaches the pocketed phone too, over the
  // same link and with the same fire-and-forget rules as a state alert.
  const mobileArtifactNotifier = new MobileArtifactNotifier(mobileChatBridge, artifactManager);
  const observeArtifactChange = (sessionId: string, artifactIds: string[]) =>
    mobileArtifactNotifier.changed(sessionId, artifactIds);
  const observeArtifactReveal = (sessionId: string, artifactId: string) =>
    mobileArtifactNotifier.revealed(sessionId, artifactId);
  artifactManager.on('artifact:changed', observeArtifactChange);
  artifactManager.on('artifact:reveal', observeArtifactReveal);

  // Apply the persisted config now (starts the stack iff enabled).
  void fleetController.start()
    .catch((err) => logger.error(`[fleet] Failed to start peer transport: ${err}`));

  return {
    cleanup: async () => {
      // Latch shutdown first: everything below can kill PTYs, and a PTY dying
      // because the app is quitting must not be mistaken for a closed session.
      ptyManager.beginShutdown();
      if (telegramAutoStartTimer) clearTimeout(telegramAutoStartTimer);
      if (mcpStartTimer) clearTimeout(mcpStartTimer);
      cleanupTelegram();
      telegramModules.cleanup();
      cleanupSession();
      cleanupPromptTemplates();
      cancelAllPrompts();
      messNotifier?.dispose();
      cleanupMess();
      hookTracker.dispose();
      cleanupHandover();
      handoverDelivery.dispose();
      stateDetector.dispose();
      patternMatcher.dispose();
      notificationManager.dispose();
      ptyManager.killAll();
      await incomingWatcher.close();
      scheduledTaskManager.stop();
      // Await the socket close so the next instance can bind the fixed port.
      await localhostMcpServer.close();
      disposePairing();
      disposePeerManagement();
      disposeMobile();
      mobileAddressAdvertiser.dispose();
      sessionManager.off('session:updated', observeForAlerts);
      sessionManager.off('session:removed', forgetForAlerts);
      mobileChatBridge.stop();
      chatBroker.unregister(mobileChatBridge.provider);
      chatBroker.unregister(telegramModules.relayService.provider);
      await mobileLinkManager.stop();
      await fleetController?.stop();
      logger.info('[IPC] Cleanup complete');
    },
    sessionManager,
    ptyManager,
    incomingWatcher,
    windowManager,
    helmControlService,
    runtimeGroupManager,
  };
}
