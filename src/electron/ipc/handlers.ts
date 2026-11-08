/**
 * IPC Handler Orchestrator
 *
 * Creates shared dependencies and delegates to domain-specific handler modules.
 * This is the single entry point called from main.ts — individual handler files
 * are never imported directly by the application.
 */

import { randomUUID } from 'node:crypto';
import { BrowserWindow, app, dialog, ipcMain, net, powerMonitor } from 'electron';
import { getMessageFlightTimeoutMs, type SessionMessageFlight } from '../../session/message-flight.js';
import { SessionManager } from '../../session/manager.js';
import { PtyManager } from '../../session/pty-manager.js';
import { StateDetector } from '../../session/state-detector.js';
import { PipelineQueue } from '../../session/pipeline-queue.js';
import { NotificationManager } from '../../session/notification-manager.js';
import { getGlobalPersistencePaths } from '../../session/persistence-paths.js';
import { HandoverDelivery } from '../../session/handover-delivery.js';
import { deliverPromptSequenceToSession } from '../../session/sequence-delivery.js';
import { ChatBroker } from '../../session/chat/chat-broker.js';
import { createProfileChatBrokerOptions } from '../../session/chat/profile-chat-broker-options.js';
import { setupHandoverHandlers } from './handover-handlers.js';
import { RuntimeGroupManager } from '../../session/runtime-group-manager.js';
import { saveRuntimeGroups, loadRuntimeGroups } from '../../session/runtime-group-persistence.js';
import { saveArtifacts, loadArtifacts } from '../../session/artifact-persistence.js';
import { pruneOrphanArtifacts } from '../../session/artifact-orphan-prune.js';
import type { Draft } from '../../types/draft.js';
import type { SessionInfo, SessionUpdatedEvent } from '../../types/session.js';
import { createDraftStore } from '../../session/draft-persistence.js';
import { createTodoStore } from '../../session/todo-persistence.js';
import type { SessionTodosChanged } from '../../types/todo.js';
import { ArtifactTempRegistry, attachSessionTempCleanup } from '../../session/artifact-temp-registry.js';
import { setupPowerMonitor } from '../../session/power-monitor.js';
import { ConfigLoader } from '../../config/loader.js';
import { keyboard } from '../../output/keyboard.js';
import { logger } from '../../utils/logger.js';
import { ApiSessionHost, registerApiSessionHost } from '../../session/api/api-session-host.js';
import { ComfyUiSessionHost, getComfyUiSessionHost, registerComfyUiSessionHost } from '../../session/comfyui/comfyui-session-host.js';
import { formatManifestoContext } from '../../session/artifact-context.js';
import { appendSessionTodoContext } from '../../session/todo-context.js';
/** Skill type whose reviews collect request_tool wishes from API-tool sessions. */
const API_TOOL_REQUESTS_SKILL_TYPE = 'api-tool-requests';
import { MCP_TOOLS } from '../../mcp/tools/definitions.js';

import { setupSessionHandlers } from './session-handlers.js';
import { setupConfigHandlers } from './config-handlers.js';
import { setupAutoMemoryHandlers } from './auto-memory-handlers.js';
import { setupDreamingHandlers } from './dreaming-handlers.js';
import { setupToolsHandlers } from './tools-handlers.js';
import { setupKeyboardHandlers } from './keyboard-handlers.js';
import { setupSystemHandlers, cleanupWorkTempFiles } from './system-handlers.js';
import { setupUpdateHandlers } from './update-handlers.js';
import { setupOperatorHandlers } from './operator-handlers.js';
import { setupVoiceHandlers } from './voice-handlers.js';
import { setupChatHandlers } from './chat-handlers.js';
import { VoiceService } from '../../voice/voice-service.js';
import { DesktopVoiceBridge } from '../../voice/desktop-voice-bridge.js';
import { CapabilityDetector } from '../../session/capability-detector.js';
import { OperatorSessionManager } from '../../session/operator-session-manager.js';
import { spawnConfiguredSession } from '../../session/configured-session-spawn.js';
import { setupPtyHandlers, cancelAllPrompts } from './pty-handlers.js';
import { setupPlanHandlers } from './plan-handlers.js';
import { setupScheduledTaskHandlers } from './scheduled-task-handlers.js';
import { setupRecycleBinHandlers } from './recycle-bin-handlers.js';
import { setupRuntimeGroupHandlers } from './runtime-group-handlers.js';
import { setupArtifactHandlers } from './artifact-handlers.js';
import { setupDraftHandlers } from './draft-handlers.js';
import { setupTodoHandlers } from './todo-handlers.js';
import { setupMemoryHandlers } from './memory-handlers.js';
import { setupMessHandlers } from './mess-handlers.js';
import { phoneActivityTarget, setupTimeTrackingHandlers, statisticsQuery } from './time-tracking-handlers.js';
import { TimeTracker, SLOT_MS, SUBMIT_WEIGHT } from '../../session/time-tracker.js';
import { TimePersistence } from '../../session/time-persistence.js';
import { EtaTracker, etaWhereOf, sweepOverdueEtas } from '../../session/eta-tracker.js';
import { EtaPersistence } from '../../session/eta-persistence.js';
import { setDeliveryObserver } from '../../session/sequence-delivery.js';
import { setupProjectHandlers } from './project-handlers.js';
import { setupSkillHandlers } from './skill-handlers.js';
import { IncomingPlansWatcher } from '../../session/incoming-plans-watcher.js';
import { SuggestedPlanService } from '../../session/suggested-plan-service.js';
import { WindowManager } from '../window-manager.js';
import { HelmControlService } from '../../mcp/helm-control-service.js';
import { LocalhostMcpServer } from '../../mcp/localhost-mcp-server.js';
import { ProfileMcpRouter } from '../../mcp/profile-mcp-router.js';
import { ProfileMcpServiceFactory, createProfileRemoteService, createProfileRuntimeMcpServiceSet, bindProfileMcpServicesToMobile } from '../../mcp/profile-mcp-service-factory.js';
import { InboundCallGate } from '../../mcp/peer/inbound-call-gate.js';
import { peerIdFromProxySessionId } from '../../mcp/peer/proxy-identity.js';
import { FleetAccessSync } from '../../mcp/peer/fleet-access-sync.js';
import { FLEET_SESSIONS_METHOD } from '../../mcp/peer/fleet-sessions.js';
import { isRemoteMethod } from '../../session/remote/remote-protocol.js';
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
import { SocketLinkTransport, mobilePairingPort } from '../../mobile/lan/socket-link-transport.js';
import { loadNoble } from '../../mobile/ble/noble-adapter.js';
import { MobileGate, createDefaultMobileRateLimiter } from '../../mobile/mobile-gate.js';
import { MobileChatBridge } from '../../mobile/mobile-chat-bridge.js';
import { MobileArtifactUploadService } from '../../mobile/mobile-artifact-upload.js';
import { MobileShareInbox } from '../../mobile/mobile-share-inbox.js';
import { MobileChatJournal } from '../../mobile/mobile-chat-journal.js';
import { MobileAddressAdvertiser } from '../../mobile/mobile-address-advertiser.js';
import { PrimaryLanAddressResolver } from '../../mobile/primary-lan-address.js';
import { MobileAlertNotifier } from '../../mobile/mobile-alert-notifier.js';
import { MobileArtifactNotifier } from '../../mobile/mobile-artifact-notifier.js';

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
import { registerProfileSessionCleanup } from '../profile-session-cleanup.js';
import { PinnedCertStore } from '../../mcp/peer/pinned-cert-store.js';
import { SecretStore } from '../../mcp/peer/secret-store.js';
import { loadPeerPins, savePeerPins, loadPeerSecrets, savePeerSecrets } from '../../mcp/peer/peer-secret-persistence.js';
import { asRecord } from '../../mcp/tools/validation.js';
import { getConfigDir, getTempDir } from '../../utils/app-paths.js';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { HookReceiver } from '../../session/hooks/hook-receiver.js';
import { ensureOperatorHome } from '../../session/operator-home.js';
import { ContextInjector, RING_ME_PREFIX } from '../../session/hooks/context-injector.js';
import { getRingMemoryRequests } from '../../session/memory-idea-policy.js';
import { resolveContextLimits } from '../../session/context-limits.js';
import { openTaskLines } from '../../session/operator-tasks.js';
import { createRulesViaHooksFn } from '../../session/hooks/hook-capability.js';
import { createReminderDeliveryFn } from '../../session/reminder-delivery.js';
import { OperatorTaskWatcher } from '../../session/operator-task-watcher.js';
import { readHookIntegrationStatus, type HookInstallerDeps } from '../../session/hooks/hook-installer.js';
import { hostname } from 'node:os';
import { ProfileRuntimeComposition } from '../profile-runtime-composition.js';
import { UserProfileStore } from '../../config/user-profile-store.js';

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
  dirname: string | undefined,
  configLoader: ConfigLoader,
  options: IpcStartupOptions = {},
): { cleanup: () => Promise<void>; sessionManager: SessionManager; ptyManager: PtyManager; incomingWatcher: IncomingPlansWatcher; windowManager: WindowManager; helmControlService: HelmControlService; runtimeGroupManager: RuntimeGroupManager } {
  logger.info('[IPC] Registering handlers');
  const startupDelayMs = Math.max(0, options.startupDelayMs ?? 0);

  const windowManager = new WindowManager();

  // Clean up stale temp files from previous sessions
  if (dirname) {
    cleanupWorkTempFiles(dirname);
  }

  const ptyManager = new PtyManager();
  let helmControlService!: HelmControlService;
  let profileMcpRouter!: ProfileMcpRouter;
  let profileMcpServiceFactory!: ProfileMcpServiceFactory;
  let messageFlightSink!: (flight: SessionMessageFlight) => Promise<void> | void;
  const profileComposition = new ProfileRuntimeComposition({
    configLoader,
    userProfileStore: new UserProfileStore(configLoader.getGlobalConfigDir()),
    ptyManager,
  });
  const registry = profileComposition.registry;
  const activeRuntime = registry.getRequiredRuntime('1');
  const {
    configLoader: activeConfigLoader,
    projectStore,
    sessionManager,
    planManager,
    contextManager,
    artifactAttachmentManager,
    artifactManager,
    artifactTempRegistry,
    draftManager,
    todoManager,
    memoryPersistence,
    memoryAttachmentManager,
    memoryManager,
    scheduledTaskHistoryManager,
    scheduledTaskManager,
    recycleBinManager,
    runtimeGroupManager,
    skillManager,
    skillAnalyticsManager,
    messManager: activeMessManager,
    timeTracker,
    etaTracker,
    patternMatcher,
  } = activeRuntime;
  // IPC remains pinned to profile 1 until the profile selector ships.
  configLoader = activeConfigLoader;
  const stateDetector = new StateDetector();
  const pipelineQueue = new PipelineQueue();
  const notificationManager = new NotificationManager(windowManager, sessionManager, registry);

  // Power monitor with full session/PTY diagnostics and screen lock tracking
  const powerMonitorResult = setupPowerMonitor(powerMonitor, { sessionManager, ptyManager });
  notificationManager.setScreenLockChecker(powerMonitorResult.isScreenLocked);
  notificationManager.setActiveSessionIdGetter(() => sessionManager.getActiveSession()?.id ?? null);

  helmControlService = new HelmControlService(planManager, sessionManager, ptyManager, configLoader, activeRuntime.planAttachmentManager, contextManager, scheduledTaskManager, projectStore, skillManager, skillAnalyticsManager);
  profileComposition.bindQuickCompactHandler('1', async (sessionId, prompt) => {
    await helmControlService.quickCompactSession(sessionId, { handover: prompt });
  });
  helmControlService.setNotificationManager(notificationManager);
  helmControlService.setRuntimeGroupManager(runtimeGroupManager);
  helmControlService.sessionChangeFeed.attach(sessionManager);
  helmControlService.setArtifactManager(artifactManager, artifactAttachmentManager);
  helmControlService.setDraftManager(draftManager);
  helmControlService.setTodoManager(todoManager);
  // The phone's upload reassembler (protocol 4): slots opened by the gated
  // session_artifact_attachment_add, filled by binary blob records, committed
  // by session_artifact_attachment_commit into the SAME managed storage the
  // desktop's own imports use.
  const artifactUploadService = new MobileArtifactUploadService({
    attachments: artifactAttachmentManager,
    // Share-to-Helm: shared files land in the per-user tmp inbox; the path is typed into the session.
    shares: new MobileShareInbox(join(getTempDir(dirname ?? process.cwd()), 'inbox')),
  });
  helmControlService.setArtifactUploadService(artifactUploadService);
  helmControlService.setMemoryManager(memoryManager, memoryAttachmentManager, artifactTempRegistry);

  // The chat broker is an unbounded registry; new surfaces add one registration.
  // Fan-out through it is unconditional; see src/session/chat/chat-broker.ts.
  const chatBroker = new ChatBroker(createProfileChatBrokerOptions(registry, ptyManager));
  helmControlService.setChatBroker(chatBroker);

  // Message-flight gate: every enveloped session_send_text broadcasts a
  // flight to all windows; the paste is held until a renderer acks the
  // landing (the delivery service enforces the timeout release).
  // Rebound once the operator manager exists (after session restore), so the
  // flight sink can feed its open-relay tracking.
  let noteOperatorFlight: (flight: SessionMessageFlight) => void = () => {};
  const pendingFlightAcks = new Map<string, () => void>();
  ipcMain.handle('session:message-flight-ack', (_event, flightId: unknown) => {
    if (typeof flightId === 'string') {
      pendingFlightAcks.get(flightId)?.();
      pendingFlightAcks.delete(flightId);
    }
    return { ok: true };
  });
  messageFlightSink = flight => new Promise<void>(resolve => {
    noteOperatorFlight(flight);
    pendingFlightAcks.set(flight.flightId, resolve);
    for (const window of windowManager.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('session:message-flight', flight);
    }
    // Late-ack sanitation: drop the registry entry once the sender side has
    // certainly moved on, so the map cannot grow without bound.
    setTimeout(() => {
      if (pendingFlightAcks.get(flight.flightId) === resolve) pendingFlightAcks.delete(flight.flightId);
    }, getMessageFlightTimeoutMs() + 5000).unref?.();
  });
  helmControlService.setMessageFlightSink(messageFlightSink);

  // Restore sessions persisted from previous run
  const restoredCount = registry.all().reduce((total, runtime) => total + runtime.sessionManager.restoreSessions().length, 0);
  logger.info(`[IPC] Restored ${restoredCount} session(s) from previous run`);

  // Reclaim profile-local data that lost its owning live or recoverable session.
  for (const runtime of registry.all()) {
    const liveSessionIds = new Set(runtime.sessionManager.getAllSessions().map(s => s.id));
    const binSessionIds = new Set(runtime.recycleBinManager.list().map(e => e.sessionId));
    try {
      runtime.memoryManager.pruneOrphanedSessions(new Set([...liveSessionIds, ...binSessionIds]));
    } catch (error) {
      logger.error(`[IPC] Failed to prune orphaned memories for profile ${runtime.userProfileId}: ${error}`);
    }
    pruneOrphanArtifacts(
      Object.keys(runtime.artifactManager.exportAll()),
      liveSessionIds,
      binSessionIds,
      id => runtime.artifactManager.clearSession(id),
    );
    runtime.draftManager.pruneOrphans(new Set([...liveSessionIds, ...binSessionIds]));
    runtime.todoManager.pruneOrphans(new Set([...liveSessionIds, ...binSessionIds]));
    const allArtifactIds = new Set(
      Object.values(runtime.artifactManager.exportAll()).flat().map(a => a.id),
    );
    runtime.artifactAttachmentManager.pruneOrphans(allArtifactIds);
  }

  // PlanManager loads from disk in its constructor — no explicit importAll needed

  const incomingWatcher = new IncomingPlansWatcher(
    planManager,
    new SuggestedPlanService(planManager, memoryManager),
    activeRuntime.configDir,
  );
  // The shim is seeded into the user config dir alongside the other shipped
  // defaults; the installer writes CLI configs that point HERE at it. Shared by
  // the settings handlers (below) and the G4 rules-via-hooks capability check.
  const hookDeps: HookInstallerDeps = {
    homeDir: () => homedir(),
    shimPath: join(getGlobalPersistencePaths(getConfigDir(dirname ?? process.cwd())).hooksDir, 'helm-hook-shim.py'),
  };
  // G1 transport + G2 enforcement: receives CLI lifecycle hooks on POST /hooks,
  // correlates them by session token, logs them, and routes PreToolUse through
  // the deny policy. Session/rules lookups are live reads — no cached policy
  // state — and every failure inside them fails open to allow. The G4
  // responder (ContextInjector) is bound after construction below — it needs
  // managers built later in this setup.
  const hookReceiver = new HookReceiver({
    getSession: (sessionId) => registry.findSessionOwner(sessionId)?.sessionManager.getSession(sessionId) ?? null,
    getDenyRules: (provider) => configLoader.getHookDenyRules(provider),
  });
  // G4 dual-path capability: does a recipient session inject its inter-session
  // rules via hooks (so the prepended header can be skipped)? Read live, on
  // disk, shared by the MCP delivery service. A check
  // that fails answers false — prepend as today, never break delivery.
  const rulesViaHooks = createRulesViaHooksFn(
    (cliTypeId) => configLoader.getCliTypeEntry(cliTypeId),
    (hooks) => readHookIntegrationStatus(hooks, hookDeps),
  );
  const suggestionUsageByProfile = profileComposition.suggestionUsageByProfile;
  const suggestionServices = profileComposition.suggestionServices;
  const suggestionUsage = suggestionUsageByProfile.get('1')!;
  const localhostMcpServer = new LocalhostMcpServer(helmControlService, {
    enabled: configLoader.getMcpConfig().enabled,
    port: configLoader.getMcpConfig().port,
    token: configLoader.getMcpConfig().authToken,
    resolveCallerServices: auth => profileMcpServiceFactory.forCaller(auth),
    resolveSessionIdentity: id => profileMcpRouter.resolveSessionIdentity(id),
    // G5 usage feedback: correlate a fetch with a recent suggestion. Only
    // identifiable sessions land here; anonymous peers learn nothing.
    onItemFetched: (sessionId, type, id) => {
      let runtime;
      try { runtime = profileMcpRouter.runtimeForCaller({ sessionId }); } catch { return; }
      const workingDir = runtime.sessionManager.getSession(sessionId)?.workingDir;
      const projectId = workingDir ? runtime.planManager.getProjectIdForDirectory(workingDir) : null;
      suggestionUsageByProfile.get(runtime.userProfileId)?.recordFetch(sessionId, `${type}/${id}`, projectId);
    },
    onClaudeStatuslineUsage: (sessionId, cliSessionId, usage) =>
      profileComposition.includeStatuslineUsage(sessionId, cliSessionId, usage),
  }, ptyManager, hookReceiver);

  // API tools: Helm hosts the agent loop for CLI types with an `api` block.
  // Tools dispatch through the MCP server's own path under the session's identity.
  const apiSessionHost = new ApiSessionHost({
    dispatchTool: (name, args, auth) => localhostMcpServer.dispatchForPeer(name, args, auth),
    postChat: (sessionId, message, usage) => profileComposition.sendChatForSession(sessionId, message, usage),
    createMemory: (sessionId, input) => profileComposition.requireSessionOwner(sessionId).memoryManager.createForSession(sessionId, input),
    linkMemory: (sessionId, fromId, toId) => {
      profileComposition.requireSessionOwner(sessionId).memoryManager.linkForSession(sessionId, fromId, toId);
    },
    onPendingSubagents: (sessionId, count) => {
      registry.findSessionOwner(sessionId)?.sessionManager.updateSession(sessionId, { pendingSubagents: count || undefined });
    },
    mcpTools: () => MCP_TOOLS,
    listSkills: (sessionId, cwd, userProfileId) =>
      profileComposition.listSkillsForSession(userProfileId, sessionId, cwd),
    getMission: (sessionId) => registry.findSessionOwner(sessionId)?.sessionManager.getSession(sessionId)?.mission?.text,
    getManifestoContext: (sessionId) => {
      const owner = registry.findSessionOwner(sessionId);
      if (!owner) return '';
      return appendSessionTodoContext(
        formatManifestoContext(owner.artifactManager.getManifestosForSession(sessionId)),
        owner.todoManager.list(sessionId),
        owner.configLoader.getHookInjectionOverrides(),
      );
    },
    // Wishes land as reviews on one all-projects skill, where skill feedback is already read.
    recordToolRequest: ({ name, purpose, example }, auth) => {
      if (!auth.sessionId) throw new Error('API tool request must have a session identity');
      const owner = profileComposition.requireSessionOwner(auth.sessionId);
      const session = owner.sessionManager.getSession(auth.sessionId);
      if (!session) throw new Error(`Session not found: ${auth.sessionId}`);
      const skillId = owner.skillManager.resolveEffective(API_TOOL_REQUESTS_SKILL_TYPE)?.id
        ?? owner.skillManager.create({
          name: 'API tool requests',
          type: API_TOOL_REQUESTS_SKILL_TYPE,
          description: 'Tools that API-tool sessions asked for but do not exist yet. Each request is a review; build the popular ones.',
          body: 'Read this skill\'s feedback (skill_get_feedback) for requested tools: summary = name + purpose, improvement = example usage.',
          allProjects: true,
        }).id;
      owner.skillAnalyticsManager.addReview(skillId, {
        stars: 1,
        summary: `${name}: ${purpose}`,
        ...(example ? { improvement: example } : {}),
        cliName: session.name,
        cliType: session.cliType,
        timestamp: new Date().toISOString(),
      });
    },
    emitHook: (event) => hookReceiver.emit('hook', event),
    onContextUsageChanged: (sessionId) => profileComposition.refreshContextUsage(sessionId),
    // Bound lazily: the injector is built further down, after the managers it reads.
    promptContext: (sessionId, prompt, tools) => contextInjector.promptContext(sessionId, prompt, tools),
    // A record with an originId came in from the user; the rest are the session's own replies.
    chatHistory: (sessionId) => mobileChatJournal.sessionEntries(sessionId).map(({ seq, record }) => ({
      seq, at: record.at, fromUser: record.originId !== undefined, text: record.text,
    })),
    historyDir: activeRuntime.paths.apiSessionsDir,
    historyDirForProfile: userProfileId => profileComposition.getRequiredRuntime(userProfileId).paths.apiSessionsDir,
    // Bound lazily: the recorder needs the silent runner, which needs this host.
    recordTurn: (sessionId, history) => profileComposition.recordAutoMemoryTurn(sessionId, history),
  });
  registerApiSessionHost(apiSessionHost);
  profileComposition.registerAutoMemoryServices(apiSessionHost);
  helmControlService.setApiContextSizeLookup((sessionId) => apiSessionHost.getContextSize(sessionId));
  const cleanupSession = setupSessionHandlers(sessionManager, ptyManager, windowManager, configLoader, {
    // The user asked for it outright: never second-guessed as redundant.
    quickCompact: (sessionId) => helmControlService.quickCompactSession(sessionId, {}),
    switchCli: (sessionId, cliType) => helmControlService.switchSessionCli(sessionId, cliType),
    clone: (sessionId, cliType) => helmControlService.cloneSession(sessionId, cliType === undefined ? {} : { cliType }),
  });
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
    (key) => {
      const slash = key.indexOf('/');
      if (slash < 0) return null;
      const type = key.slice(0, slash);
      const id = key.slice(slash + 1);
      if (type === 'skill') {
        const skill = skillManager.get(id);
        return skill ? { name: skill.name, body: skill.body } : null;
      }
      const memory = type === 'memory' ? memoryManager.getRecord(id) : undefined;
      return memory ? { name: memory.tldr, body: memory.content } : null;
    },
  );
  setupAutoMemoryHandlers(configLoader, profileComposition.getRecordingModelRunner('1')!);
  setupDreamingHandlers(configLoader);
  setupToolsHandlers(configLoader);
  setupKeyboardHandlers(keyboard);
  setupSystemHandlers(dirname ?? process.cwd());
  setupUpdateHandlers({ tempDir: getTempDir(dirname ?? process.cwd()), modeStore: configLoader });

  // Voice operator singleton (docs/voice-operator.md). Runs after
  // restoreSessions, so a persisted operator is found and left for the
  // renderer's normal auto-resume; only a missing one is spawned here.
  // Rebound once HandoverDelivery exists further down; until then nothing is pending.
  let isHandoverPending: (sessionId: string) => boolean = () => false;
  const operatorSessionManager = new OperatorSessionManager({
    sessionManager,
    getConfig: () => configLoader.getOperatorConfig(),
    spawn: ({ cliType, cwd, sessionName, contextText, role, locked }) => spawnConfiguredSession({
      ptyManager,
      sessionManager,
      configLoader,
      cliType,
      cwd,
      sessionName,
      contextText,
      contextDeliveryContext: 'background',
      role,
      locked,
    }),
    clear: (sessionId, context) => helmControlService.clearSession(sessionId, { context }),
    isHandoverPending: (sessionId) => isHandoverPending(sessionId),
    homeDir: () => ensureOperatorHome(getConfigDir(dirname ?? process.cwd()), projectStore),
  });
  noteOperatorFlight = (flight) => operatorSessionManager.noteFlight(flight);
  setupOperatorHandlers(configLoader, operatorSessionManager);
  try {
    operatorSessionManager.ensure();
  } catch (error) {
    logger.error(`[IPC] Operator ensure failed: ${error}`);
  }
  setupProjectHandlers(projectStore, planManager, contextManager, windowManager, activeRuntime.planAttachmentManager);
  setupSkillHandlers(skillManager, skillAnalyticsManager);
  setupPlanHandlers(planManager, contextManager, windowManager, incomingWatcher, dirname, helmControlService.getSuggestedPlanService() ?? undefined, activeRuntime.planAttachmentManager);
  setupScheduledTaskHandlers(scheduledTaskManager, scheduledTaskHistoryManager, windowManager);
  // Time tracking: the session's Helm project, else its directory, gets the credit.
  const whereIsDir = (dir: string, projectId?: string) => {
    const project = (projectId ? projectStore.getById(projectId) : undefined) ?? projectStore.findByPath(dir);
    return project
      ? { projectKey: project.id, projectName: project.name, dir }
      : { projectKey: dir, projectName: dir, dir };
  };
  // Only user-originated prompts start a turn. System pings count only after a hook proves real work.
  setDeliveryObserver((sessionId, origin) => {
    registry.findSessionOwner(sessionId)?.timeTracker.recordPrompt(sessionId, origin);
  });
  stateDetector.on('activity-change', ({ sessionId, level }: { sessionId: string; level: string }) => {
    const owner = registry.findSessionOwner(sessionId);
    if (level === 'idle' && !stateDetector.hasObservedHooks(sessionId)) owner?.timeTracker.disarmAi(sessionId);
  });
  for (const runtime of registry.all()) {
    // Every context reading feeds its profile's token ledger; unchanged readings add nothing.
    runtime.sessionManager.on('session:updated', (session: SessionUpdatedEvent) => {
      if (!session.contextUsage || session.remote) return;
      runtime.timeTracker.recordTokens(session.id, session.contextUsage.tokens);
    });
    runtime.sessionManager.on('session:removed', ({ session }: { session: SessionInfo }) => {
      const ingest = profileComposition.subagentIngestors.get(runtime.userProfileId)!;
      ingest.sweep([session]);
      ingest.forget(session.id);
      runtime.timeTracker.forgetSession(session.id);
      runtime.patternMatcher.removeSession(session.id);
      if (session.eta && !session.remote) runtime.etaTracker.close(session.eta, etaWhereOf(session), 'unmarked');
    });
  }
  // Sub-agents run while the main context stands still, so their logs are swept on a timer of their own.
  const SUBAGENT_SWEEP_MS = 60_000;
  const sweepSubagents = () => {
    for (const runtime of registry.all()) {
      profileComposition.subagentIngestors.get(runtime.userProfileId)!.sweep(runtime.sessionManager.getAllSessions());
    }
  };
  const subagentSweepTimer = setInterval(sweepSubagents, SUBAGENT_SWEEP_MS);
  // Twice per slot, so an active session never skips one.
  const timeTrackerTimer = setInterval(() => {
    for (const runtime of registry.all()) runtime.timeTracker.tick();
  }, SLOT_MS / 2);
  // ETA accuracy: unmarked after ETA + 10m, or when the session closes with one open.
  helmControlService.setEtaTracker?.(etaTracker);
  const etaSweepTimer = setInterval(() => {
    for (const runtime of registry.all()) sweepOverdueEtas(runtime.sessionManager, runtime.etaTracker);
  }, 60_000);
  const cleanupTimeTracking = setupTimeTrackingHandlers(timeTracker, whereIsDir, () => configLoader.getCliTypes(), id => configLoader.getCliTypeLabel(id), etaTracker);
  // Keep lightweight handler fixtures (and embedders that do not enable
  // project services) compatible with the optional Mess surface.
  const messManager = activeMessManager;
  helmControlService.setMessManager(messManager);
  // Created here (not in the mobile block far below) so the recycle bin's
  // purge paths can prune it — the journal's retention is the session's
  // lifetime, and a purged session's replay dies with it.
  const mobileChatJournal = new MobileChatJournal({
    persist: saveMobileChatJournal,
    // The desktop Chat pane renders the same journal as the phone for every
    // session, in the main window and in every pop-out.
    onAppend: (entry) => {
      for (const win of windowManager.getAllWindows()) win.webContents.send('chat:entry', entry);
    },
  });
  mobileChatJournal.hydrate(loadMobileChatJournal());
  setupRecycleBinHandlers(
    recycleBinManager, artifactManager, windowManager, artifactTempRegistry, memoryManager, messManager ?? undefined, mobileChatJournal,
    // Restore reuses the original session id, so the mission lands back on the same session.
    (entry) => sessionManager.restoreMission(entry.sessionId, entry.mission, entry.missionBarHeight),
    draftManager,
    todoManager,
  );
  // Expired entries loaded from persisted state were not visible to the runtime
  // expiry event until now; dispatch them after cleanup listeners are attached.
  recycleBinManager.pruneExpired();
  setupRuntimeGroupHandlers(runtimeGroupManager, windowManager);
  setupArtifactHandlers(artifactManager, artifactAttachmentManager, windowManager, dirname, artifactTempRegistry);
  setupDraftHandlers(
    draftManager,
    (sessionId) => Boolean(sessionManager.getSession(sessionId)) || recycleBinManager.list().some(entry => entry.sessionId === sessionId),
  );
  setupTodoHandlers(
    todoManager,
    (sessionId) => Boolean(sessionManager.getSession(sessionId)) || recycleBinManager.list().some(entry => entry.sessionId === sessionId),
  );
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
  artifactManager.on('artifact:created', (sessionId: string) => {
    for (const win of artifactWindowsFor(sessionId)) {
      win.webContents.send('artifact:created', { sessionId });
    }
  });
  artifactManager.on('artifact:reveal', (sessionId: string, artifactId: string) => {
    for (const win of artifactWindowsFor(sessionId)) {
      win.webContents.send('artifact:reveal', { sessionId, artifactId });
    }
  });
  // The pad itself rides the event: an LLM edit shows in the pane without a second round trip.
  draftManager.on('draft:changed', (draft: Draft) => {
    for (const win of artifactWindowsFor(draft.sessionId)) {
      win.webContents.send('draft:changed', draft);
    }
  });
  todoManager.on('todos:changed', (change: SessionTodosChanged) => {
    for (const win of windowManager.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('todos:changed', change);
    }
  });
  setupPtyHandlers(
    ptyManager,
    stateDetector,
    sessionManager,
    pipelineQueue,
    windowManager,
    configLoader,
    notificationManager,
    (sessionId, data) => registry.findSessionOwner(sessionId)?.timeTracker.recordTerminalInput(sessionId, data),
    patternMatcher,
    recycleBinManager,
    (sessionId) => isHandoverPending(sessionId),
    registry,
  );
  // Carries a session's handover note across its own compaction: session_compact
  // arms the text while the context still exists, and it is pasted back once
  // the terminal falls silent after the compact command.
  const handoverDelivery = new HandoverDelivery(
    ptyManager,
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
    { nudge: sessionId => { ptyManager.write(sessionId, '\x1b\x1b\x1b', 'system'); } },
  );
  helmControlService.setHandoverDelivery(handoverDelivery);
  isHandoverPending = (sessionId) => {
    const owner = registry.findSessionOwner(sessionId);
    return owner ? profileComposition.handoverDeliveries.get(owner.userProfileId)?.isPending(sessionId) ?? false : false;
  };
  const cleanupHandover = setupHandoverHandlers(handoverDelivery, windowManager);

  profileComposition.registerProfileServices({
    stateDetector,
    notificationManager,
    hookReceiver,
    profileOneHandover: handoverDelivery,
    chatBroker,
    apiContextSize: sessionId => apiSessionHost.getContextSize(sessionId),
    onTurnEnded: (userProfileId, sessionId) => {
      void profileComposition.getCliAutoMemory(userProfileId)?.turnEnded(sessionId);
    },
  });
  const hookTrackers = profileComposition.hookTrackers;
  helmControlService.setCompactSnapshot(sessionId => {
    const owner = registry.findSessionOwner(sessionId);
    return owner ? hookTrackers.get(owner.userProfileId)?.snapshot(sessionId, 'quick compact') : undefined;
  });

  // G8 loop driving: the Stop-hook continuation brain. Fed by the same hook
  // stream (progress ticks, user turns, StopFailure) and by plan_complete's
  // completion notice (bound to the MCP server below — it is constructed
  // earlier than the managers this needs, hence the late binding). G10:
  // autoImplement on a plan is the only consent; the global
  // hooks.loopDriving.enabled kill switch (read live) is the only opt-out.
  const loopDrivers = profileComposition.loopDrivers;
  const loopDriver = loopDrivers.get('1')!;
  localhostMcpServer.setLoopDriver(loopDriver);

  // G4: the injection brain, bound to the receiver built above. SILENT for a
  // session without hook events — nothing here runs, so behaviour is exactly
  // as before. The suggester's candidates are built per prompt: skills visible
  // to the session's project (globals included), that project's live
  // (non-dormant) memories, and the asking session's own bound memories.
  // Pointers only, capped, once per item.
  //
  // G5: the suggester now runs on the boosted scorer above, and feeds the
  // usage store what was actually sent.
  const contextInjector = new ContextInjector({
    getSession: sessionId => registry.findSessionOwner(sessionId)?.sessionManager.getSession(sessionId) ?? null,
    getClaimedPlan: (sessionId) => {
      const owner = registry.findSessionOwner(sessionId);
      const plan = owner?.planManager.claimedPlanFor(sessionId);
      return plan ? { humanId: plan.humanId, title: plan.title, status: plan.status } : null;
    },
    getStartablePlans: (dirPath, sessionId) => {
      const owner = sessionId ? registry.findSessionOwner(sessionId) : undefined;
      return owner?.planManager.getStartableForDirectory(dirPath).map((plan) => ({
      humanId: plan.humanId, title: plan.title, status: plan.status,
      })) ?? [];
    },
    getHandover: sessionId => {
      const owner = registry.findSessionOwner(sessionId);
      return owner ? profileComposition.handoverDeliveries.get(owner.userProfileId)?.peek(sessionId) : undefined;
    },
    onHandoverInjected: sessionId => {
      const owner = registry.findSessionOwner(sessionId);
      owner && profileComposition.handoverDeliveries.get(owner.userProfileId)?.markDeliveredByHook(sessionId);
    },
    getManifestos: sessionId => registry.findSessionOwner(sessionId)?.artifactManager.getManifestosForSession(sessionId) ?? [],
    isIdeaPromptEnabled: () => configLoader.getAutoMemoryConfig().ideaPrompt,
    getMission: sessionId => registry.findSessionOwner(sessionId)?.sessionManager.getSession(sessionId)?.mission,
    getTodos: sessionId => registry.findSessionOwner(sessionId)?.todoManager.list(sessionId) ?? [],
    clearReportsTo: sessionId => registry.findSessionOwner(sessionId)?.sessionManager.updateSession(sessionId, { reportsTo: undefined }),
    getRingRequests: sessionId => {
      const owner = registry.findSessionOwner(sessionId);
      return owner ? getRingMemoryRequests(owner.memoryManager.listRecordsForSession(sessionId), RING_ME_PREFIX) : [];
    },
    getOpenTasks: (sessionId) => {
      const owner = registry.findSessionOwner(sessionId);
      const dir = owner?.sessionManager.getSession(sessionId)?.workingDir;
      return dir && owner ? openTaskLines(owner.planManager.getForDirectory(dir)) : [];
    },
    suggest: async (sessionId, prompt, projectId) => {
      const owner = registry.findSessionOwner(sessionId);
      return owner ? await suggestionServices.get(owner.userProfileId)!.suggest(sessionId, prompt, projectId) : null;
    },
    suggestTool: async (sessionId, query, projectId) => {
      const owner = registry.findSessionOwner(sessionId);
      return owner ? await suggestionServices.get(owner.userProfileId)!.suggestTool(sessionId, query, projectId) : null;
    },
    resetSuggestions: sessionId => {
      const owner = registry.findSessionOwner(sessionId);
      owner && suggestionServices.get(owner.userProfileId)?.resetSuggestions(sessionId);
    },
    resetToolSuggestionTurn: sessionId => {
      const owner = registry.findSessionOwner(sessionId);
      owner && suggestionServices.get(owner.userProfileId)?.resetToolSuggestionTurn(sessionId);
    },
    getProjectIdForDirectory: (dirPath, sessionId) => {
      const owner = sessionId ? registry.findSessionOwner(sessionId) : undefined;
      return owner?.planManager.getProjectIdForDirectory(dirPath) ?? null;
    },
    getReminderMode: (reminder) => configLoader.getReminderDelivery()[reminder],
    getContextLimits: (session) => {
      const owner = registry.getRequiredRuntime(session.userProfileId ?? '1');
      const cli = owner.configLoader.getCliTypeEntry(session.cliType);
      return resolveContextLimits(cli, session.contextUsage?.window ?? cli?.contextWindow);
    },
    getHookInjectionOverrides: () => configLoader.getHookInjectionOverrides(),
    loop: session => loopDrivers.get(session.userProfileId ?? '1'),
  });
  hookReceiver.setResponder(async event => {
    const owner = event.helmSessionId ? registry.findSessionOwner(event.helmSessionId) : undefined;
    return owner ? await contextInjector.respond(event) : null;
  });
  // A closed session takes its nudger and suggester ledgers with it — a
  // restored session (same id) starts with clean slates.
  registerProfileSessionCleanup(profileComposition, {
    forgetSessionState: (runtime, sessionId) => {
      contextInjector.forgetSession(sessionId);
      suggestionServices.get(runtime.userProfileId)?.forgetSession(sessionId);
      suggestionUsageByProfile.get(runtime.userProfileId)?.forgetSession(sessionId);
      loopDrivers.get(runtime.userProfileId)?.forgetSession(sessionId);
      profileComposition.getCliAutoMemory(runtime.userProfileId)?.forget(sessionId);
    },
    closeComfyUiSession: sessionId => getComfyUiSessionHost().closeSession(sessionId),
    pruneMobileJournal: sessionId => mobileChatJournal.pruneSession(sessionId),
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

  const cleanupMess = setupMessHandlers(messManager, projectStore, windowManager, sessionManager);

  sessionManager.on('session:added', async (event) => {
    // Push to renderer so it can adopt externally-spawned terminals.
    const win = windowManager.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:spawned-externally', event);
    }
  });
  sessionManager.on('session:updated', (event) => {
    const win = windowManager.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:updated', event);
    }

    const sessionWindowId = windowManager.getWindowIdForSession(event.id);
    if (sessionWindowId === undefined) return;
    const sessionWindow = windowManager.getWindow(sessionWindowId);
    if (sessionWindow && !sessionWindow.isDestroyed()) {
      sessionWindow.webContents.send('session:updated', event);
    }
  });
  logger.info('[IPC] All handlers registered');

  // Restore and schedule profile-local timers; the operator watcher remains on profile 1.
  profileComposition.startScheduledTasks();
  // After start(): the watcher's startup sweep reads the loaded timers.
  new OperatorTaskWatcher({
    onSessionUpdated: (fn) => { sessionManager.on('session:updated', fn); },
    onSessionRemoved: (fn) => { sessionManager.on('session:removed', fn); },
    onTimerChanged: (fn) => { scheduledTaskManager.on('task:changed', fn); },
    getSession: (id) => sessionManager.getSession(id),
    getPlan: (id) => planManager.getItem(id),
    patchPlanTask: (id, patch) => { planManager.updateWithType(id, { task: patch }); },
    listScheduledTasks: () => scheduledTaskManager.listTasks(),
    runTaskNow: (id) => scheduledTaskManager.runTaskNow(id),
    deleteTask: (id) => scheduledTaskManager.deleteTask(id),
  }).start();

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

  // Cross-machine fleet (P-0646) is a separate, opt-in listener. Inbound calls
  // pass the InboundCallGate before dispatch under a synthetic proxy identity.
  const peerConfigManager = new PeerConfigManager((peers) => savePeers(peers));
  peerConfigManager.importAll(loadPeers());

  // Shared trust stores connect pairing, transport, and peer management.
  const pinnedCertStore = new PinnedCertStore((pins) => savePeerPins(pins));
  pinnedCertStore.importAll(loadPeerPins());
  const secretStore = new SecretStore((secrets) => savePeerSecrets(secrets));
  secretStore.importAll(loadPeerSecrets());

  // Shared audit log for inbound calls and peer-management views.
  const peerAuditLog = new PeerAuditLog();
  // Remote session access uses the same trust gate and proxy identity.
  const createRemoteServiceForRuntime = (runtime: typeof activeRuntime) => createProfileRemoteService(runtime, {
    pty: ptyManager,
    canSendSessionsToPeer: peerId => peerConfigManager.get(peerId)?.enabled !== false
      && peerConfigManager.isInboundAllowed(peerId),
    cliTypeName: ref => {
      try {
        const config = runtime.configLoader.resolveCliType(ref)?.config;
        return config?.displayName || config?.name || undefined;
      } catch { return undefined; }
    },
  });
  const remoteService = createRemoteServiceForRuntime(activeRuntime);
  helmControlService.setRemoteService(remoteService);
  // Reports this machine's per-peer grant so each peer can show the direction.
  const fleetAccessSync = new FleetAccessSync(peerConfigManager);
  const inboundGate = new InboundCallGate({
    peerConfig: peerConfigManager,
    dispatch: async (method, params, ctx) => {
      const callerPeerId = peerIdFromProxySessionId(ctx.sessionId);
      if (method === FLEET_SESSIONS_METHOD && callerPeerId) {
        remoteService.handleSessionsNotification(callerPeerId, params);
        return { ok: true };
      }
      const remotePeerId = isRemoteMethod(method) ? peerIdFromProxySessionId(ctx.sessionId) : undefined;
      if (remotePeerId) return remoteService.handleCall(remotePeerId, method, params);
      return localhostMcpServer.dispatchForPeer(method, asRecord(params), ctx);
    },
    rateLimiter: createDefaultPeerRateLimiter(),
    audit: peerAuditLog,
    sessionLookup: sessionManager,
  });

  // FleetController owns live transport and discovery; IPC handlers register
  // once and read its current state through closures.
  const broadcastToRenderers = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };
  fleetController = new FleetController({
    getConfig: () => configLoader.getFleetConfig(),
    onCall: (peerId, method, params) => method === FLEET_SESSIONS_METHOD
      ? inboundGate.handleNotification(peerId, method, params)
      : inboundGate.handle(peerId, method, params),
    pinnedCertStore,
    secretStore,
    peerConfigManager,
    setLinkManager: (mgr) => {
      helmControlService.setPeerLinkManager(mgr);
      remoteService.setLinks(mgr);
      profileMcpServiceFactory?.setPeerLinkManager(mgr);
      fleetAccessSync.setLinks(mgr);
    },
    // The machine's own hostname — two Helms both advertising "Helm" is useless
    // in a pick-your-peer list.
    alias: hostname(),
    broadcast: broadcastToRenderers,
  });

  // Pairing IPC delegates to the live controller and is inert while fleet is off.
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
    attach: (peerId, sessionId) => remoteService.open(peerId, sessionId),
    spawn: (peerId, args) => remoteService.spawn(peerId, args),
    remoteService,
  });
  // Mobile pairing has separate device and secret stores from fleet trust.
  const mobileDeviceStore = new MobileDeviceStore((devices) => saveMobileDevices(devices));
  mobileDeviceStore.importAll(loadMobileDevices());
  profileMcpRouter = new ProfileMcpRouter(profileComposition, mobileDeviceStore);
  const mobileSecretStore = new SecretStore((secrets) => saveMobileSecrets(secrets));
  mobileSecretStore.importAll(loadMobileSecrets());
  const mobilePairing = new MobilePairing({
    deviceStore: mobileDeviceStore,
    secretStore: mobileSecretStore,
    machineId: hostname(),
  });
  // The manager owns BLE/LAN transport lifetimes and device presence. BLE loads
  // lazily; LAN settings are hot-applied through the retained transport.
  const mobileLanTransport = new SocketLinkTransport({
    ...configLoader.getMobileLanConfig(),
    logger: (message, error) =>
      error ? logger.warn(`[mobile-lan] ${message}: ${error}`) : logger.info(`[mobile-lan] ${message}`),
  });
  // LAN pairing supports desktops without reachable Bluetooth.
  const pairingLanConfig = () => {
    const lan = configLoader.getMobileLanConfig();
    return { ...lan, port: mobilePairingPort(lan.port) };
  };
  const mobilePairingTransport = new SocketLinkTransport({
    ...pairingLanConfig(),
    pairingOnly: true,
    logger: (message, error) =>
      error ? logger.warn(`[mobile-lan-pairing] ${message}: ${error}`) : logger.info(`[mobile-lan-pairing] ${message}`),
  });
  const mobileLinkManager = new MobileLinkManager({
    createTransports: () => [new BleLinkClient({
      noble: loadNoble(),
      logger: (message, error) =>
        error ? logger.warn(`${message}: ${error}`) : logger.info(message),
    }), mobileLanTransport, mobilePairingTransport],
    deviceStore: mobileDeviceStore,
    secretStore: mobileSecretStore,
    pairing: mobilePairing,
    machineId: hostname(),
  });
  void mobileLinkManager.start()
    .catch((err) => logger.error(`[mobile] Failed to start the BLE link manager: ${err}`));
  // mobile_* tools share the renderer's coordinator for headless pairing.
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
    // Electron net follows release redirects and the system proxy.
    checkApkAsset: async (url) => {
      const response = await net.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      return response.ok;
    },
    // Persist before hot-applying settings to the live transports.
    lan: {
      get: () => configLoader.getMobileLanConfig(),
      set: async (config) => {
        configLoader.setMobileLanConfig(config);
        await mobileLanTransport.configure(configLoader.getMobileLanConfig());
        await mobilePairingTransport.configure(pairingLanConfig());
        // Notify connected phones of the new port or disabled LAN state now.
        mobileAddressAdvertiser.advertiseAll();
      },
      boundPort: () => mobileLanTransport.boundPort,
      addresses: (port) => primaryLanAddress.addresses(port),
    },
  });
  const remoteServiceForRuntime = (runtime: typeof activeRuntime) => runtime.userProfileId === '1'
    ? remoteService
    : createRemoteServiceForRuntime(runtime);
  profileMcpServiceFactory = new ProfileMcpServiceFactory(
    profileMcpRouter,
    { service: helmControlService, loopDriver, uploads: artifactUploadService, remoteService },
    runtime => createProfileRuntimeMcpServiceSet(runtime, {
      composition: profileComposition,
      ptyManager,
      notificationManager,
      chatBroker,
      messageFlightSink,
      apiContextSizeLookup: sessionId => apiSessionHost.getContextSize(sessionId),
      reminderDelivery,
      tempDir: getTempDir(dirname ?? process.cwd()),
      remoteServiceForRuntime,
      currentPeerLinkManager: () => fleetController?.currentLinkManager() ?? null,
    }),
  );
  for (const runtime of registry.all()) profileMcpServiceFactory.forRuntime(runtime);
  activeMobileGate = new MobileGate({
    deviceStore: mobileDeviceStore,
    profileExists: id => {
      try { profileMcpRouter.runtimeForProfile(id); return true; } catch { return false; }
    },
    dispatch: async (method, params, ctx) => {
      const result = await localhostMcpServer.dispatchForPeer(method, asRecord(params), ctx);
      // A phone action that changed something is the user working (docs/time-tracking.md).
      const runtime = profileMcpRouter.runtimeForCaller(ctx);
      const target = phoneActivityTarget(method, params, id => runtime.planManager.getItem(id)?.dirPath ?? null, result);
      if (target && 'sessionId' in target) runtime.timeTracker.recordUser(SUBMIT_WEIGHT, target.sessionId);
      else if (target) runtime.timeTracker.recordUserAt(SUBMIT_WEIGHT, whereIsDir(target.dirPath));
      return result;
    },
    rateLimiter: createDefaultMobileRateLimiter(),
    sessionLookup: sessionManager,
    sessionLookupForProfile: id => profileComposition.getRequiredRuntime(id).sessionManager,
    restartHelm: (resume, profileId) => profileMcpServiceFactory.forProfile(profileId).service.restartHelm(resume),
    ringAnswered: (sessionId, deviceId) => {
      const profileId = deviceId ? mobileDeviceStore.get(deviceId)?.userProfileId : undefined;
      if (profileId) profileMcpServiceFactory.forProfile(profileId).service.ringAnswered(sessionId);
      else profileMcpServiceFactory.all().forEach(set => set.service.ringAnswered(sessionId));
    },
    timesheet: (params, profileId) => {
      const runtime = profileComposition.getRequiredRuntime(profileId ?? '1');
      return statisticsQuery(runtime.timeTracker, params, runtime.configLoader.getCliTypes(),
        id => runtime.configLoader.getCliTypeLabel(id), runtime.etaTracker);
    },
  });

  // The bridge is the phone chat surface; all inbound tool calls use the gate.
  const mobileChatBridge = new MobileChatBridge({
    links: mobileLinkManager,
    // A deleted bubble of an API session also leaves the model's history.
    onMessagesDeleted: (sessionId, removed) => apiSessionHost.forgetMessages(
      sessionId,
      removed.map((entry) => ({ text: entry.record.text, fromUser: entry.record.originId !== undefined })),
    ),
    deviceStore: mobileDeviceStore,
    gate: () => getMobileGate(),
    uploads: artifactUploadService,
    uploadsForDevice: deviceId => {
      const profileId = mobileDeviceStore.get(deviceId)?.userProfileId;
      return profileId ? profileMcpServiceFactory.forProfile(profileId).uploads : undefined;
    },
    negotiatedProtocol: (machineId) => mobileLinkManager.negotiatedProtocol(machineId),
    sessionFeeds: () => profileMcpServiceFactory.sessionFeeds(),
    sessionFeedForProfile: profileId => profileMcpServiceFactory.forProfile(profileId).service.sessionChangeFeed,
    profileForSession: sessionId => profileMcpRouter.profileForSession(sessionId),
    sessions: {
      getSession: (sessionId) => {
        const owner = registry.findSessionOwner(sessionId);
        const session = owner?.sessionManager.getSession(sessionId);
        return session
          ? { id: session.id, name: session.name, interactionChannel: session.interactionChannel }
          : null;
      },
      // A phone message moves the conversation off the desktop.
      updateSession: (sessionId, patch) => {
        const owner = registry.findSessionOwner(sessionId);
        return owner?.sessionManager.updateSession(sessionId, patch);
      },
    },
    journal: mobileChatJournal,
  });
  bindProfileMcpServicesToMobile(profileMcpServiceFactory.all(), mobileChatBridge);
  const mobileAlertNotifier = new MobileAlertNotifier(mobileChatBridge);
  mobileChatBridge.setChatMessageObserver(sessionId => mobileAlertNotifier.recordChatMessage(sessionId));

  registerComfyUiSessionHost(new ComfyUiSessionHost({
    tempDir: getTempDir(dirname ?? process.cwd()),
    storesForProfile: userProfileId => profileComposition.storesForProfile(userProfileId),
    onAttachmentDeleted: (sessionId, artifactId, attachmentId) =>
      mobileChatBridge.deleteAttachmentMessages(sessionId, artifactId, attachmentId),
    postChat: async (sessionId, text, attachment) => {
      await chatBroker.send({
        sessionId,
        text,
        ...(attachment?.filePath ? { filePath: attachment.filePath } : {}),
        ...(attachment ? { attachment } : {}),
      });
    },
    recordPrompt: (sessionId, text) => mobileChatBridge.recordDesktopTurn(sessionId, text, randomUUID()),
    notifyRequester: async (requesterSessionId, comfySessionId, text) => {
      const senderOwner = registry.findSessionOwner(comfySessionId);
      const sender = {
        senderSessionId: comfySessionId,
        senderSessionName: senderOwner?.sessionManager.getSession(comfySessionId)?.name ?? 'ComfyUI',
      };
      await profileComposition.sendTextToSession(requesterSessionId, text, sender);
      // Follow up with Enter if the composer swallowed the atomic paste submit.
      await profileComposition.sendInputToSession(requesterSessionId, '{Enter}', { ...sender, verify: false });
    },
  }));
  mobileChatBridge.start();
  chatBroker.register(mobileChatBridge);
  // Desktop voice uses configured OpenWhispr/Piper tools and shares chat replies.
  const voiceTools = new CapabilityDetector(configLoader);
  chatBroker.register(new DesktopVoiceBridge({
    getOperatorId: () => operatorSessionManager.getOperatorId(),
    emitReply: (reply) => {
      const win = windowManager.getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('voice:operatorReply', reply);
    },
  }));
  setupVoiceHandlers({
    config: configLoader,
    voiceService: new VoiceService({
      getConfig: () => configLoader.getVoiceConfig(),
      getTools: () => voiceTools.getVoiceTools(),
      tempDir: getTempDir(dirname ?? process.cwd()),
    }),
    lastReply: () => {
      const operatorId = operatorSessionManager.getOperatorId();
      return operatorId ? mobileChatJournal.lastSessionMessage(operatorId) : null;
    },
    ask: async (text) => {
      const operatorId = operatorSessionManager.getOperatorId();
      if (!operatorId) return { ok: false, error: 'The Helm operator is off — enable it in Settings → Operator' };
      await deliverPromptSequenceToSession({ sessionId: operatorId, text, ptyManager, sessionManager, configLoader });
      mobileChatBridge.recordDesktopTurn(operatorId, text, randomUUID());
      return { ok: true };
    },
  });
  setupChatHandlers({
    history: sessionId => sessionManager.getSession(sessionId)
      ? mobileChatJournal.sessionEntries(sessionId)
      : [],
    deliver: async ({ sessionId, text, filePath }) => {
      const target = sessionManager.getSession(sessionId);
      if (!target) throw new Error(`Session not found: ${sessionId}`);
      if (target.comfyUiTool) {
        if (text.trim() === '/cancel') {
          if (filePath) throw new Error('Remove the attached file before cancelling a ComfyUI generation');
          if (!await getComfyUiSessionHost().cancel(target.id)) throw new Error('No ComfyUI generation is running');
        } else {
          getComfyUiSessionHost().submit(target.id, text, undefined, undefined, undefined, filePath);
        }
        const submittedAt = Date.now();
        sessionManager.updateSession(target.id, {
          lastPromptAt: submittedAt,
          lastUserPromptAt: submittedAt,
          lastUserPromptSource: 'chat',
        });
        return;
      }
      const prompt = filePath ? `${text}\r\n\r\n[Attached file: ${filePath}]` : text;
      await helmControlService.sendDesktopChatTextToSession(target.id, prompt);
    },
    fanOut: async message => { await chatBroker.send(message); },
  });

  // Advertise the default-route address so phones avoid virtual adapters and
  // retain a reachable endpoint when DHCP changes (P-0752).
  const mobileAddressAdvertiser = new MobileAddressAdvertiser({
    links: mobileLinkManager,
    refresh: () => primaryLanAddress.refresh(),
    addresses: () => {
      const boundPort = mobileLanTransport.boundPort;
      // An empty address list tells phones to stop dialing.
      return boundPort === null ? [] : primaryLanAddress.addresses(boundPort);
    },
    linkedMachines: () => mobileDeviceStore.list()
      .filter((device) => device.enabled !== false && mobileLinkManager.isOnline(device.machineId))
      .map((device) => device.machineId),
  });
  mobileAddressAdvertiser.start();

  // State changes and notify_user alerts reach phones over the open link.
  notificationManager.setMobileNotifier(mobileAlertNotifier);
  const disposeAlertObservers = mobileAlertNotifier.observeProfiles(registry.all());

  const disposeArtifactNotifiers = registry.all().map(runtime => {
    const notifier = new MobileArtifactNotifier(mobileChatBridge, runtime.artifactManager);
    const changed = (sessionId: string, artifactIds: string[]) => notifier.changed(sessionId, artifactIds);
    const revealed = (sessionId: string, artifactId: string) => notifier.revealed(sessionId, artifactId);
    runtime.artifactManager.on('artifact:changed', changed);
    runtime.artifactManager.on('artifact:reveal', revealed);
    return () => {
      runtime.artifactManager.off('artifact:changed', changed);
      runtime.artifactManager.off('artifact:reveal', revealed);
    };
  });

  // Apply the persisted config now (starts the stack iff enabled).
  void fleetController.start()
    .catch((err) => logger.error(`[fleet] Failed to start peer transport: ${err}`));

  return {
    cleanup: async () => {
      // Latch shutdown before PTY cleanup so exits are not treated as closed sessions.
      ptyManager.beginShutdown();
      if (mcpStartTimer) clearTimeout(mcpStartTimer);
      cleanupSession();
      cancelAllPrompts();
      cleanupMess();
      clearInterval(timeTrackerTimer);
      clearInterval(subagentSweepTimer);
      clearInterval(etaSweepTimer);
      setDeliveryObserver(null);
      sweepSubagents();
      cleanupTimeTracking();
      cleanupHandover();
      operatorSessionManager.dispose();
      mobileChatBridge.stop();
      chatBroker.unregister(mobileChatBridge.provider);
      profileMcpServiceFactory.dispose();
      disposeArtifactNotifiers.forEach(dispose => dispose());
      profileComposition.dispose();
      stateDetector.dispose();
      notificationManager.dispose();
      ptyManager.killAll();
      await incomingWatcher.close();
      // Await the socket close so the next instance can bind the fixed port.
      await localhostMcpServer.close();
      disposePairing();
      disposePeerManagement();
      disposeMobile();
      mobileAddressAdvertiser.dispose();
      disposeAlertObservers();
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
