import type { ChatTurnUsage } from '../session/chat/chat-bridge.js';
import { EventEmitter } from 'node:events';
import { getPlanCleanupCounts, clearEmptySequences, clearUnreferencedContexts, type PlanCleanupCounts } from '../session/plan-cleanup.js';
import type { ConfigLoader } from '../config/loader.js';
import type { PlanManager } from '../session/plan-manager.js';
import type { SessionManager } from '../session/manager.js';
import { SessionChangeFeed, type SessionFeedCursor } from '../session/session-change-feed.js';
import type { PtyManager } from '../session/pty-manager.js';
import type { TerminalReadMode } from '../session/terminal-output-buffer.js';
import type { PlanFilter, PlanItem, PlanSequence, PlanStatus, PlanTask, PlanType } from '../types/plan.js';
import { nextCheckAt } from '../session/operator-tasks.js';
import type { PlanAttachment, PlanAttachmentTempFile } from '../types/plan-attachment.js';
import type { ReminderDeliveryFn } from '../session/reminder-delivery.js';
import type { Artifact, ArtifactIntent, ArtifactKind } from '../types/artifact.js';
import type {
  TelegramBridge,
  TelegramChannel,
  TelegramSendToUserResult,
  TelegramStatus,
} from '../types/telegram-channel.js';
import { PlanAttachmentManager } from '../session/plan-attachment-manager.js';
import type { NotificationManager } from '../session/notification-manager.js';
import { HelmSessionDeliveryService, type HandoverArming } from './services/helm-session-delivery-service.js';
import { HelmSessionService } from './services/helm-session-service.js';
import { HelmPlanService } from './services/helm-plan-service.js';
import { HelmPlanSequenceService } from './services/helm-plan-sequence-service.js';
import { HelmPlanAttachmentService } from './services/helm-plan-attachment-service.js';
import { HelmContextService } from './services/helm-context-service.js';
import { HelmTelegramService } from './services/helm-telegram-service.js';
import { HelmSchedulerService } from './services/helm-scheduler-service.js';
import { HelmProjectService } from './services/helm-project-service.js';
import { HelmDirectoryService } from './services/helm-directory-service.js';
import { HelmPeerService } from './services/helm-peer-service.js';
import { HelmMobileService, type MobileDeps } from './services/helm-mobile-service.js';
import { logger } from '../utils/logger.js';
import type { ScheduledTaskManager } from '../session/scheduled-task-manager.js';
import type { RingRetry } from '../session/ring-retry.js';
import type { CreateScheduledTaskParams, ScheduledTask, UpdateScheduledTaskParams } from '../types/scheduled-task.js';
import type { ContextBindingTargetType, ContextNode, ContextPermission, PlanContextRef } from '../types/context.js';
import type { ApiSessionContextSize, SessionContextSize } from '../session/context-size.js';
import type { Skill, SkillCreateInput, SkillReview, SkillSummary, SkillUpdateInput } from '../types/skill.js';
import { ContextManager } from '../session/context-manager.js';
import { SkillManager } from '../session/skill-manager.js';
import { SkillAnalyticsManager } from '../session/skill-analytics-manager.js';
import { getSessionInfo } from './guides/session-info-guide.js';
import { buildSessionSendTextGuide } from './guides/session-send-text-guide.js';
import { buildAgentPlanGuide } from './guides/agent-plan-guide.js';
import { buildNotificationGuide } from './guides/notification-guide.js';
import { buildTelegramGuide } from './guides/telegram-guide.js';
import { buildStartupGuide } from './guides/startup-guide.js';
import { buildMessGuide } from './guides/mess-guide.js';
import { buildDreamGuide } from './guides/dream-guide.js';
import { buildMemoriseGuide } from './guides/memorise-guide.js';
import { buildRecallGuide } from './guides/recall-guide.js';
import type { ProjectStore } from '../session/project-store.js';
import { CapabilityDetector } from '../session/capability-detector.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTempDir } from '../utils/app-paths.js';
import { sanitizeFilename } from '../session/artifact-temp-file.js';
import { createArtifactFromBytes, updateArtifactFromBytes } from '../session/artifact-file-import.js';
import {
  buildArtifactDownload,
  buildArtifactRead,
  type ArtifactDownload,
  type ArtifactDownloadBinary,
  type ArtifactRead,
} from '../session/artifact-download.js';
import type { ArtifactAttachmentManager } from '../session/artifact-attachment-manager.js';
import type { ArtifactAttachment } from '../types/artifact-attachment.js';
import { HelmMemoryService, type MemoryExportResult, type WrittenMemory } from './services/helm-memory-service.js';
import { HelmMessService } from './services/helm-mess-service.js';
import { MessManager } from '../session/mess-manager.js';
import type { MemoryAttachmentManager } from '../session/memory-attachment-manager.js';
import type { MemoryManager } from '../session/memory-manager.js';
import type {
  MemoryAttachment,
  MemoryAttachmentTempFile,
  MemoryDreamOptions,
  MemoryDreamResult,
  MemoryExportFormat,
  MemoryListOptions,
  MemoryRecord,
  MemoryEdgeType,
  MemorySearchResult,
  MemoryTraversal,
} from '../types/memory.js';
export { parseSubmitSuffix } from './submit-suffix.js';

/**
 * Ratings are only useful if they discriminate, so the footer explicitly licenses a low score.
 * Left to its own instincts an LLM rates almost everything 4-5, which makes the average noise.
 */
const SKILL_FEEDBACK_FOOTER = [
  '---',
  'Skill applied. Rate it honestly via skill_submit_feedback("{skillId}", stars, summary, improvement?).',
  'Give 1 star if it was useless, wrong, or got in your way; 5 only if it genuinely did the job.',
  'Do not be polite — inflated ratings make every rating worthless.',
  'Put the concrete failure or missing step in `improvement`.',
].join('\n');

/** `session_list` answered as a delta; see HelmControlService.listSessionChanges. */
export interface SessionListChanges {
  /** Identifies the sequence `seq` belongs to; changes when Helm restarts. */
  epoch: string;
  /** The cursor to pass as `since` next time. */
  seq: number;
  /** True when `sessions` is the whole list and the caller must replace, not merge. */
  full: boolean;
  /** The rows that changed — or every row, when `full`. */
  sessions: SessionSummary[];
  /** Ids that went away since the cursor. Always empty when `full`. */
  removed: string[];
}

export interface SessionSummary {
  id: string;
  name: string;
  /** UUID identity — pass it back verbatim; it is not meant to be shown to a human. */
  cliType: string;
  /** Human label for cliType. Use this in anything a person reads. */
  cliTypeName: string;
  workingDir?: string;
  /** Read only by session_get; session_list deliberately omits transcript-backed usage. */
  context?: SessionContextSize;
  /** Current local git branch; omitted for main/master and non-repositories. */
  gitBranch?: string;
  projectId?: string;
  projectPath?: string;
  state?: string;
  questionPending?: boolean;
  cliSessionName?: string;
  currentPlanId?: string;
  windowId?: number;
  /** Epoch MILLISECONDS when the session was first spawned. */
  createdAtEpochMs?: number;
  /** ISO-8601 rendering of createdAtEpochMs (convenience). */
  createdAtIso?: string;
  /** Epoch MILLISECONDS of when the activity dot last left green; reports "now" while currently active. */
  lastActiveAtEpochMs?: number;
  /** ISO-8601 rendering of lastActiveAtEpochMs (convenience). */
  lastActiveAtIso?: string;
  /**
   * Activity-dot level, derived purely from PTY I/O timing (invariant 8).
   * This is what a status dot must be drawn from — `state` is pipeline state and
   * means something else entirely. Exposed for remote surfaces (the paired
   * phone) that cannot see the renderer's own activity mirror.
   */
  activityLevel?: 'active' | 'inactive' | 'idle';
  /** AIAGENT phase state (planning, implementing, completed, idle). */
  aiagentState?: 'planning' | 'implementing' | 'completed' | 'idle';
  /** Remote Fleet peer that created this session, when spawned over the peer proxy. */
  createdByPeerId?: string;
  /** Set on a Remote row (`peer_attach`): the peer and ITS session id this row views. */
  remote?: { peerId: string; sessionId: string; machineName?: string };
  /** True when the session refuses all input (docs/session-freeze.md). */
  frozen?: boolean;
  /** Last prompt (epoch ms) — the clock the cache thresholds count from. */
  lastPromptAtEpochMs?: number;
  /** The CLI type's short / long prompt-cache windows, resolved to minutes. */
  cacheWarnMinutes?: number;
  cacheExpireMinutes?: number;
  /** The CLI type has no prompt cache (local model): never stale. */
  noPromptCache?: boolean;
  /** True when deliberate session closure is blocked. */
  locked?: boolean;
  /** Keep-warm is on until this epoch ms (absent when off or lapsed). */
  keepWarmUntilEpochMs?: number;
  /** The session's mission TL;DR, who set it, and when (epoch ms). */
  mission?: { text: string; setBy: 'user' | 'ai'; setAt: number };
  /** 'operator' marks the router-only "Helm" session. Voice clients (the
   *  phone's CallTarget) find the operator by this exact string. */
  role?: 'operator';
  /** An API-tool session (Helm-hosted agent loop). */
  apiTool?: boolean;
  comfyUiTool?: boolean;
  comfyUiProfiles?: Array<{ id: string; name: string; kind: 'image' | 'video'; supportsImageSize: boolean; maxReferenceImages: number }>;
  comfyUiImageSizes?: Array<{ id: string; name: string; width: number; height: number }>;
  /** A subagent: the session whose Agent call spawned it. Clients hide these rows. */
  subagentOf?: string;
  /** Subagents this session is waiting on — clients show a 🔥 count. */
  pendingSubagents?: number;
}

export interface CliSummary {
  cliType: string;
  name: string;
  command: string;
  kind?: 'cli' | 'api' | 'comfyui';
  supportsResume: boolean;
  supportedDirPaths: string[];
}

export interface McpToolSummary {
  name: string;
  title: string;
  description: string;
}

export interface DirectorySummary {
  dirPath: string;
  projectId?: string;
  name: string;
  /**
   * The owning project's name, when this directory belongs to one.
   *
   * Distinct from `name`: an ALTERNATE folder of a project carries its own name
   * (the folder) while sharing the project. A client that shows only `name`
   * cannot tell which project an alternate belongs to — which is exactly what
   * the phone's spawn form needs in order to say "project ▸ folder".
   */
  projectName?: string;
  source: Array<'config' | 'plans' | 'sessions'>;
  planCount: number;
  sessionCount: number;
}

export interface SessionTerminalTailResponse {
  sessionId: string;
  name: string;
  cliType: string;
  cliTypeName: string;
  workingDir?: string;
  returnedLines: number;
  ptyRunning: boolean;
  lastOutputAt?: number;
  raw?: string[];
  stripped?: string[];
  screen?: string[];
}

export interface SessionInfoResponse {
  your_session_id: string;
  your_working_dir: string;
  /** This session's mission TL;DR, or null when none is set (session_mission_set). */
  your_mission: { text: string; setBy: 'user' | 'ai'; setAt: number } | null;
  /** The caller's measured model context, when its session is known. */
  context?: SessionContextSize;
  helm_workflow: string;
  chat: string;
  artifact_viewer: string;
  durable_memory: {
    ownership: string;
    durability: string;
    recycle_bin: string;
    graph: string;
    search: string;
    attachments: string;
    tools: string[];
  };
  knowledge_model: {
    plan: string;
    sequence: string;
    context: string;
    memory: string;
  };
}

interface McpSkillSummary {
  id: string;
  name: string;
  /** When this skill should be triggered/applied (the skill's description text). */
  triggerCondition: string;
}

/**
 * Thin facade that delegates all MCP tool operations to domain-focused service classes.
 * The constructor signature and public method names are preserved for backward compatibility.
 */
export class HelmControlService extends EventEmitter {
  // Composed services
  private readonly sessionDelivery: HelmSessionDeliveryService;
  private readonly sessionService: HelmSessionService;
  /**
   * What changed in the session list, for `session_list` callers that pass a
   * cursor. The orchestrator attaches it to the session manager and hands the
   * same instance to the phone bridge, which announces its moves.
   */
  readonly sessionChangeFeed = new SessionChangeFeed();
  private readonly planService: HelmPlanService;
  private readonly planSequenceService: HelmPlanSequenceService;
  private readonly contextService: HelmContextService;
  private readonly planAttachmentService: HelmPlanAttachmentService;
  private readonly telegramService: HelmTelegramService;
  private phoneRinger: ((sessionId: string, reason: string) => boolean) | null = null;
  private callTransferrer: ((fromSessionId: string, toSessionId: string, line: string) => boolean) | null = null;
  private ringRetry: RingRetry | null = null;
  private notificationManager: NotificationManager | null = null;
  private artifactManager?: import('../session/artifact-manager.js').ArtifactManager;
  private artifactAttachmentManager?: ArtifactAttachmentManager;
  private artifactAttachmentDeleted?: (sessionId: string, artifactId: string, attachmentId: string) => void;
  private artifactUploadService?: import('../mobile/mobile-artifact-upload.js').MobileArtifactUploadService;
  private memoryService?: HelmMemoryService;
  private memoryManager: MemoryManager | null = null;
  private messService?: HelmMessService;
  private messManager: MessManager | null = null;
  private readonly schedulerService: HelmSchedulerService | null;
  private readonly projectService: HelmProjectService | null;
  private readonly directoryService: HelmDirectoryService;
  /** Fleet is OFF by default → no manager until setPeerLinkManager wires one. */
  private peerLinkManager?: import('./peer/peer-link-manager.js').PeerLinkManager | null;
  private remoteService: import('../session/remote/remote-service.js').RemoteService | null = null;
  private readonly peerService: HelmPeerService;
  /** Absent until the BLE stack is built and setMobileDeps wires it. */
  private mobileDeps?: MobileDeps | null;
  private readonly mobileService: HelmMobileService;
  private readonly skillManager: SkillManager;
  private readonly skillAnalyticsManager: SkillAnalyticsManager;
  private readonly capabilityDetector: CapabilityDetector;

  constructor(
    private readonly planManager: PlanManager,
    private readonly sessionManager: SessionManager,
    private readonly ptyManager: PtyManager,
    private readonly configLoader: ConfigLoader,
    private readonly attachmentManager: PlanAttachmentManager = new PlanAttachmentManager(planManager),
    private readonly contextManager: ContextManager = new ContextManager(planManager),
    schedulerManager?: ScheduledTaskManager,
    private readonly projectStore?: ProjectStore,
    skillManager?: SkillManager,
    skillAnalyticsManager?: SkillAnalyticsManager,
  ) {
    super();
    const getSkillsPath = (configLoader as ConfigLoader & { getSkillsPath?: () => string }).getSkillsPath;
    const getSkillAnalyticsPath = (configLoader as ConfigLoader & { getSkillAnalyticsPath?: () => string }).getSkillAnalyticsPath;
    this.skillManager = skillManager ?? new SkillManager(getSkillsPath ? getSkillsPath.call(configLoader) : 'src/config/skills.yaml');
    this.skillAnalyticsManager = skillAnalyticsManager ?? new SkillAnalyticsManager(getSkillAnalyticsPath ? getSkillAnalyticsPath.call(configLoader) : 'src/config/skill-analytics.json');

    // Register built-in system skills (detailed guidance fetched just-in-time via skill_get)
    this.skillManager.registerSystemSkill({
      id: 'sys-session-send-text',
      name: 'Session Send Text Guide',
      description: 'Inter-LLM handoff protocol via session_send_text. Fetch with skill_get(type: "session-send-text").',
      body: buildSessionSendTextGuide(),
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
      type: 'session-send-text',
      source: 'system',
    });
    this.skillManager.registerSystemSkill({
      id: 'sys-agent-plan',
      name: 'Agent Plan Guide',
      description: 'Plan management workflow guidance. Fetch with skill_get(type: "agent-plan").',
      body: buildAgentPlanGuide(),
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
      type: 'agent-plan',
      source: 'system',
    });
    this.skillManager.registerSystemSkill({
      id: 'sys-notification',
      name: 'Notification Guide',
      description: 'Notification routing guidance. Fetch with skill_get(type: "notification").',
      body: buildNotificationGuide(),
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
      type: 'notification',
      source: 'system',
    });
    this.skillManager.registerSystemSkill({
      id: 'sys-telegram',
      name: 'Telegram Voice & Attachment Guide',
      description: 'Telegram capabilities, voice memo workflows (openwhisper/piper/ffmpeg), and attachment format guide. Fetch with skill_get(type: "telegram").',
      body: buildTelegramGuide(),
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
      type: 'telegram',
      source: 'system',
    });

    this.skillManager.registerSystemSkill({
      id: 'sys-startup',
      name: 'Helm Startup Rules',
      description: 'Mandatory Helm workflow rules for AI agents. Fetch with skill_get(type: "startup").',
      body: buildStartupGuide(),
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
      type: 'startup',
      source: 'system',
    });
    this.skillManager.registerSystemSkill({
      id: 'sys-mess',
      name: 'Mess Guide',
      description: 'Agent-facing guidance for durable local project Mess. Fetch with skill_get(type: "mess").',
      body: buildMessGuide(),
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
      type: 'mess',
      source: 'system',
    });
    this.skillManager.registerSystemSkill({
      id: 'sys-dream',
      name: 'Dreaming Guide',
      description: 'Memory pruning and consolidation procedure for a scheduled dreaming run. Fetch with skill_get(type: "dreaming").',
      body: buildDreamGuide(),
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
      type: 'dreaming',
      source: 'system',
    });
    this.skillManager.registerSystemSkill({
      id: 'sys-memorise',
      name: 'Memorising Guide',
      description: 'How to record durable project memories. Fetch with skill_get(type: "memorising").',
      body: buildMemoriseGuide(),
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
      type: 'memorising',
      source: 'system',
    });
    this.skillManager.registerSystemSkill({
      id: 'sys-recall',
      name: 'Recalling Guide',
      description: 'How to retrieve durable project memories before starting work. Fetch with skill_get(type: "recalling").',
      body: buildRecallGuide(),
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
      type: 'recalling',
      source: 'system',
    });

    this.sessionDelivery = new HelmSessionDeliveryService(sessionManager, ptyManager, configLoader);
    this.sessionService = new HelmSessionService(sessionManager, ptyManager, configLoader, planManager, projectStore);
    this.planService = new HelmPlanService(planManager, configLoader, attachmentManager, this.contextManager, projectStore);
    this.planSequenceService = new HelmPlanSequenceService(planManager, configLoader, projectStore);
    this.contextService = new HelmContextService(this.contextManager, planManager, configLoader);
    this.planAttachmentService = new HelmPlanAttachmentService(planManager, attachmentManager);
    this.capabilityDetector = new CapabilityDetector(configLoader);
    this.telegramService = new HelmTelegramService(configLoader, sessionManager, this.capabilityDetector);
    this.schedulerService = schedulerManager ? new HelmSchedulerService(schedulerManager, configLoader, projectStore) : null;
    if (projectStore) this.setMessManager(new MessManager(sessionManager, projectStore));
    this.projectService = projectStore
      ? new HelmProjectService(projectStore, () => this.memoryManager, () => this.messManager)
      : null;
    this.directoryService = new HelmDirectoryService(configLoader, sessionManager, planManager, projectStore);
    this.peerService = new HelmPeerService(() => this.peerLinkManager ?? undefined);
    this.mobileService = new HelmMobileService(() => this.mobileDeps ?? undefined);
  }

  // ---------------------------------------------------------------------------
  // Telegram bridge / notification manager injection (mutates telegramService)
  // ---------------------------------------------------------------------------

  setTelegramBridge(bridge: TelegramBridge | null): void {
    this.telegramService.setTelegramBridge(bridge);
  }

  setNotificationManager(nm: NotificationManager): void {
    this.notificationManager = nm;
    this.telegramService.setNotificationManager(nm);
  }

  /** Wire chat fan-out so `telegram_chat` reaches every registered surface. */
  setChatBroker(broker: import('../session/chat/chat-broker.js').ChatBroker | null): void {
    this.telegramService.setChatBroker(broker);
  }

  /**
   * Wire the renderer message-flight gate: every enveloped session_send_text
   * broadcasts a flight and holds the paste until the renderer acks (or the
   * timeout releases it). See src/session/message-flight.ts.
   */
  setMessageFlightSink(sink: (flight: import('../session/message-flight.js').SessionMessageFlight) => Promise<void> | void): void {
    this.sessionDelivery.setMessageFlightSink(sink);
  }

  /** Wire the RuntimeGroupManager so session_create can place into runtime groups. */
  setRuntimeGroupManager(manager: import('../session/runtime-group-manager.js').RuntimeGroupManager): void {
    this.sessionService.setRuntimeGroupManager(manager);
  }

  /** Wire the ArtifactManager so the artifact_* MCP tools can produce session reports. */
  setArtifactManager(
    manager: import('../session/artifact-manager.js').ArtifactManager,
    attachmentManager?: ArtifactAttachmentManager,
  ): void {
    this.artifactManager = manager;
    this.artifactAttachmentManager = attachmentManager;
    this.sessionService.setSessionArtifactCopier((fromSessionId, toSessionId) => {
      for (const { from, to } of manager.copySession(fromSessionId, toSessionId)) {
        attachmentManager?.copyForArtifact(from, to);
      }
    });
  }

  /** Wire chat-journal cleanup after an artifact attachment is permanently deleted. */
  setArtifactAttachmentDeletedHandler(
    handler: ((sessionId: string, artifactId: string, attachmentId: string) => void) | null,
  ): void {
    this.artifactAttachmentDeleted = handler ?? undefined;
  }

  /**
   * Wire the phone-upload reassembler so the session-addressed attachment tools
   * can open and commit upload slots. Separate from the managers above because
   * it is stateful per upload, and only the phone ever speaks to it.
   */
  setArtifactUploadService(service: import('../mobile/mobile-artifact-upload.js').MobileArtifactUploadService): void {
    this.artifactUploadService = service;
  }

  /** Wire the durable, authenticated-session-scoped memory MCP facade. */
  setMemoryManager(
    manager: MemoryManager,
    attachmentManager: MemoryAttachmentManager,
    tempRegistry?: import('../session/artifact-temp-registry.js').ArtifactTempRegistry,
  ): void {
    this.memoryManager = manager;
    this.memoryService = new HelmMemoryService(
      manager,
      attachmentManager,
      tempRegistry,
      (planId) => {
        const plan = this.planManager.getItem(planId);
        return plan
          ? { id: plan.id, title: plan.title, state: plan.status, completed: plan.status === 'done' }
          : null;
      },
    );
  }

  /** Wire the durable, authenticated-session-scoped Mess facade. */
  setMessManager(manager: MessManager): void {
    this.messManager = manager;
    this.messService = new HelmMessService(manager, this.sessionManager);
  }

  getMessManager(): MessManager | null {
    return this.messManager;
  }

  /** Deliver an app-owned Mess reminder without an inter-session envelope. */
  sendSystemReminder(sessionRef: string, text: string, options?: { onVerification?: (verified: boolean) => void }): Promise<void> {
    return this.sessionDelivery.sendSystemReminder(sessionRef, text, options);
  }

  /**
   * Wire (or CLEAR, with null) the PeerLinkManager so the peer_* fleet tools
   * can reach remote peers. Passing a manager enables the tools; passing null (on a
   * live fleet disable, P-0658) reverts them to 'Fleet is not enabled'.
   */
  setPeerLinkManager(manager: import('./peer/peer-link-manager.js').PeerLinkManager | null): void {
    this.peerLinkManager = manager;
  }

  // ---------------------------------------------------------------------------
  // Fleet — remote peer tool invocation (peer_list / peer_tools / peer_call)
  // ---------------------------------------------------------------------------

  peerList() {
    return this.peerService.list();
  }

  peerTools(peer: string) {
    return this.peerService.tools(peer);
  }

  peerCall(peer: string, tool: string, args: Record<string, unknown>) {
    return this.peerService.call(peer, tool, args);
  }

  /** Wire the Remote service (viewer side of `peer_attach`). */
  setRemoteService(service: import('../session/remote/remote-service.js').RemoteService): void {
    this.remoteService = service;
  }

  peerAttach(peer: string, sessionId: string) {
    if (!this.remoteService) throw new Error('Remote is not available');
    return this.remoteService.open(peer, sessionId);
  }

  peerSpawn(peer: string, args: import('../session/remote/remote-service.js').RemoteSpawnArgs) {
    if (!this.remoteService) throw new Error('Remote is not available');
    return this.remoteService.spawn(peer, args);
  }

  // ---------------------------------------------------------------------------
  // Mobile — phone pairing and per-device grants (mobile_*). LOCAL AI ONLY: every
  // one of these is hard-denied to phones and peers, so a paired device can never
  // pair another or widen its own allow-list.
  // ---------------------------------------------------------------------------

  /**
   * Wire (or CLEAR, with null) the mobile stack so the mobile_* tools can drive
   * pairing. The BLE stack is built long after this service, hence a setter.
   */
  setMobileDeps(deps: MobileDeps | null): void {
    this.mobileDeps = deps;
  }

  mobilePairStart() {
    return this.mobileService.pairStart();
  }

  mobilePairStatus() {
    return this.mobileService.pairStatus();
  }

  mobilePairConfirm(accepted: boolean) {
    return this.mobileService.pairConfirm(accepted);
  }

  mobilePairCancel(reason?: string) {
    return this.mobileService.pairCancel(reason);
  }

  mobileDeviceList() {
    return this.mobileService.deviceList();
  }

  mobileDeviceAllow(deviceId: string, allow: string[]) {
    return this.mobileService.deviceAllow(deviceId, allow);
  }

  // ---------------------------------------------------------------------------
  // Artifacts (AI-authored, session-scoped renderable reports)
  // ---------------------------------------------------------------------------

  private requireArtifactManager(): import('../session/artifact-manager.js').ArtifactManager {
    if (!this.artifactManager) {
      throw new Error('Artifacts are not available: ArtifactManager is not configured.');
    }
    return this.artifactManager;
  }

  createArtifact(sessionId: string, title: string, kind: ArtifactKind, content: string, intent: ArtifactIntent = 'normal'): Artifact {
    return this.requireArtifactManager().create(sessionId, title, kind, content, undefined, undefined, intent);
  }

  createArtifactFromFile(
    sessionId: string,
    filePath: string,
    title?: string,
    contentType?: string,
    intent: ArtifactIntent = 'normal',
  ): ReturnType<typeof createArtifactFromBytes> {
    const input = readArtifactInputFile(filePath, contentType);
    return createArtifactFromBytes(
      this.requireArtifactManager(),
      this.requireArtifactAttachmentManager(),
      sessionId,
      input,
      title,
      'ai',
      true,
      intent,
    );
  }

  /**
   * Resolve an artifact and assert it belongs to the calling session. Artifacts
   * are session-scoped: a session must never read or mutate another session's
   * artifact by id-guessing, so a mismatch surfaces the same "not found" error
   * as a genuinely missing id (no cross-session existence leak).
   */
  private requireOwnedArtifact(callerSessionId: string, id: string): Artifact {
    const artifact = this.requireArtifactManager().get(id);
    if (!artifact || artifact.sessionId !== callerSessionId) {
      throw new Error(`Artifact not found: ${id}`);
    }
    return artifact;
  }

  /**
   * Revise an owned artifact: an optional rename and/or a new content version.
   * A title-only call renames WITHOUT appending a version — versions record
   * body history, and a rename is metadata. The rename is validated before any
   * mutation so a blank title never leaves a half-applied revision behind.
   */
  updateArtifact(callerSessionId: string, id: string, content: string | undefined, title?: string, intent?: ArtifactIntent): Artifact {
    this.requireOwnedArtifact(callerSessionId, id);
    const newTitle = title === undefined ? undefined : title.trim();
    if (newTitle === '') throw new Error('title must not be blank');
    if (content === undefined && newTitle === undefined && intent === undefined) throw new Error('content, title, or intent is required');
    const manager = this.requireArtifactManager();
    if (newTitle !== undefined) manager.rename(id, newTitle);
    if (content !== undefined) manager.update(id, content, intent);
    else if (intent !== undefined) manager.setIntent(id, intent);
    return this.requireOwnedArtifact(callerSessionId, id);
  }

  setArtifactIntent(callerSessionId: string, id: string, intent: ArtifactIntent): Artifact {
    this.requireOwnedArtifact(callerSessionId, id);
    this.requireArtifactManager().setIntent(id, intent);
    return this.requireOwnedArtifact(callerSessionId, id);
  }

  updateArtifactFromFile(
    callerSessionId: string,
    id: string,
    filePath: string,
    contentType?: string,
    intent?: ArtifactIntent,
  ): ReturnType<typeof updateArtifactFromBytes> {
    const artifact = this.requireOwnedArtifact(callerSessionId, id);
    const result = updateArtifactFromBytes(
      this.requireArtifactManager(),
      this.requireArtifactAttachmentManager(),
      artifact,
      readArtifactInputFile(filePath, contentType),
      intent,
    );
    return result;
  }

  showArtifact(callerSessionId: string, id: string): { id: string; revealed: true } {
    this.requireOwnedArtifact(callerSessionId, id);
    if (!this.requireArtifactManager().reveal(id)) {
      throw new Error(`Artifact not found: ${id}`);
    }
    return { id, revealed: true };
  }

  deleteArtifact(callerSessionId: string, id: string): { id: string; deleted: boolean } {
    this.requireOwnedArtifact(callerSessionId, id);
    return { id, deleted: this.requireArtifactManager().delete(id) };
  }

  /**
   * Delete ONE attachment without touching the artifact that holds it.
   *
   * The whole-artifact delete already removes every attachment with it; this is
   * the finer cut a chat file needs — binning one photo out of a thread should
   * not bin the thread's artifact. Same ownership rule as every artifact call:
   * an id belonging to another session answers not-found, and an unknown
   * attachment answers `deleted: false` rather than throwing, so a phone that
   * taps delete twice sees the second tap as "already gone", not an error.
   */
  deleteArtifactAttachment(
    callerSessionId: string,
    artifactId: string,
    attachmentId: string,
  ): { artifactId: string; attachmentId: string; deleted: boolean } {
    const artifact = this.requireOwnedArtifact(callerSessionId, artifactId);
    const deleted = this.requireArtifactAttachmentManager().delete(artifact.id, attachmentId);
    if (deleted) {
      try {
        this.artifactAttachmentDeleted?.(artifact.sessionId, artifact.id, attachmentId);
      } catch (error) {
        logger.warn(`[Artifact] Deleted attachment ${attachmentId}, but chat-history cleanup failed: ${error}`);
      }
    }
    return { artifactId: artifact.id, attachmentId, deleted };
  }

  /**
   * Move 1 of a phone upload: open a slot on an artifact this caller owns.
   *
   * The ownership rule is the one every artifact call makes — a cross-session
   * artifact id answers not-found — and the slot is then bound to the DEVICE
   * that opened it, so only that phone's slices may fill it and only that
   * phone's commit may finish it.
   */
  openArtifactAttachmentUpload(
    callerSessionId: string,
    deviceId: string,
    input: import('../mobile/mobile-artifact-upload.js').ArtifactUploadOpenInput,
  ): import('../mobile/mobile-artifact-upload.js').ArtifactUploadOffer {
    const artifact = this.requireOwnedArtifact(callerSessionId, input.artifactId);
    return this.requireArtifactUploadService().open(deviceId, { ...input, artifactId: artifact.id });
  }

  /**
   * Move 3 of a phone upload: verify the bytes and commit the attachment.
   * Throws unless every declared byte arrived and matched the sha256 the phone
   * declared at open time; the slot is dropped either way, so a retry starts
   * clean. No second ownership check: the slot was opened against an artifact
   * THIS caller already owned, and it is bound to the same device — a proxy
   * identity is stable per device, so the open-time check is the commit-time
   * check.
   */
  commitArtifactAttachmentUpload(
    callerSessionId: string,
    deviceId: string,
    uploadId: string,
  ): { artifactId: string; attachment: ArtifactAttachment } {
    void callerSessionId;
    const attachment = this.requireArtifactUploadService().commit(deviceId, uploadId);
    return { artifactId: attachment.artifactId, attachment };
  }

  /**
   * Move 1 of a phone SHARE: open a slot whose bytes will land in the named
   * session's draft. The session must exist; the slot is bound to the device.
   */
  openShareUpload(
    targetSessionId: string,
    deviceId: string,
    input: Omit<import('../mobile/mobile-artifact-upload.js').ShareUploadOpenInput, 'sessionId'>,
  ): import('../mobile/mobile-artifact-upload.js').ArtifactUploadOffer {
    return this.requireArtifactUploadService().openShare(deviceId, { ...input, sessionId: targetSessionId });
  }

  /** Move 3 of a phone SHARE: verify, write to the inbox, add the draft. */
  commitShareUpload(deviceId: string, uploadId: string, draft = true): import('../mobile/mobile-artifact-upload.js').ShareReceipt {
    return this.requireArtifactUploadService().commitShare(deviceId, uploadId, draft);
  }

  cancelShareUpload(deviceId: string, uploadId: string): import('../mobile/mobile-artifact-upload.js').ShareCancelResult {
    return this.requireArtifactUploadService().cancelShare(deviceId, uploadId);
  }

  private requireArtifactUploadService(): import('../mobile/mobile-artifact-upload.js').MobileArtifactUploadService {
    if (!this.artifactUploadService) {
      throw new Error('Artifact uploads are not available: the upload service is not configured.');
    }
    return this.artifactUploadService;
  }

  /** Summaries of this session's artifacts (no content) so the LLM can see its own. */
  listArtifacts(sessionId: string): Array<{
    id: string;
    title: string;
    kind: ArtifactKind;
    intent: ArtifactIntent;
    versionCount: number;
    createdAt: number;
    updatedAt: number;
    attachments: Array<Pick<ArtifactAttachment, 'id' | 'filename' | 'contentType' | 'sizeBytes' | 'createdAt'>>;
  }> {
    const attachmentManager = this.requireArtifactAttachmentManager();
    return this.requireArtifactManager().getForSession(sessionId).map(a => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      intent: a.intent ?? 'normal',
      versionCount: a.versions.length,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      attachments: attachmentManager.list(a.id).map(({ id, filename, contentType, sizeBytes, createdAt }) => ({
        id,
        filename,
        ...(contentType ? { contentType } : {}),
        sizeBytes,
        createdAt,
      })),
    }));
  }

  /** Full artifact inline, or a managed temp path when requested. */
  getArtifact(
    callerSessionId: string,
    id: string,
    version?: number,
    options?: { asFile?: boolean; attachmentId?: string },
  ): (Artifact & { requestedVersionContent?: string }) | { artifactId: string; version: number; tempPath: string } | { artifactId: string; attachment: ArtifactAttachment; tempPath: string } {
    const artifact = this.requireOwnedArtifact(callerSessionId, id);
    if (options?.attachmentId) {
      if (options.asFile) throw new Error('attachmentId and asFile cannot be used together');
      return this.copyArtifactAttachmentToTemp(artifact, options.attachmentId);
    }
    if (options?.asFile) {
      const shown = artifact.versions.find(v => v.version === version);
      if (version !== undefined && !shown) throw new Error(`Artifact ${id} has no version ${version}`);
      const selected = shown ?? artifact.versions[artifact.versions.length - 1];
      return {
        artifactId: artifact.id,
        version: selected.version,
        tempPath: this.writeArtifactVersionToTemp(artifact, selected.version, selected.content),
      };
    }
    if (version === undefined) return artifact;
    const match = artifact.versions.find(v => v.version === version);
    if (!match) throw new Error(`Artifact ${id} has no version ${version}`);
    return { ...artifact, requestedVersionContent: match.content };
  }

  /**
   * The file-download envelope for a session-addressed artifact call (a paired
   * phone saving a report). Same ownership rule as every other artifact read:
   * an id belonging to another session answers not-found. The size cap lives in
   * buildArtifactDownload, which throws caller-facing errors.
   */
  downloadArtifact(
    sessionId: string,
    id: string,
    version?: number,
    options?: { attachmentId?: string; offset?: number; length?: number },
  ): ArtifactDownload {
    const binary = this.downloadArtifactBinary(sessionId, id, version, options);
    return {
      filename: binary.filename,
      mimeType: binary.mimeType,
      base64: binary.bytes.toString('base64'),
      size: binary.bytes.byteLength,
      ...(binary.version !== undefined ? { version: binary.version } : {}),
      ...(binary.offset !== undefined ? { offset: binary.offset } : {}),
      ...(binary.total !== undefined ? { total: binary.total } : {}),
      ...(binary.eof !== undefined ? { eof: binary.eof } : {}),
    };
  }

  /**
   * The SAME envelope with the body left raw, for a transport that can carry
   * bytes — the paired phone, whose download replies ride the binary `blob`
   * record instead of a JSON result. Base64 exists to survive JSON, and a link
   * that does not need JSON should not spend a third of its bandwidth on it.
   *
   * This is the ONE reader: `downloadArtifact` is now a base64 view over it, so
   * the ownership check, the slice rules and the size caps cannot drift between
   * the two callers.
   */
  downloadArtifactBinary(
    sessionId: string,
    id: string,
    version?: number,
    options?: { attachmentId?: string; offset?: number; length?: number },
  ): ArtifactDownloadBinary {
    const artifact = this.requireOwnedArtifact(sessionId, id);
    if (options?.attachmentId) {
      if (version !== undefined) throw new Error('attachmentId cannot be combined with version');
      const attachments = this.requireArtifactAttachmentManager();
      const attachment = attachments.get(artifact.id, options.attachmentId);
      if (!attachment) throw new Error(`Attachment not found: ${options.attachmentId}`);
      // Always sliced, even when the caller asked for no window: one path means
      // a 40KiB note and a 4MB photo are fetched by the same loop, and the
      // caller never has to know in advance which one it is holding.
      const { bytes, window, total } = attachments.readSlice(
        artifact.id,
        attachment.id,
        options.offset,
        options.length,
      );
      return {
        filename: attachment.filename,
        mimeType: attachment.contentType ?? 'application/octet-stream',
        bytes,
        offset: window.offset,
        total,
        eof: window.eof,
      };
    }

    // An artifact BODY, not a slice: still capped on its base64 length, because
    // the local MCP contract encodes it and that is the bigger of the two forms.
    const envelope = buildArtifactDownload(artifact, version);
    return {
      filename: envelope.filename,
      mimeType: envelope.mimeType,
      bytes: Buffer.from(envelope.base64, 'base64'),
      ...(envelope.version !== undefined ? { version: envelope.version } : {}),
    };
  }

  /**
   * The inline-read envelope for a session-addressed artifact call: metadata
   * plus ONE version's content — never the whole versions array, which grows
   * without bound and rides the same wire frame budget as a download. Same
   * ownership rule: an id belonging to another session answers not-found.
   */
  readArtifact(sessionId: string, id: string, version?: number): ArtifactRead {
    const artifact = this.requireOwnedArtifact(sessionId, id);
    return buildArtifactRead(artifact, version);
  }

  // ---------------------------------------------------------------------------
  // Memories (durable, authenticated-session-scoped MCP records)
  // ---------------------------------------------------------------------------

  private requireMemoryService(): HelmMemoryService {
    if (!this.memoryService) {
      throw new Error('Memories are not available: MemoryManager is not configured.');
    }
    return this.memoryService;
  }

  listMemories(sessionId: string, options: MemoryListOptions = {}): MemoryRecord[] {
    return this.requireMemoryService().listMemories(sessionId, options);
  }

  getMemory(sessionId: string, id: string, graphDepth?: number): MemoryTraversal | null {
    return this.requireMemoryService().getMemory(sessionId, id, graphDepth);
  }

  createMemory(sessionId: string, input: { tldr: string; content: string; agentRun?: boolean; summary?: boolean }): MemoryRecord {
    return this.requireMemoryService().createMemory(sessionId, input);
  }

  createLinkableMemory(sessionId: string, input: { tldr: string; content: string }): WrittenMemory {
    return this.requireMemoryService().createLinkableMemory(sessionId, input);
  }

  dreamMemories(sessionId: string, options: MemoryDreamOptions = {}): MemoryDreamResult {
    return this.requireMemoryService().dreamMemories(sessionId, options);
  }

  setMemoryDormant(sessionId: string, id: string, dormant: boolean): boolean {
    return this.requireMemoryService().setMemoryDormant(sessionId, id, dormant);
  }

  updateMemory(
    sessionId: string,
    id: string,
    updates: { tldr?: string; content?: string },
    expectedUpdatedAt?: number,
  ): MemoryRecord | null {
    return this.requireMemoryService().updateMemory(sessionId, id, updates, expectedUpdatedAt);
  }

  deleteMemory(sessionId: string, id: string): boolean {
    return this.requireMemoryService().deleteMemory(sessionId, id);
  }

  searchMemories(sessionId: string, query: string, options?: { regex?: boolean; graphDepth?: number }): MemorySearchResult {
    return this.requireMemoryService().searchMemories(sessionId, query, options);
  }

  graphMemory(sessionId: string, rootId: string, graphDepth?: number): MemoryTraversal | null {
    return this.requireMemoryService().graphMemory(sessionId, rootId, graphDepth);
  }

  exportMemories(sessionId: string, format: MemoryExportFormat, rootId?: string, graphDepth?: number): MemoryExportResult {
    return this.requireMemoryService().exportMemories(sessionId, format, rootId, graphDepth);
  }

  linkMemory(sessionId: string, fromId: string, toId: string, type?: MemoryEdgeType): boolean {
    return this.requireMemoryService().linkMemory(sessionId, fromId, toId, type);
  }

  unlinkMemory(sessionId: string, fromId: string, toId: string): boolean {
    return this.requireMemoryService().unlinkMemory(sessionId, fromId, toId);
  }

  // Mess (durable, authenticated-session-scoped project conversation)

  private requireMessService(): HelmMessService {
    if (!this.messService) throw new Error('Mess is not available: ProjectStore is not configured.');
    return this.messService;
  }

  postMess(sessionId: string, text: string, targetSessionId?: string): { ok: true } {
    return this.requireMessService().post(sessionId, text, targetSessionId);
  }

  checkMess(sessionId: string) {
    return this.requireMessService().check(sessionId);
  }

  historyMess(sessionId: string, options: import('../session/mess-manager.js').MessHistoryOptions & { groupBy?: 'day' | 'month' }) {
    return this.requireMessService().history(sessionId, options);
  }

  searchMess(sessionId: string, options: import('../session/mess-manager.js').MessSearchOptions & { groupBy?: 'day' | 'month' }) {
    return this.requireMessService().search(sessionId, options);
  }

  addMemoryAttachment(
    sessionId: string,
    memoryId: string,
    input: { filePath: string; filename: string; contentType?: string },
  ): MemoryAttachment {
    return this.requireMemoryService().addMemoryAttachment(sessionId, memoryId, input);
  }

  listMemoryAttachments(sessionId: string, memoryId: string): MemoryAttachment[] {
    return this.requireMemoryService().listMemoryAttachments(sessionId, memoryId);
  }

  getMemoryAttachment(sessionId: string, memoryId: string, attachmentId: string): MemoryAttachmentTempFile {
    return this.requireMemoryService().getMemoryAttachment(sessionId, memoryId, attachmentId);
  }

  deleteMemoryAttachment(sessionId: string, memoryId: string, attachmentId: string): boolean {
    return this.requireMemoryService().deleteMemoryAttachment(sessionId, memoryId, attachmentId);
  }

  private requireArtifactAttachmentManager(): ArtifactAttachmentManager {
    if (!this.artifactAttachmentManager) {
      throw new Error('Artifacts are not available: ArtifactAttachmentManager is not configured.');
    }
    return this.artifactAttachmentManager;
  }

  private writeArtifactVersionToTemp(artifact: Artifact, version: number, content: string): string {
    const tempDir = getTempDir(dirname(fileURLToPath(import.meta.url)));
    const tempPath = join(tempDir, `helm-mcp-artifact-${randomUUID()}-${sanitizeFilename(artifact.sessionId)}--${sanitizeFilename(artifact.title)}-${version}.${artifact.kind === 'html' ? 'html' : 'md'}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(tempPath, content, 'utf8');
    return tempPath;
  }

  private copyArtifactAttachmentToTemp(artifact: Artifact, attachmentId: string): { artifactId: string; attachment: ArtifactAttachment; tempPath: string } {
    const attachmentManager = this.requireArtifactAttachmentManager();
    const attachment = attachmentManager.get(artifact.id, attachmentId);
    if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
    const sourcePath = attachmentManager.getPath(artifact.id, attachmentId);
    const tempDir = getTempDir(dirname(fileURLToPath(import.meta.url)));
    const tempPath = join(tempDir, `helm-mcp-attachment-${randomUUID()}-${sanitizeFilename(attachment.filename)}`);
    mkdirSync(tempDir, { recursive: true });
    copyFileSync(sourcePath, tempPath);
    return { artifactId: artifact.id, attachment, tempPath };
  }

  invalidateCapabilityCache(): void {
    this.capabilityDetector.invalidateCache();
  }

  /** Wire the handover sink used by session_compact's `handover` argument. */
  setHandoverDelivery(handover: HandoverArming): void {
    this.sessionDelivery.setHandoverDelivery(handover);
  }

  /** Wire the G9 reminder-delivery resolver (see HelmSessionDeliveryService). */
  setReminderDelivery(reminderDelivery: ReminderDeliveryFn): void {
    this.sessionDelivery.setReminderDelivery(reminderDelivery);
  }

  // ---------------------------------------------------------------------------
  // Plan CRUD
  // ---------------------------------------------------------------------------

  listPlans(dirPath: string, filter: PlanFilter = 'active'): PlanItem[] {
    return this.planService.listPlans(dirPath, filter);
  }

  plansSummary(dirPath: string, filter: PlanFilter = 'active') {
    const timers = this.schedulerService?.listTasks() ?? [];
    return this.planService.plansSummary(
      dirPath,
      filter,
      (id) => this.sessionManager.getSession(id)?.name,
      (planId) => nextCheckAt(planId, timers),
    );
  }

  getPlan(id: string): (Omit<PlanItem, 'sequenceId'> & {
    hasAttachments: boolean;
    sequenceId?: string;
    sequenceContextMetadata?: Array<{
      id: string;
      title: string;
      type: string;
      permission: ContextPermission;
    }>;
  }) | null {
    return this.planService.getPlan(id);
  }

  getPlanIdMapping(humanId: string): { uuid: string; humanId: string } {
    return this.planService.getPlanIdMapping(humanId);
  }

  createPlan(dirPath: string, title: string, description: string, type?: PlanType, autoImplement?: boolean): { id: string; humanId: string } {
    return this.planService.createPlan(dirPath, title, description, type, autoImplement);
  }

  updatePlan(id: string, updates: { title?: string; description?: string; type?: PlanType | null; autoImplement?: boolean; completionRecap?: boolean; task?: PlanTask | null }): { ok: true; updatedAt: number } {
    return this.planService.updatePlan(id, updates);
  }

  deletePlan(id: string): boolean {
    return this.planService.deletePlan(id);
  }

  completePlan(id: string, completionNotes?: string): PlanItem | null {
    return this.planService.completePlan(id, completionNotes);
  }

  reopenPlan(id: string): { ok: true } {
    return this.planService.reopenPlan(id);
  }

  setPlanState(
    id: string,
    status: Exclude<PlanStatus, 'done'>,
    stateInfo?: string,
  ): { ok: true } {
    return this.planService.setPlanState(id, status, stateInfo);
  }

  linkPlans(fromId: string, toId: string): void {
    return this.planService.linkPlans(fromId, toId);
  }

  unlinkPlans(fromId: string, toId: string): void {
    return this.planService.unlinkPlans(fromId, toId);
  }

  exportDirectory(dirPath: string): { dirPath: string; items: PlanItem[]; dependencies: { fromId: string; toId: string }[] } | null {
    return this.planService.exportDirectory(dirPath);
  }

  exportItem(id: string): { item: PlanItem; dependencies: { fromId: string; toId: string }[] } | null {
    return this.planService.exportItem(id);
  }

  // ---------------------------------------------------------------------------
  // Plan sequences
  // ---------------------------------------------------------------------------

  listPlanSequences(input: { dirPath?: string; planRef?: string }): Array<PlanSequence & { memberPlanIds: string[]; memberHumanIds: string[]; selectedForPlan?: boolean }> {
    return this.planSequenceService.listPlanSequences(input);
  }

  getPlanSequence(id: string): (PlanSequence & { memberPlanIds: string[]; memberHumanIds: string[] }) | null {
    return this.planSequenceService.getPlanSequence(id);
  }

  createPlanSequence(input: { dirPath: string; title: string; missionStatement?: string; sharedMemory?: string }): { id: string } {
    return this.planSequenceService.createPlanSequence(input);
  }

  updatePlanSequence(
    id: string,
    updates: { title?: string; missionStatement?: string; sharedMemory?: string; order?: number; expectedUpdatedAt?: number },
  ): { ok: true; updatedAt: number } {
    return this.planSequenceService.updatePlanSequence(id, updates);
  }


  deletePlanSequence(id: string): boolean {
    const deleted = this.planSequenceService.deletePlanSequence(id);
    // Same as the desktop's plan:sequence-delete: drop the lane's bindings.
    if (deleted) this.contextManager.removeBindingsForTarget('sequence', id);
    return deleted;
  }

  /** Cleanup counts for a directory — same numbers the desktop cleanup dialog shows. */
  getPlanCleanupCounts(dirPath: string): PlanCleanupCounts {
    return getPlanCleanupCounts(this.planManager, this.contextManager, dirPath);
  }

  /** Small `{ deleted }` reply on purpose: large MCP replies have broken the phone link. */
  clearEmptySequences(dirPath: string): { deleted: number } {
    return { deleted: clearEmptySequences(this.planManager, this.contextManager, dirPath) };
  }

  clearUnreferencedContexts(dirPath: string): { deleted: number } {
    return { deleted: clearUnreferencedContexts(this.planManager, this.contextManager, dirPath) };
  }

  assignPlanSequence(planRef: string, sequenceId: string | null): { ok: true } {
    return this.planSequenceService.assignPlanSequence(planRef, sequenceId);
  }

  // ---------------------------------------------------------------------------
  // Context nodes
  // ---------------------------------------------------------------------------

  listContexts(projectId: string): Array<ContextNode & { sequenceIds: string[]; planIds: string[] }> {
    return this.contextService.listContexts(projectId);
  }

  getContext(id: string): (ContextNode & { sequenceIds: string[]; planIds: string[] }) | null {
    return this.contextService.getContext(id);
  }

  createContext(input: {
    projectId: string;
    title: string;
    type?: string;
    permission?: ContextPermission;
    content?: string;
    x?: number | null;
    y?: number | null;
  }): { id: string } {
    return this.contextService.createContext(input);
  }

  getProjectIdForDirectory(dirPath: string): string {
    return this.contextService.getProjectIdForDirectory(dirPath);
  }

  updateContext(
    id: string,
    updates: {
      title?: string;
      type?: string;
      permission?: ContextPermission;
      content?: string;
      x?: number | null;
      y?: number | null;
    },
    expectedUpdatedAt?: number,
  ): { ok: true; updatedAt: number } {
    return this.contextService.updateContext(id, updates, expectedUpdatedAt);
  }

  deleteContext(id: string): boolean {
    return this.contextService.deleteContext(id);
  }


  setContextPosition(id: string, x: number | null, y: number | null): { ok: true } {
    return this.contextService.setContextPosition(id, x, y);
  }

  bindContext(id: string, targetType: ContextBindingTargetType, targetId: string): boolean {
    return this.contextService.bindContext(id, targetType, targetId);
  }

  unbindContext(id: string, targetType: ContextBindingTargetType, targetId: string): boolean {
    return this.contextService.unbindContext(id, targetType, targetId);
  }

  listPlanContexts(planRef: string): PlanContextRef[] {
    return this.contextService.listPlanContexts(planRef);
  }

  // ---------------------------------------------------------------------------
  // Plan attachments
  // ---------------------------------------------------------------------------

  listPlanAttachments(planRef: string): PlanAttachment[] {
    return this.planAttachmentService.listPlanAttachments(planRef);
  }

  addPlanAttachment(
    planRef: string,
    input: { filePath: string; contentType?: string; text?: unknown; contentBase64?: unknown },
  ): { id: string } {
    return this.planAttachmentService.addPlanAttachment(planRef, input);
  }

  deletePlanAttachment(planRef: string, attachmentId: string): boolean {
    return this.planAttachmentService.deletePlanAttachment(planRef, attachmentId);
  }

  getPlanAttachment(planRef: string, attachmentId: string): PlanAttachmentTempFile {
    return this.planAttachmentService.getPlanAttachment(planRef, attachmentId);
  }

  // ---------------------------------------------------------------------------
  // CLI listing
  // ---------------------------------------------------------------------------

  listDirectories() {
    return this.directoryService.listDirectories();
  }

  listClis() {
    const supportedDirPaths = this.configLoader.getWorkingDirectories().map(e => e.path);
    return this.configLoader.getCliTypes().map(cliType => {
      const entry = this.configLoader.getCliTypeEntry(cliType)!;
      return {
        cliType,
        name: entry.displayName ?? entry.name,
        // Helm-hosted tools have no CLI process; ComfyUI sessions use the local media host.
        kind: entry.api ? 'api' as const : entry.comfyUi ? 'comfyui' as const : 'cli' as const,
        ...(entry.api ? { model: entry.api.model } : {}),
        command: entry.spawnCommand ?? '',
        supportsResume: Boolean(entry.api || entry.spawnCommand || entry.resumeCommand || entry.continueCommand),
        supportedDirPaths,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Project management
  // ---------------------------------------------------------------------------

  createProject(dirPath: string, name?: string) {
    return this.requireProjectService().createProject(dirPath, name);
  }

  renameProject(projectId: string, name: string) {
    return this.requireProjectService().renameProject(projectId, name);
  }

  setProjectMemoryPrivate(projectId: string, memoryPrivate: boolean) {
    return this.requireProjectService().setProjectMemoryPrivate(projectId, memoryPrivate);
  }

  deleteProject(projectId: string) {
    return this.requireProjectService().deleteProject(projectId);
  }

  listProjects() {
    return this.requireProjectService().listProjects();
  }

  listProjectDirs(projectId: string) {
    return this.requireProjectService().listProjectDirs(projectId);
  }

  addProjectDir(projectId: string, dirPath: string) {
    return this.requireProjectService().addProjectDir(projectId, dirPath);
  }

  removeProjectDir(projectId: string, dirPath: string) {
    return this.requireProjectService().removeProjectDir(projectId, dirPath);
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  listSessions(dirPath?: string, projectId?: string) {
    return this.nameRemoteMachines(this.sessionService.listSessions(dirPath, projectId));
  }

  /**
   * The session list as a DELTA: only the rows that moved after `cursor`, plus
   * the ids that went away. A cursor the feed cannot honour is answered with
   * the whole list and `full: true`, which tells the caller to replace rather
   * than merge. See SessionChangeFeed.
   */
  listSessionChanges(cursor: SessionFeedCursor | null, dirPath?: string, projectId?: string): SessionListChanges {
    const feed = this.sessionChangeFeed;
    const delta = feed.since(cursor);
    const sessions = this.listSessions(dirPath, projectId);
    if (delta.full) return { epoch: feed.epoch, seq: feed.seq, full: true, sessions, removed: [] };
    const changed = new Set(delta.changed);
    return {
      epoch: feed.epoch,
      seq: feed.seq,
      full: false,
      sessions: sessions.filter((session) => changed.has(session.id)),
      removed: delta.removed,
    };
  }

  /**
   * Stamp each Remote row with its owner machine's name, so remote surfaces
   * (the phone) can group rows by machine without their own peer registry.
   */
  private nameRemoteMachines(sessions: SessionSummary[]): SessionSummary[] {
    if (!sessions.some((s) => s.remote)) return sessions;
    const aliases = new Map((this.peerLinkManager?.list() ?? []).map((p) => [p.id, p.alias]));
    return sessions.map((s) => s.remote
      ? { ...s, remote: { ...s.remote, machineName: aliases.get(s.remote.peerId) ?? s.remote.peerId } }
      : s);
  }

  getSession(sessionRef: string) {
    return this.sessionService.getSession(sessionRef);
  }

  setApiContextSizeLookup(lookup: (sessionId: string) => ApiSessionContextSize): void {
    this.sessionService.setApiContextSizeLookup(lookup);
  }

  spawnCli(
    cliType: string,
    dirPath: string,
    name: string | undefined,
    opts: { creatorSessionId?: string; runtimeGroupId?: string; initialPrompt?: string } = {},
  ) {
    return this.sessionService.spawnCli(cliType, dirPath, name, opts);
  }

  // ---------------------------------------------------------------------------
  // Runtime session groups (manageable overlay)
  // ---------------------------------------------------------------------------

  listSessionGroups() {
    return this.sessionService.listSessionGroups();
  }

  createSessionGroup(name: string) {
    return this.sessionService.createSessionGroup(name);
  }

  addSessionToGroup(groupId: string, sessionRef: string) {
    return this.sessionService.addSessionToGroup(groupId, sessionRef);
  }

  removeSessionFromGroups(sessionRef: string) {
    return this.sessionService.removeSessionFromGroups(sessionRef);
  }

  renameSessionGroup(groupId: string, name: string) {
    return this.sessionService.renameSessionGroup(groupId, name);
  }

  closeSessionGroup(groupId: string) {
    return this.sessionService.closeSessionGroup(groupId);
  }

  renameSession(sessionRef: string, name: string) {
    return this.sessionService.renameSession(sessionRef, name);
  }

  closeSession(sessionRef: string) {
    return this.sessionService.closeSession(sessionRef);
  }

  setSessionLocked(sessionRef: string, locked: boolean) {
    return this.sessionService.setSessionLocked(sessionRef, locked);
  }

  setSessionFrozen(sessionRef: string, frozen: boolean) {
    return this.sessionService.setSessionFrozen(sessionRef, frozen);
  }

  setSessionKeepWarm(sessionRef: string, on: boolean) {
    return this.sessionService.setSessionKeepWarm(sessionRef, on);
  }

  setSessionMission(sessionRef: string, text: string) {
    return this.sessionService.setSessionMission(sessionRef, text);
  }

  // ---------------------------------------------------------------------------
  // User-managed skills
  // ---------------------------------------------------------------------------

  listSkills(filter?: { projectId?: string; dirPath?: string }, authContext?: { sessionId?: string; sessionName?: string }): McpSkillSummary[] {
    const projectId = filter?.projectId
      ?? this.resolveProjectIdForDirectory(filter?.dirPath)
      ?? this.resolveProjectIdForSession(authContext);
    return this.skillManager.listForProject(projectId).map(toMcpSkillSummary);
  }

  getSkill(id: string): Skill | null {
    return this.prepareSkillForUse(this.skillManager.get(id));
  }

  createSkill(input: SkillCreateInput): { id: string } {
    const skill = this.skillManager.create(input);
    return { id: skill.id };
  }

  updateSkill(id: string, updates: SkillUpdateInput): { ok: true } {
    this.skillManager.update(id, updates, { requireAiAmendable: true });
    return { ok: true };
  }

  resolveSkill(type: string, filter?: { projectId?: string; dirPath?: string }): Skill | null {
    const projectId = filter?.projectId ?? this.resolveProjectIdForDirectory(filter?.dirPath);
    return this.prepareSkillForUse(this.skillManager.resolveEffective(type, projectId ?? undefined));
  }

  activateSkill(skillId: string, _context?: string): Skill | null {
    const byId = this.skillManager.get(skillId);
    if (byId) return this.prepareSkillForUse(byId);
    const byType = this.skillManager.resolveEffective(skillId.toLowerCase(), undefined);
    return this.prepareSkillForUse(byType);
  }

  deleteSkill(id: string): boolean {
    return this.skillManager.delete(id);
  }

  getSkillStats(id: string) {
    return this.skillAnalyticsManager.getStats(id);
  }

  clearSkillReviews(id: string) {
    return this.skillAnalyticsManager.clearReviews(id);
  }

  resetSkillUseCount(id: string) {
    return this.skillAnalyticsManager.resetUseCount(id);
  }

  resetAllSkillUseCounts(): void {
    this.skillAnalyticsManager.resetAllCounts();
  }

  submitSkillFeedback(
    id: string,
    stars: number,
    summary: string,
    improvement: string | undefined,
    authContext?: { sessionId?: string; sessionName?: string },
  ) {
    const skill = this.skillManager.get(id);
    if (!skill) throw new Error(`Skill not found: ${id}`);
    if (!authContext?.sessionId) {
      throw new Error('skill_submit_feedback requires a session-scoped MCP caller');
    }
    const session = this.sessionManager.getSession(authContext.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${authContext.sessionId}`);
    }
    this.skillAnalyticsManager.addReview(id, {
      stars,
      summary,
      ...(improvement ? { improvement } : {}),
      cliName: session.name,
      cliType: session.cliType,
      timestamp: new Date().toISOString(),
    } satisfies SkillReview);
    return { ok: true };
  }

  private prepareSkillForUse(skill: Skill | null): Skill | null {
    if (!skill) return skill;
    this.skillAnalyticsManager.incrementUseCount(skill.id);
    if (skill.source === 'system') return skill;
    return {
      ...skill,
      body: appendSkillFeedbackFooter(skill.body, skill.id),
    };
  }

  /**
   * Restart Helm. By default (`resume === true`) sessions are left intact on disk
   * so the relaunched instance auto-resumes them. Pass `resume === false` to close
   * every session first — a force restart that comes back with no sessions.
   *
   * When `options.resumePrompt` is set, a one-shot direct-mode scheduled task is
   * created BEFORE the restart is triggered, so the relaunched app re-prompts the
   * calling session ~2 minutes later. A restart can then never strand the work
   * that asked for it — the caller hands over its next step as the prompt.
   */
  restartHelm(resume = true, options?: { callerSessionId?: string; resumePrompt?: string }): { sessionsClosed: number; resume: boolean; resumeTaskId?: string } {
    if (options?.resumePrompt) {
      if (!resume) {
        throw new Error('resumePrompt requires resume:true (the default) — with resume:false the calling session is closed and cannot be re-prompted');
      }
      if (!options.callerSessionId) {
        throw new Error('callerSessionId is required to schedule a restart self-resume');
      }
    }
    let sessionsClosed = 0;
    if (!resume) {
      // The operator is locked by design, not by the user, and must survive a
      // restart anyway — so it neither blocks a force-restart nor gets closed.
      const sessions = this.sessionService.listSessions().filter((session) => session.role !== 'operator');
      const locked = sessions.filter((session) => session.locked);
      if (locked.length > 0) {
        throw new Error(`Cannot force-restart while locked sessions exist: ${locked.map((session) => session.name).join(', ')}`);
      }
      for (const session of sessions) {
        try {
          this.sessionService.closeSession(session.id);
          sessionsClosed++;
        } catch (error) {
          logger.warn(`[HelmControl] Failed to close session ${session.id} during restart: ${error}`);
        }
      }
    }
    let resumeTaskId: string | undefined;
    if (options?.resumePrompt) {
      const scheduler = this.requireScheduler();
      const session = this.sessionService.getSession(options.callerSessionId!);
      if (!session) {
        throw new Error(`Session not found: ${options.callerSessionId}`);
      }
      const { workingDir } = session;
      if (!workingDir) {
        throw new Error(`Session ${options.callerSessionId} has no working directory to schedule its self-resume in`);
      }
      resumeTaskId = scheduler.createTask({
        title: 'Restart self-resume',
        initialPrompt: options.resumePrompt,
        // Direct mode derives the CLI type from the target session.
        cliType: '',
        dirPath: workingDir,
        planIds: [],
        scheduledTime: new Date(Date.now() + 2 * 60_000).toISOString(),
        mode: 'direct',
        targetSessionId: options.callerSessionId!,
      }).id;
    }
    this.emit('restart-requested');
    return resumeTaskId !== undefined ? { sessionsClosed, resume, resumeTaskId } : { sessionsClosed, resume };
  }

  /**
   * The MCP-facing restart — a two-phase gate in front of [restartHelm].
   *
   * Phase 1 (no handoverArtifactId) ALWAYS refuses: a restart destroys the
   * caller's own context, so the first call exists to be told the ritual —
   * leave a mess pointer, write a handover artifact, come back with its id.
   * Phase 2 proves the handover exists via the same ownership rule as every
   * other artifact read, and the artifact's latest content becomes the
   * self-resume prompt, so the relaunched app re-prompts this session with
   * the handover it left itself.
   */
  restartHelmGated(
    callerSessionId: string,
    handoverArtifactId: string | undefined,
    resume = true,
  ): { sessionsClosed: number; resume: boolean; resumeTaskId?: string } {
    if (!handoverArtifactId) {
      throw new Error(
        'helm_restart refused — this is phase 1 of 2, and a restart destroys your own context. ' +
          'Leave a handover first: (1) mess_post a short message pointing teammates at your handover doc, ' +
          '(2) artifact_create the handover itself — what was in flight, decisions made, the next concrete step — ' +
          '(3) call helm_restart again with handoverArtifactId set to that artifact id. ' +
          'Nothing has restarted yet.',
      );
    }
    const artifact = this.requireOwnedArtifact(callerSessionId, handoverArtifactId);
    const prompt = artifact.versions[artifact.versions.length - 1]?.content ?? '';
    // resume:false closes the caller too, so there is no session to re-prompt —
    // restartHelm rejects a resumePrompt there, and the artifact has done its
    // job by existing: it is still readable from the next instance.
    return resume
      ? this.restartHelm(true, { callerSessionId, resumePrompt: prompt })
      : this.restartHelm(false);
  }

  setAiagentState(sessionRef: string, state: 'planning' | 'implementing' | 'completed' | 'idle') {
    return this.sessionService.setAiagentState(sessionRef, state);
  }

  readSessionTerminal(sessionRef: string, requestedLines?: number, mode?: TerminalReadMode, stripBlankLines?: boolean) {
    return this.sessionService.readSessionTerminal(sessionRef, requestedLines, mode, stripBlankLines);
  }

  claimSessionPlan(sessionRef: string, planId: string) {
    return this.sessionService.claimSessionPlan(sessionRef, planId);
  }

  // ---------------------------------------------------------------------------
  // Session text delivery
  // ---------------------------------------------------------------------------

  async sendTextToSession(
    sessionRef: string,
    text: string,
    options?: { senderSessionId?: string; senderSessionName?: string; expectsResponse?: boolean },
  ) {
    return this.sessionDelivery.sendTextToSession(sessionRef, text, options);
  }

  async sendInputToSession(
    sessionRef: string,
    sequence: string,
    options?: { senderSessionId?: string; senderSessionName?: string; impliedSubmit?: boolean; verify?: boolean },
  ) {
    return this.sessionDelivery.sendInputToSession(sessionRef, sequence, options);
  }

  async clearSession(
    sessionRef: string,
    options: { senderSessionId?: string; senderSessionName?: string; context?: string },
  ) {
    return this.sessionDelivery.clearSession(sessionRef, options);
  }

  async compactSession(sessionRef: string, options?: { instruction?: string; handover?: string }) {
    return this.sessionDelivery.compactSession(sessionRef, options);
  }

  async quickCompactSession(
    sessionRef: string,
    options: { senderSessionId?: string; senderSessionName?: string; handover?: string },
  ) {
    return this.sessionDelivery.quickCompactSession(sessionRef, options);
  }

  cloneSession(sessionRef: string, opts: { handover?: string; creatorSessionId?: string } = {}) {
    return this.sessionService.cloneSession(sessionRef, opts);
  }

  switchSessionCli(
    sessionRef: string,
    cliType: string,
    opts: { handover?: string; closeSource?: boolean; creatorSessionId?: string } = {},
  ) {
    return this.sessionService.switchCli(sessionRef, cliType, opts);
  }

  async exportSession(sessionRef: string, options: { path: string }) {
    return this.sessionDelivery.exportSession(sessionRef, options);
  }

  // ---------------------------------------------------------------------------
  // Session info guide
  // ---------------------------------------------------------------------------

  getSessionInfo(authContext?: { sessionId?: string; sessionName?: string }): SessionInfoResponse {
    const context = authContext?.sessionId
      ? this.sessionService.getSessionContextSize(authContext.sessionId)
      : undefined;
    return getSessionInfo(this.sessionManager, authContext, context);
  }

  // ---------------------------------------------------------------------------
  // Telegram & notifications
  // ---------------------------------------------------------------------------

  getTelegramStatus(): TelegramStatus {
    return this.telegramService.getTelegramStatus();
  }

  async closeTelegramChannel(channelId: string): Promise<TelegramChannel> {
    return this.telegramService.closeTelegramChannel(channelId);
  }

  async sendTelegramChat(
    sessionRef: string,
    message: string,
    filePath?: string,
    usage?: ChatTurnUsage,
  ): Promise<{ sent: boolean; reason?: string }> {
    return this.telegramService.sendTelegramChat(sessionRef, message, filePath, usage);
  }

  async sendTelegramVoice(
    sessionRef: string,
    text: string,
  ): Promise<{ sent: boolean; reason?: string }> {
    return this.telegramService.sendTelegramVoice(sessionRef, text);
  }

  notifyUser(sessionRef: string, title: string, content: string): { delivered: 'toast' | 'bubble' | 'telegram' | 'taskbar_flash' | 'none' } {
    return this.telegramService.notifyUser(sessionRef, title, content);
  }

  /**
   * Flash a session in the sidebar to grab the user's attention (flash_attention
   * MCP tool). Resolves the session ref to its canonical id, then delegates to
   * NotificationManager which owns accent-colour resolution and renderer broadcast.
   */
  /** Wired to the mobile bridge's sendRing; absent = no phones in this build. */
  setPhoneRinger(ringer: ((sessionId: string, reason: string) => boolean) | null): void {
    this.phoneRinger = ringer;
  }

  /** Wired to the mobile bridge's sendTransfer; absent = no phones in this build. */
  setCallTransferrer(transferrer: ((fromSessionId: string, toSessionId: string, line: string) => boolean) | null): void {
    this.callTransferrer = transferrer;
  }

  /**
   * Hand the phone's live call from the caller to another session
   * (call_transfer). Any session may move ITS OWN call: the phone ignores a
   * transfer whose from-session is not the one it is talking to.
   */
  transferCall(callerSessionId: string, targetRef: string): { transferred: true; to: string } {
    const target = this.sessionService.getSession(targetRef);
    if (!target) throw new Error(`Session not found: ${targetRef}`);
    if (target.id === callerSessionId) throw new Error('The call is already with you.');
    if (!this.callTransferrer?.(callerSessionId, target.id, `Now talking to ${target.name}.`)) {
      throw new Error('No linked phone took the transfer.');
    }
    return { transferred: true, to: target.id };
  }

  /** Retries a ring nobody answered (src/session/ring-retry.ts); absent = no retry. */
  setRingRetry(retry: RingRetry | null): void {
    this.ringRetry = retry;
  }

  /** A linked phone picked up `sessionId`'s ring (unnamed: an older phone): no retry. */
  ringAnswered(sessionId?: string): void {
    this.ringRetry?.answered(sessionId);
  }

  /**
   * Ring the user's phone (ring_user) as the calling session: the phone shows
   * its name as caller ID and Accept opens a call straight to it.
   */
  ringUser(callerSessionId: string, reason: string): { rung: true } {
    if (!this.phoneRinger?.(callerSessionId, reason)) {
      throw new Error('No linked phone took the ring. Fall back to chat_send or notify_user.');
    }
    this.ringRetry?.rang(callerSessionId, reason);
    return { rung: true };
  }

  flashAttention(sessionRef: string): { flashed: boolean } {
    if (!this.notificationManager) {
      throw new Error('flash_attention is unavailable — notification manager not initialised.');
    }
    const session = this.getSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }
    return this.notificationManager.flashAttention(session.id);
  }

  getAppVisibility(): {
    visibility: 'visible-focused' | 'visible-background' | 'hidden';
    screenLocked: boolean;
    activeSessionId: string | null;
  } {
    return this.telegramService.getAppVisibility();
  }

  // ---------------------------------------------------------------------------
  // Scheduler CRUD
  // ---------------------------------------------------------------------------

  createScheduledTask(params: Omit<CreateScheduledTaskParams, 'scheduledTime' | 'endDate'> & { scheduledTime: string; endDate?: string }): { id: string } {
    return this.requireScheduler().createTask(params);
  }

  listScheduledTasks(): ScheduledTask[] {
    return this.requireScheduler().listTasks();
  }

  getScheduledTask(id: string): ScheduledTask | null {
    return this.requireScheduler().getTask(id);
  }

  updateScheduledTask(id: string, updates: Omit<UpdateScheduledTaskParams, 'scheduledTime' | 'endDate'> & { scheduledTime?: string; endDate?: string }): { ok: true } {
    return this.requireScheduler().updateTask(id, updates);
  }

  cancelScheduledTask(id: string): { ok: true } {
    return this.requireScheduler().cancelTask(id);
  }

  deleteScheduledTask(id: string): { ok: true } {
    return this.requireScheduler().deleteTask(id);
  }

  private requireScheduler(): HelmSchedulerService {
    if (!this.schedulerService) throw new Error('Scheduler is not available');
    return this.schedulerService;
  }

  private requireProjectService(): HelmProjectService {
    if (!this.projectService) throw new Error('Project service is not available');
    return this.projectService;
  }

  private resolveProjectIdForSession(authContext?: { sessionId?: string; sessionName?: string }): string | null {
    const sessionId = authContext?.sessionId;
    if (!sessionId) return null;
    const session = this.sessionManager.getSession(sessionId);
    return this.resolveProjectIdForDirectory(session?.workingDir);
  }

  private resolveProjectIdForDirectory(dirPath?: string): string | null {
    if (!dirPath || !this.projectStore) return null;
    const match = this.projectStore.findByPath(dirPath);
    return match?.id ?? null;
  }
}

function appendSkillFeedbackFooter(body: string, skillId: string): string {
  const footer = SKILL_FEEDBACK_FOOTER.replace('{skillId}', skillId);
  return `${body.trimEnd()}\n\n${footer}`;
}

function toMcpSkillSummary(skill: SkillSummary): McpSkillSummary {
  return { id: skill.id, name: skill.name, triggerCondition: skill.description };
}

const MCP_FILE_MAX_BYTES = 10 * 1024 * 1024;

function readArtifactInputFile(filePath: string, contentType?: string): {
  filename: string;
  content: Buffer;
  contentType?: string;
} {
  if (!isAbsolute(filePath)) throw new Error('filePath must be an absolute path');
  const fileStat = statSync(filePath);
  if (!fileStat.isFile()) throw new Error('filePath must point to a regular file');
  if (fileStat.size > MCP_FILE_MAX_BYTES) throw new Error('File exceeds 10MB size limit');
  return {
    filename: basename(filePath),
    content: readFileSync(filePath),
    ...(contentType ? { contentType } : {}),
  };
}
