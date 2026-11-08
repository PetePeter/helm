import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import type { ConfigLoader } from '../config/loader.js';
import type { UserProfileRecord, UserProfileStore } from '../config/user-profile-store.js';
import { HandoverDelivery } from '../session/handover-delivery.js';
import type { NotificationManager } from '../session/notification-manager.js';
import type { PtyManager } from '../session/pty-manager.js';
import { ProfileRuntimeRegistry } from '../session/profile-runtime-registry.js';
import type { StateDetector } from '../session/state-detector.js';
import { AutoFreezer } from '../session/auto-freezer.js';
import { KeepWarmer } from '../session/keep-warmer.js';
import { MessNotifier } from '../session/mess-notifier.js';
import { SessionContextUsageTracker } from '../session/session-context-usage-tracker.js';
import { resolveSessionContextSize, type ApiSessionContextSize } from '../session/context-size.js';
import { dormantAfterMs } from '../session/prompt-staleness.js';
import type { SessionRemovedEvent } from '../types/session.js';
import { deliverPromptSequenceToSession } from '../session/sequence-delivery.js';
import type { HookReceiver } from '../session/hooks/hook-receiver.js';
import { HookTracker } from '../session/hooks/hook-tracker.js';
import { LoopDriver } from '../session/hooks/loop-driver.js';
import { Bm25SuggestionScorer, BoostedSuggestionScorer, SuggestionService } from '../session/hooks/suggestion-scorer.js';
import { createSuggestionCandidateSource } from '../session/hooks/suggestion-candidates.js';
import { SuggestionUsageStore } from '../session/hooks/suggestion-usage-store.js';
import { HelmSessionDeliveryService } from '../mcp/services/helm-session-delivery-service.js';
import { HelmChatService } from '../mcp/services/helm-chat-service.js';
import { AutoMemoryRecorder, splitTurns } from '../session/auto-memory-judge.js';
import { CliAutoMemory } from '../session/cli-auto-memory.js';
import { resolveConfiguredSpawnEnv } from '../session/configured-session-spawn.js';
import { HeadlessCliRunner } from '../session/headless-cli-runner.js';
import { apiSilentBackend, RecordingModelRunner } from '../session/silent-model-runner.js';
import { SubagentTokenIngest } from '../session/subagent-token-ingest.js';
import type { ApiSessionHost } from '../session/api/api-session-host.js';
import type { ChatBroker } from '../session/chat/chat-broker.js';
import { getProfileConfigDir } from '../utils/app-paths.js';
import { createProfileRuntime } from './profile-runtime-factory.js';
import type { ProfileRuntime } from '../session/profile-runtime.js';

export interface ProfileRuntimeCompositionOptions {
  configLoader: ConfigLoader;
  userProfileStore: UserProfileStore;
  ptyManager: PtyManager;
}

export interface RegisterProfileServicesOptions {
  stateDetector: StateDetector;
  notificationManager: NotificationManager;
  hookReceiver: HookReceiver;
  profileOneHandover: HandoverDelivery;
  chatBroker: ChatBroker;
  apiContextSize: (sessionId: string) => ApiSessionContextSize;
  onTurnEnded: (userProfileId: string, sessionId: string) => void;
}

type QuickCompactHandler = (sessionId: string, prompt: string) => Promise<void>;

/** Owns the profile runtimes, their hook services, and their paired shutdown. */
export class ProfileRuntimeComposition {
  readonly registry = new ProfileRuntimeRegistry();
  readonly suggestionUsageByProfile = new Map<string, SuggestionUsageStore>();
  readonly suggestionServices = new Map<string, SuggestionService>();
  readonly hookTrackers = new Map<string, HookTracker>();
  readonly loopDrivers = new Map<string, LoopDriver>();
  readonly handoverDeliveries = new Map<string, HandoverDelivery>();
  readonly chatServices = new Map<string, HelmChatService>();
  readonly contextUsageTrackers = new Map<string, SessionContextUsageTracker>();
  readonly autoFreezers = new Map<string, AutoFreezer>();
  readonly keepWarmers = new Map<string, KeepWarmer>();
  readonly messNotifiers = new Map<string, MessNotifier>();
  readonly recordingModelRunners = new Map<string, RecordingModelRunner>();
  readonly autoMemoryRecorders = new Map<string, AutoMemoryRecorder>();
  readonly cliAutoMemories = new Map<string, CliAutoMemory>();
  readonly subagentIngestors = new Map<string, SubagentTokenIngest>();

  private readonly deliveryServices = new Map<string, HelmSessionDeliveryService>();
  private readonly quickCompactHandlers = new Map<string, QuickCompactHandler>();
  private readonly sessionListenerCleanup = new Map<string, Array<() => void>>();
  private readonly sessionRemovedProfiles = new Set<string>();
  private readonly ptyManager: PtyManager;
  private readonly rootConfigLoader: ConfigLoader;
  private readonly userProfileStore: UserProfileStore;
  private readonly appDataBase: string;
  private profileServices?: RegisterProfileServicesOptions;
  private autoMemoryHost?: ApiSessionHost;
  private sessionRemovedHandler?: (runtime: ProfileRuntime, event: SessionRemovedEvent) => void;
  private scheduledTasksStarted = false;
  private disposed = false;

  constructor(options: ProfileRuntimeCompositionOptions) {
    const { configLoader, userProfileStore, ptyManager } = options;
    this.ptyManager = ptyManager;
    this.rootConfigLoader = configLoader;
    this.userProfileStore = userProfileStore;
    userProfileStore.ensureDefaultProfile();
    this.appDataBase = dirname(dirname(configLoader.getGlobalConfigDir()));

    for (const profile of userProfileStore.list()) this.addRuntime(profile);
  }

  createProfile(name: string): UserProfileRecord {
    const profile = this.userProfileStore.create(name);
    try {
      this.addRuntime(profile);
      return profile;
    } catch (error) {
      if (this.registry.all().some(runtime => runtime.userProfileId === profile.id)) {
        this.removeProfileRuntime(profile.id);
      }
      this.userProfileStore.remove(profile.id);
      throw error;
    }
  }

  removeProfileRuntime(userProfileId: string): ProfileRuntime {
    if (userProfileId === '1') throw new Error('The default profile runtime cannot be removed');
    const runtime = this.registry.getRequiredRuntime(userProfileId);
    if (runtime.sessionManager.getAllSessions().length || runtime.recycleBinManager.list().length) {
      throw new Error('Close or remove this profile’s sessions before deleting it');
    }
    this.disposeRuntime(userProfileId);
    return this.registry.unregister(userProfileId)!;
  }

  private addRuntime(profile: UserProfileRecord): ProfileRuntime {
    const configDir = profile.id === this.rootConfigLoader.getUserProfileId()
      ? this.rootConfigLoader.getProfileConfigDir()
      : getProfileConfigDir(profile.id, this.appDataBase);
    const configLoader = profile.id === this.rootConfigLoader.getUserProfileId()
      ? this.rootConfigLoader
      : this.rootConfigLoader.createProfileView(profile.id, configDir);
    const runtime = createProfileRuntime({
      userProfileId: profile.id, configDir, configLoader, ptyManager: this.ptyManager,
      scheduledTaskOptions: { quickCompact: (id, prompt) => this.quickCompactSession(id, prompt) },
    });
    this.registry.register(runtime);

    const delivery = new HelmSessionDeliveryService(runtime.sessionManager, this.ptyManager, configLoader);
    this.deliveryServices.set(profile.id, delivery);
    this.quickCompactHandlers.set(profile.id, async (id, prompt) => {
      await delivery.quickCompactSession(id, { handover: prompt });
    });
    this.autoFreezers.set(profile.id, new AutoFreezer(runtime.sessionManager, cli => configLoader.getCliTypeEntry(cli)));
    this.keepWarmers.set(profile.id, new KeepWarmer(
      runtime.sessionManager,
      async (id, text) => {
        await deliverPromptSequenceToSession({
        sessionId: id, text, ptyManager: this.ptyManager, sessionManager: runtime.sessionManager, configLoader,
        });
      },
      cli => configLoader.getCliTypeEntry(cli),
    ));
    this.registerSuggestions(runtime);
    this.subagentIngestors.set(profile.id, new SubagentTokenIngest(runtime.timeTracker, !runtime.timeTracker.hasSavedBaselines));
    if (this.profileServices) this.registerProfileServices(this.profileServices);
    if (this.autoMemoryHost) this.registerAutoMemoryServices(this.autoMemoryHost);
    if (this.sessionRemovedHandler) this.registerSessionRemovedHandler(this.sessionRemovedHandler);
    if (this.scheduledTasksStarted) {
      runtime.scheduledTaskManager.start();
      this.autoFreezers.get(profile.id)?.start();
      this.keepWarmers.get(profile.id)?.start();
    }
    return runtime;
  }

  registerAutoMemoryServices(apiSessionHost: ApiSessionHost): void {
    if (this.autoMemoryHost && this.autoMemoryHost !== apiSessionHost) throw new Error('Auto-memory services already use another API host');
    this.autoMemoryHost = apiSessionHost;

    for (const runtime of this.registry.all()) {
      if (this.recordingModelRunners.has(runtime.userProfileId)) continue;
      const configLoader = runtime.configLoader;
      const runner = new RecordingModelRunner({
        getRecordingModel: () => configLoader.getAutoMemoryConfig().recordingModel,
        resolveModel: ref => {
          const resolved = configLoader.resolveCliType(ref);
          if (!resolved) return null;
          const env = resolveConfiguredSpawnEnv(configLoader, resolved.id);
          return resolved.config.api
            ? { id: resolved.id, kind: 'api', api: resolved.config.api, env }
            : { id: resolved.id, kind: 'cli', headlessCommand: resolved.config.headlessCommand, env };
        },
        backends: {
          api: apiSilentBackend(apiSessionHost),
          cli: new HeadlessCliRunner({
            pty: this.ptyManager,
            profileRuntime: runtime,
            getWorkDir: runId => {
              const projectDir = runtime.projectStore.list()
                .flatMap(project => [project.canonicalPath, ...(project.alternatePaths ?? [])])
                .find(path => {
                  try { return statSync(path).isDirectory(); }
                  catch { return false; }
                });
              return projectDir ? join(projectDir, '.helm-headless', runId) : '';
            },
          }),
        },
      });
      const recorder = new AutoMemoryRecorder({
        runner,
        isEnabled: () => configLoader.getAutoMemoryConfig().autoSave,
        getJudgePrompt: () => configLoader.getAutoMemoryConfig().judgePrompt,
        isLive: sessionId => runtime.sessionManager.hasSession(sessionId),
        getMission: sessionId => runtime.sessionManager.getSession(sessionId)?.mission?.text,
        listBound: sessionId => runtime.memoryManager.listBoundForSession(sessionId),
        create: (sessionId, memory) => {
          runtime.memoryManager.createForSession(sessionId, { ...memory, sessionBound: true });
        },
        update: (sessionId, id, memory) => { runtime.memoryManager.updateForSession(sessionId, id, memory); },
      });
      const cliAutoMemory = new CliAutoMemory({
        isEnabled: () => {
          const { autoSave, recordingModel } = configLoader.getAutoMemoryConfig();
          return autoSave && Boolean(recordingModel);
        },
        getTranscriptPath: sessionId => runtime.sessionManager.getSession(sessionId)?.cliTranscriptPath,
        record: (sessionId, turns) => recorder.recordTurns(sessionId, turns),
      });
      this.recordingModelRunners.set(runtime.userProfileId, runner);
      this.autoMemoryRecorders.set(runtime.userProfileId, recorder);
      this.cliAutoMemories.set(runtime.userProfileId, cliAutoMemory);
    }
  }

  getRecordingModelRunner(userProfileId: string): RecordingModelRunner | undefined {
    return this.recordingModelRunners.get(userProfileId);
  }

  recordAutoMemoryTurn(sessionId: string, history: Parameters<typeof splitTurns>[0]): void {
    const owner = this.registry.findSessionOwner(sessionId);
    const recorder = owner ? this.autoMemoryRecorders.get(owner.userProfileId) : undefined;
    if (recorder) void recorder.recordTurns(sessionId, splitTurns(history));
  }

  getCliAutoMemory(userProfileId: string): CliAutoMemory | undefined {
    return this.cliAutoMemories.get(userProfileId);
  }

  bindQuickCompactHandler(userProfileId: string, handler: QuickCompactHandler): void {
    this.registry.getRequiredRuntime(userProfileId);
    this.quickCompactHandlers.set(userProfileId, handler);
  }

  async quickCompactSession(sessionId: string, prompt: string): Promise<void> {
    const owner = this.registry.findSessionOwner(sessionId);
    if (!owner) throw new Error(`Cannot quick compact unknown session: ${sessionId}`);
    const handler = this.quickCompactHandlers.get(owner.userProfileId);
    if (!handler) throw new Error(`No quick compact service for profile ${owner.userProfileId}`);
    await handler(sessionId, prompt);
  }

  registerProfileServices(options: RegisterProfileServicesOptions): void {
    const { stateDetector, notificationManager, hookReceiver, profileOneHandover, chatBroker, apiContextSize, onTurnEnded } = options;
    if (this.profileServices && this.profileServices !== options) throw new Error('Profile services already use another dependency set');
    this.profileServices = options;

    for (const runtime of this.registry.all()) {
      const userProfileId = runtime.userProfileId;
      if (this.hookTrackers.has(userProfileId)) continue;
      const handover = userProfileId === '1'
        ? profileOneHandover
        : this.createHandoverDelivery(runtime, notificationManager);
      this.handoverDeliveries.set(userProfileId, handover);
      this.deliveryServices.get(userProfileId)?.setHandoverDelivery(handover);

      const chatService = new HelmChatService(runtime.configLoader, runtime.sessionManager);
      chatService.setChatBroker(chatBroker);
      this.chatServices.set(userProfileId, chatService);

      const contextUsageTracker = new SessionContextUsageTracker({
        sessionManager: runtime.sessionManager,
        resolve: session => {
          const cli = runtime.configLoader.getCliTypeEntry(session.cliType);
          return resolveSessionContextSize({
            cliTranscriptPath: session.cliTranscriptPath,
            provider: cli?.provider,
            apiTool: session.apiTool,
            comfyUiTool: session.comfyUiTool,
            remote: session.remote,
          }, {
            contextWindow: cli?.contextWindow,
            ...(session.apiTool ? { apiContext: apiContextSize(session.id) } : {}),
          });
        },
      });
      contextUsageTracker.start(hookReceiver);
      this.contextUsageTrackers.set(userProfileId, contextUsageTracker);

      const delivery = this.deliveryServices.get(userProfileId)!;
      this.messNotifiers.set(userProfileId, new MessNotifier(
        runtime.messManager,
        runtime.sessionManager,
        stateDetector,
        runtime.projectStore,
        delivery,
        sessionId => this.ptyManager.has(sessionId),
        sessionId => {
          const session = runtime.sessionManager.getSession(sessionId);
          if (session?.comfyUiTool) return false;
          const entry = runtime.configLoader.getCliTypeEntry(session?.cliType ?? '');
          return entry?.messReminders !== false && (!entry?.api || entry.api.allowedTools.includes('mess_check'));
        },
        { dormantAfterMs: sessionId => {
          const cliType = runtime.sessionManager.getSession(sessionId)?.cliType ?? '';
          return dormantAfterMs(runtime.configLoader.getCliTypeEntry(cliType));
        } },
      ));

      const syncSessionFreeze = (session: { id: string; frozen?: boolean }) => {
        stateDetector.setSessionFrozen(session.id, session.frozen === true);
      };
      runtime.sessionManager.on('session:added', syncSessionFreeze);
      runtime.sessionManager.on('session:updated', syncSessionFreeze);
      this.trackSessionCleanup(userProfileId, () => {
        runtime.sessionManager.off('session:added', syncSessionFreeze);
        runtime.sessionManager.off('session:updated', syncSessionFreeze);
      });

      const tracker = new HookTracker({
        stateDetector,
        sessionManager: runtime.sessionManager,
        planManager: runtime.planManager,
        flashAttention: sessionId => notificationManager.flashAttention(sessionId),
        handoverDelivery: handover,
        artifactManager: runtime.artifactManager,
        artifactAttachments: runtime.artifactAttachmentManager,
        onTurnWorking: sessionId => runtime.timeTracker.armAi(sessionId),
        onTurnEnded: sessionId => {
          runtime.timeTracker.disarmAi(sessionId);
          onTurnEnded(userProfileId, sessionId);
        },
      });
      tracker.watch(hookReceiver);
      this.hookTrackers.set(userProfileId, tracker);

      const driver = new LoopDriver({
        getSession: sessionId => runtime.sessionManager.getSession(sessionId),
        getPlan: planId => runtime.planManager.getItem(planId),
        updateSession: (sessionId, updates) => runtime.sessionManager.updateSession(sessionId, updates),
        flashAttention: sessionId => notificationManager.flashAttention(sessionId),
        getLoopConfig: () => runtime.configLoader.getLoopDrivingConfig(),
      });
      driver.watch(hookReceiver);
      this.loopDrivers.set(userProfileId, driver);
      this.deliveryServices.get(userProfileId)?.setCompactSnapshot(sessionId =>
        this.hookTrackers.get(userProfileId)?.snapshot(sessionId, 'quick compact'));
    }
  }

  registerSessionRemovedHandler(handler: (runtime: ProfileRuntime, event: SessionRemovedEvent) => void): void {
    if (this.sessionRemovedHandler && this.sessionRemovedHandler !== handler) throw new Error('A session removal handler is already registered');
    this.sessionRemovedHandler = handler;
    for (const runtime of this.registry.all()) {
      if (this.sessionRemovedProfiles.has(runtime.userProfileId)) continue;
      const onRemoved = (event: SessionRemovedEvent) => handler(runtime, event);
      runtime.sessionManager.on('session:removed', onRemoved);
      this.trackSessionCleanup(runtime.userProfileId, () => runtime.sessionManager.off('session:removed', onRemoved));
      this.sessionRemovedProfiles.add(runtime.userProfileId);
    }
  }

  startScheduledTasks(): void {
    if (this.scheduledTasksStarted) return;
    for (const runtime of this.registry.all()) {
      runtime.scheduledTaskManager.start();
      this.autoFreezers.get(runtime.userProfileId)?.start();
      this.keepWarmers.get(runtime.userProfileId)?.start();
    }
    this.scheduledTasksStarted = true;
  }

  getRequiredRuntime(userProfileId: string): ProfileRuntime {
    return this.registry.getRequiredRuntime(userProfileId);
  }

  listSkillsForSession(userProfileId: string | undefined, sessionId: string, cwd: string | undefined) {
    const owner = userProfileId
      ? this.registry.getRequiredRuntime(userProfileId)
      : this.registry.findSessionOwner(sessionId);
    if (!owner) return [];
    const session = owner.sessionManager.getSession(sessionId);
    const directory = cwd ?? session?.workingDir;
    const projectId = directory ? owner.planManager.getProjectIdForDirectory(directory) : null;
    return owner.skillManager.listForProject(projectId);
  }

  requireSessionOwner(sessionId: string): ProfileRuntime {
    const owner = this.registry.findSessionOwner(sessionId);
    if (!owner) throw new Error(`Unknown session owner: ${sessionId}`);
    return owner;
  }

  storesForProfile(userProfileId: string) {
    const runtime = this.registry.getRequiredRuntime(userProfileId);
    return { artifacts: runtime.artifactManager, attachments: runtime.artifactAttachmentManager };
  }

  sendChatForSession(sessionId: string, message: string, usage: import('../session/chat/chat-bridge.js').ChatTurnUsage) {
    const owner = this.requireSessionOwner(sessionId);
    return this.chatServices.get(owner.userProfileId)!.sendChat(sessionId, message, undefined, usage);
  }

  sendTextToSession(sessionId: string, text: string, options?: Parameters<HelmSessionDeliveryService['sendTextToSession']>[2]) {
    const owner = this.requireSessionOwner(sessionId);
    return this.deliveryServices.get(owner.userProfileId)!.sendTextToSession(sessionId, text, options);
  }

  sendInputToSession(
    sessionId: string,
    sequence: string,
    options?: Parameters<HelmSessionDeliveryService['sendInputToSession']>[2],
  ) {
    const owner = this.requireSessionOwner(sessionId);
    return this.deliveryServices.get(owner.userProfileId)!.sendInputToSession(sessionId, sequence, options);
  }

  includeStatuslineUsage(
    sessionId: string,
    cliSessionId: string,
    usage: { contextTokens: number; contextWindow?: number } | null,
  ): boolean {
    const owner = this.registry.findSessionOwner(sessionId);
    if (!owner) return false;
    const session = owner.sessionManager.getSession(sessionId);
    if (!session || session.remote || owner.configLoader.getCliTypeEntry(session.cliType)?.provider !== 'claude') return false;
    const tracker = this.contextUsageTrackers.get(owner.userProfileId);
    return usage
      ? tracker?.reportStatuslineUsage(sessionId, cliSessionId, usage.contextTokens, usage.contextWindow) ?? false
      : tracker?.clearStatuslineUsage(sessionId, cliSessionId) ?? false;
  }

  refreshContextUsage(sessionId: string): void {
    const owner = this.registry.findSessionOwner(sessionId);
    if (owner) this.contextUsageTrackers.get(owner.userProfileId)?.refreshSession(sessionId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanups of this.sessionListenerCleanup.values()) for (const cleanup of cleanups) cleanup();
    this.sessionListenerCleanup.clear();
    for (const tracker of this.hookTrackers.values()) tracker.dispose();
    for (const driver of this.loopDrivers.values()) driver.dispose();
    for (const tracker of this.contextUsageTrackers.values()) tracker.stop();
    for (const freezer of this.autoFreezers.values()) freezer.dispose();
    for (const warmer of this.keepWarmers.values()) warmer.dispose();
    for (const notifier of this.messNotifiers.values()) notifier.dispose();
    for (const handover of this.handoverDeliveries.values()) handover.dispose();
    this.recordingModelRunners.clear();
    this.autoMemoryRecorders.clear();
    this.cliAutoMemories.clear();
    this.subagentIngestors.clear();
    for (const runtime of this.registry.all()) runtime.dispose();
  }

  private trackSessionCleanup(userProfileId: string, cleanup: () => void): void {
    const cleanups = this.sessionListenerCleanup.get(userProfileId) ?? [];
    cleanups.push(cleanup);
    this.sessionListenerCleanup.set(userProfileId, cleanups);
  }

  private disposeRuntime(userProfileId: string): void {
    for (const cleanup of this.sessionListenerCleanup.get(userProfileId) ?? []) cleanup();
    this.sessionListenerCleanup.delete(userProfileId);
    this.sessionRemovedProfiles.delete(userProfileId);
    this.hookTrackers.get(userProfileId)?.dispose();
    this.loopDrivers.get(userProfileId)?.dispose();
    this.contextUsageTrackers.get(userProfileId)?.stop();
    this.autoFreezers.get(userProfileId)?.dispose();
    this.keepWarmers.get(userProfileId)?.dispose();
    this.messNotifiers.get(userProfileId)?.dispose();
    this.handoverDeliveries.get(userProfileId)?.dispose();
    const runtime = this.registry.getRequiredRuntime(userProfileId);
    runtime.dispose();
    this.hookTrackers.delete(userProfileId);
    this.loopDrivers.delete(userProfileId);
    this.contextUsageTrackers.delete(userProfileId);
    this.autoFreezers.delete(userProfileId);
    this.keepWarmers.delete(userProfileId);
    this.messNotifiers.delete(userProfileId);
    this.handoverDeliveries.delete(userProfileId);
    this.chatServices.delete(userProfileId);
    this.recordingModelRunners.delete(userProfileId);
    this.autoMemoryRecorders.delete(userProfileId);
    this.cliAutoMemories.delete(userProfileId);
    this.subagentIngestors.delete(userProfileId);
    this.suggestionUsageByProfile.delete(userProfileId);
    this.suggestionServices.delete(userProfileId);
    this.deliveryServices.delete(userProfileId);
    this.quickCompactHandlers.delete(userProfileId);
  }

  private registerSuggestions(runtime: ProfileRuntime): void {
    const { userProfileId } = runtime;
    const usage = new SuggestionUsageStore({ configDir: runtime.configDir });
    this.suggestionUsageByProfile.set(userProfileId, usage);
    const scorer = new BoostedSuggestionScorer(new Bm25SuggestionScorer(), {
      getMemoryEdges: () => runtime.memoryManager.listEdges(),
      getWorkspacePlanIds: sessionId => {
        const claimed = runtime.planManager.claimedPlanFor(sessionId);
        if (!claimed) return new Set<string>();
        const ids = new Set<string>([claimed.id]);
        if (claimed.projectId && claimed.sequenceId) {
          for (const item of runtime.planManager.getForProject(claimed.projectId)) {
            if (item.sequenceId === claimed.sequenceId) ids.add(item.id);
          }
        }
        const boundContexts = [
          ...runtime.contextManager.getContextsForPlan(claimed.id),
          ...(claimed.sequenceId ? runtime.contextManager.getContextsForSequence(claimed.sequenceId) : []),
        ];
        for (const context of boundContexts) {
          for (const planId of runtime.contextManager.getPlanIdsForContext(context.id)) ids.add(planId);
        }
        return ids;
      },
      usageBoost: (key, terms, projectId) => usage.boostFor(key, terms, projectId),
    }, runtime.configLoader.getSuggestionScoring());
    this.suggestionServices.set(userProfileId, new SuggestionService({
      getCandidates: createSuggestionCandidateSource({
        listSkills: projectId => runtime.skillManager.listForProject(projectId),
        listProjectMemories: projectId => runtime.memoryManager.listProjectRecords(projectId),
        listBoundMemories: sessionId => runtime.memoryManager.listBoundForSession(sessionId),
      }),
      memoriesEnabled: () => runtime.configLoader.getAutoMemoryConfig().autoRecall,
      scorer,
      onSuggested: (sessionId, keys, terms, projectId) => usage.noteSuggestion(sessionId, keys, terms, projectId),
    }));
  }

  private createHandoverDelivery(runtime: ProfileRuntime, notifications: NotificationManager): HandoverDelivery {
    const { sessionManager, configLoader } = runtime;
    return new HandoverDelivery(
      this.ptyManager,
      sessionManager,
      async (sessionId, text) => {
        await deliverPromptSequenceToSession({
          sessionId,
          text,
          ptyManager: this.ptyManager,
          sessionManager,
          configLoader,
          verifyDelivery: { label: 'handover', delayMs: 4000, retrySubmit: true },
        });
      },
      (sessionId, reason) => {
        const name = sessionManager.getSession(sessionId)?.name ?? sessionId;
        notifications.notifyLlmDirected(
          sessionId,
          'Handover lost',
          reason === 'cancelled'
            ? `The pending handover for "${name}" was cancelled and will not be delivered.`
            : reason === 'session-closed'
              ? `"${name}" closed before its handover could be delivered.`
              : `The handover for "${name}" could not be written to its terminal.`,
        );
      },
      { nudge: sessionId => { this.ptyManager.write(sessionId, '\x1b\x1b\x1b', 'system'); } },
    );
  }
}
