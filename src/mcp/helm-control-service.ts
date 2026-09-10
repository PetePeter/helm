import { EventEmitter } from 'node:events';
import type { ConfigLoader } from '../config/loader.js';
import type { PlanManager } from '../session/plan-manager.js';
import type { SessionManager } from '../session/manager.js';
import type { PtyManager } from '../session/pty-manager.js';
import type { TerminalOutputMode } from '../session/terminal-output-buffer.js';
import type { PlanFilter, PlanItem, PlanSequence, PlanStatus, PlanType } from '../types/plan.js';
import type { PlanAttachment, PlanAttachmentTempFile } from '../types/plan-attachment.js';
import type { SessionInfo } from '../types/session.js';
import type { Artifact, ArtifactKind } from '../types/artifact.js';
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
import { logger } from '../utils/logger.js';
import type { ScheduledTaskManager } from '../session/scheduled-task-manager.js';
import type { CreateScheduledTaskParams, ScheduledTask, UpdateScheduledTaskParams } from '../types/scheduled-task.js';
import type { ContextBindingTargetType, ContextNode, ContextPermission, PlanContextRef } from '../types/context.js';
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
import type { ProjectStore } from '../session/project-store.js';
import { CapabilityDetector } from '../session/capability-detector.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTempDir } from '../utils/app-paths.js';
import { sanitizeFilename } from '../session/artifact-temp-file.js';
import { createArtifactFromBytes, updateArtifactFromBytes } from '../session/artifact-file-import.js';
import type { ArtifactAttachmentManager } from '../session/artifact-attachment-manager.js';
import type { ArtifactAttachment } from '../types/artifact-attachment.js';
import { HelmMemoryService, type MemoryExportResult } from './services/helm-memory-service.js';
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

export interface SessionSummary {
  id: string;
  name: string;
  /** UUID identity — pass it back verbatim; it is not meant to be shown to a human. */
  cliType: string;
  /** Human label for cliType. Use this in anything a person reads. */
  cliTypeName: string;
  workingDir?: string;
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
  /** AIAGENT phase state (planning, implementing, completed, idle). */
  aiagentState?: 'planning' | 'implementing' | 'completed' | 'idle';
  /** Remote Fleet peer that created this session, when spawned over the peer proxy. */
  createdByPeerId?: string;
  /** True when deliberate session closure is blocked. */
  locked?: boolean;
}

export interface CliSummary {
  cliType: string;
  name: string;
  command: string;
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
}

export interface SessionInfoResponse {
  your_session_id: string;
  your_working_dir: string;
  helm_workflow: string;
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
  private readonly planService: HelmPlanService;
  private readonly planSequenceService: HelmPlanSequenceService;
  private readonly contextService: HelmContextService;
  private readonly planAttachmentService: HelmPlanAttachmentService;
  private readonly telegramService: HelmTelegramService;
  private notificationManager: NotificationManager | null = null;
  private artifactManager?: import('../session/artifact-manager.js').ArtifactManager;
  private artifactAttachmentManager?: ArtifactAttachmentManager;
  private memoryService?: HelmMemoryService;
  private memoryManager: MemoryManager | null = null;
  private messService?: HelmMessService;
  private messManager: MessManager | null = null;
  private readonly schedulerService: HelmSchedulerService | null;
  private readonly projectService: HelmProjectService | null;
  private readonly directoryService: HelmDirectoryService;
  /** Fleet is OFF by default → no manager until setPeerLinkManager wires one. */
  private peerLinkManager?: import('./peer/peer-link-manager.js').PeerLinkManager | null;
  private readonly peerService: HelmPeerService;
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

  // ---------------------------------------------------------------------------
  // Artifacts (AI-authored, session-scoped renderable reports)
  // ---------------------------------------------------------------------------

  private requireArtifactManager(): import('../session/artifact-manager.js').ArtifactManager {
    if (!this.artifactManager) {
      throw new Error('Artifacts are not available: ArtifactManager is not configured.');
    }
    return this.artifactManager;
  }

  createArtifact(sessionId: string, title: string, kind: ArtifactKind, content: string): Artifact {
    return this.requireArtifactManager().create(sessionId, title, kind, content);
  }

  createArtifactFromFile(
    sessionId: string,
    filePath: string,
    title?: string,
    contentType?: string,
  ): ReturnType<typeof createArtifactFromBytes> {
    const input = readArtifactInputFile(filePath, contentType);
    return createArtifactFromBytes(
      this.requireArtifactManager(),
      this.requireArtifactAttachmentManager(),
      sessionId,
      input,
      title,
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

  updateArtifact(callerSessionId: string, id: string, content: string): Artifact {
    this.requireOwnedArtifact(callerSessionId, id);
    const updated = this.requireArtifactManager().update(id, content);
    if (!updated) throw new Error(`Artifact not found: ${id}`);
    return updated;
  }

  updateArtifactFromFile(
    callerSessionId: string,
    id: string,
    filePath: string,
    contentType?: string,
  ): ReturnType<typeof updateArtifactFromBytes> {
    const artifact = this.requireOwnedArtifact(callerSessionId, id);
    return updateArtifactFromBytes(
      this.requireArtifactManager(),
      this.requireArtifactAttachmentManager(),
      artifact,
      readArtifactInputFile(filePath, contentType),
    );
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

  deleteAllArtifacts(sessionId: string): { sessionId: string; cleared: true } {
    this.requireArtifactManager().deleteAllForSession(sessionId);
    return { sessionId, cleared: true };
  }

  /** Summaries of this session's artifacts (no content) so the LLM can see its own. */
  listArtifacts(sessionId: string): Array<{ id: string; title: string; kind: ArtifactKind; versionCount: number; createdAt: number; updatedAt: number }> {
    return this.requireArtifactManager().getForSession(sessionId).map(a => ({
      id: a.id,
      title: a.title,
      kind: a.kind,
      versionCount: a.versions.length,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
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

  createMemory(sessionId: string, input: { tldr: string; content: string }): MemoryRecord {
    return this.requireMemoryService().createMemory(sessionId, input);
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

  linkMemory(sessionId: string, fromId: string, toId: string): boolean {
    return this.requireMemoryService().linkMemory(sessionId, fromId, toId);
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

  // ---------------------------------------------------------------------------
  // Plan CRUD
  // ---------------------------------------------------------------------------

  listPlans(dirPath: string, filter: PlanFilter = 'active'): PlanItem[] {
    return this.planService.listPlans(dirPath, filter);
  }

  plansSummary(dirPath: string, filter: PlanFilter = 'active') {
    return this.planService.plansSummary(dirPath, filter);
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

  updatePlan(id: string, updates: { title?: string; description?: string; type?: PlanType | null; autoImplement?: boolean; completionRecap?: boolean }): { ok: true; updatedAt: number } {
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
    return this.planSequenceService.deletePlanSequence(id);
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
        name: entry.name,
        command: entry.spawnCommand ?? '',
        supportsResume: Boolean(entry.spawnCommand || entry.resumeCommand || entry.continueCommand),
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
    return this.sessionService.listSessions(dirPath, projectId);
  }

  getSession(sessionRef: string) {
    return this.sessionService.getSession(sessionRef);
  }

  spawnCli(
    cliType: string,
    dirPath: string,
    name: string,
    opts: { creatorSessionId?: string; runtimeGroupId?: string } = {},
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
   */
  restartHelm(resume = true): { sessionsClosed: number; resume: boolean } {
    let sessionsClosed = 0;
    if (!resume) {
      const sessions = this.sessionService.listSessions();
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
    this.emit('restart-requested');
    return { sessionsClosed, resume };
  }

  setAiagentState(sessionRef: string, state: 'planning' | 'implementing' | 'completed' | 'idle') {
    return this.sessionService.setAiagentState(sessionRef, state);
  }

  readSessionTerminal(sessionRef: string, requestedLines?: number, mode?: TerminalOutputMode, stripBlankLines?: boolean) {
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

  async compactSession(sessionRef: string, options?: { instruction?: string }) {
    return this.sessionDelivery.compactSession(sessionRef, options);
  }

  async exportSession(sessionRef: string, options: { path: string }) {
    return this.sessionDelivery.exportSession(sessionRef, options);
  }

  // ---------------------------------------------------------------------------
  // Session info guide
  // ---------------------------------------------------------------------------

  getSessionInfo(authContext?: { sessionId?: string; sessionName?: string }): SessionInfoResponse {
    return getSessionInfo(this.sessionManager, authContext);
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
  ): Promise<{ sent: boolean; reason?: string }> {
    return this.telegramService.sendTelegramChat(sessionRef, message, filePath);
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
