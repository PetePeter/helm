import { buildTranscriptResumePrompt, writeStrippedTranscript } from '../../session/transcript-strip.js';
import { expireAfterMs, warnAfterMs } from '../../session/prompt-staleness.js';
import { logger } from '../../utils/logger.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { SessionManager } from '../../session/manager.js';
import type { PtyManager } from '../../session/pty-manager.js';
import type { TerminalReadMode, TerminalTail } from '../../session/terminal-output-buffer.js';
import type { SessionInfo } from '../../types/session.js';
import type { SessionSummary, SessionTerminalTailResponse } from '../helm-control-service.js';
import { spawnConfiguredSession } from '../../session/configured-session-spawn.js';
import { HelmSessionPlanService } from './helm-session-plan-service.js';
import { normalizeProjectPath } from '../../session/project-identity.js';
import { GitBranchResolver } from '../../session/git-branch-resolver.js';
import { resolveWorkingDirectory } from './working-dir-gate.js';
import type { ProjectStore } from '../../session/project-store.js';
import type { RuntimeGroupManager } from '../../session/runtime-group-manager.js';
import type { RuntimeGroup } from '../../types/runtime-group.js';
import { placeSessionInRuntimeGroup } from '../../session/runtime-group-placement.js';
import { peerIdFromProxySessionId } from '../peer/proxy-identity.js';
import { deviceIdFromMobileSessionId } from '../../mobile/mobile-identity.js';
import { KEEP_WARM_DEFAULT_MS } from '../../session/keep-warmer.js';
import { resolveSessionContextSize, type ApiSessionContextSize, type SessionContextSize } from '../../session/context-size.js';

/**
 * Session lifecycle: list, get, spawn, close, read terminal, set AIAGENT state.
 * Plan assignment delegated to HelmSessionPlanService.
 */
export class HelmSessionService {
  readonly planService: HelmSessionPlanService;
  private readonly gitBranchResolver = new GitBranchResolver();
  /** Runtime session groups (optional overlay on top of project grouping). */
  private runtimeGroupManager: RuntimeGroupManager | null = null;
  private apiContextSizeLookup?: (sessionId: string) => ApiSessionContextSize;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly ptyManager: PtyManager,
    private readonly configLoader: ConfigLoader,
    planManager: import('../../session/plan-manager.js').PlanManager,
    private readonly projectStore?: ProjectStore,
  ) {
    this.planService = new HelmSessionPlanService(sessionManager, planManager, configLoader);
  }

  /** Late-bound: the RuntimeGroupManager lives in the main process orchestrator. */
  setRuntimeGroupManager(manager: RuntimeGroupManager): void {
    this.runtimeGroupManager = manager;
  }

  setApiContextSizeLookup(lookup: (sessionId: string) => ApiSessionContextSize): void {
    this.apiContextSizeLookup = lookup;
  }

  /** Late-bound: carries a session's artifacts to the session that continues it. */
  setSessionArtifactCopier(copier: (fromSessionId: string, toSessionId: string) => void): void {
    this.copySessionArtifacts = copier;
  }
  private copySessionArtifacts: ((fromSessionId: string, toSessionId: string) => void) | null = null;

  private requireRuntimeGroupManager(): RuntimeGroupManager {
    if (!this.runtimeGroupManager) {
      throw new Error('Runtime session groups are not available in this context');
    }
    return this.runtimeGroupManager;
  }

  listSessions(dirPath?: string, projectId?: string): SessionSummary[] {
    return this.sessionManager
      .getAllSessions()
      .filter((session) => {
        if (!dirPath && !projectId) return true;
        if (projectId) return session.projectId === projectId;
        if (!dirPath) return false;
        const normalizedDirPath = normalizeProjectPath(dirPath);
        const normalizedWorkingDir = session.workingDir ? normalizeProjectPath(session.workingDir) : undefined;
        const normalizedProjectPath = session.projectPath ? normalizeProjectPath(session.projectPath) : undefined;
        return normalizedWorkingDir === normalizedDirPath || normalizedProjectPath === normalizedDirPath;
      })
      .map((session) => this.toSessionSummary(session));
  }

  getSession(sessionRef: string): SessionSummary | null {
    const session = this.findSession(sessionRef);
    return session ? { ...this.toSessionSummary(session), context: this.contextSizeFor(session) } : null;
  }

  getSessionContextSize(sessionId: string): SessionContextSize | undefined {
    const session = this.sessionManager.getSession(sessionId);
    return session ? this.contextSizeFor(session) : undefined;
  }

  spawnCli(
    cliType: string,
    dirPath: string,
    name: string | undefined,
    opts: { creatorSessionId?: string; runtimeGroupId?: string; initialPrompt?: string } = {},
  ): { id: string; runtimeGroupId?: string; runtimeGroupName?: string } {
    const workingDir = this.requireWorkingDirectory(dirPath);
    const cli = this.requireCliEntry(cliType);
    // No name is not an error: the desktop's own spawn sends none either, and
    // spawnConfiguredSession names the session after the resolved CLI type.
    const sessionName = name?.trim() ?? '';
    // A `peer:<id>` creator means this spawn arrived over the Fleet proxy, so the
    // session is marked as remotely created; a local creator is a real UUID.
    const createdByPeerId = peerIdFromProxySessionId(opts.creatorSessionId);
    // A `mobile:<deviceId>` creator means this spawn arrived over the BLE mobile
    // proxy. Recorded so MobileGate can let that phone — and only that phone —
    // close the session again.
    const createdByMobileDeviceId = deviceIdFromMobileSessionId(opts.creatorSessionId);
    // A first instruction (the phone's plan-scoped spawn) rides contextText so it
    // lands after the CLI's own init sequence, never into a half-started CLI.
    const initialPrompt = opts.initialPrompt?.trim() ? opts.initialPrompt : undefined;
    const { sessionId } = spawnConfiguredSession({
      ptyManager: this.ptyManager,
      sessionManager: this.sessionManager,
      configLoader: this.configLoader,
      cliType: cli.id,
      sessionName,
      cwd: workingDir.path,
      fallbackCompleteDelayMs: 500,
      ...(createdByPeerId ? { createdByPeerId } : {}),
      ...(createdByMobileDeviceId ? { createdByMobileDeviceId } : {}),
      ...(initialPrompt ? { contextText: initialPrompt } : {}),
    });
    // Work the operator hands out is the operator's to follow up: the new
    // session reports back to it until the user talks to it directly.
    const creator = opts.creatorSessionId ? this.sessionManager.getSession(opts.creatorSessionId) : null;
    if (creator?.role === 'operator') this.sessionManager.updateSession(sessionId, { reportsTo: creator.id });

    // A session is always made for its project; the runtime group is an optional
    // overlay. Placement is skipped entirely when no group manager is wired.
    const placement = this.runtimeGroupManager
      ? placeSessionInRuntimeGroup(this.runtimeGroupManager, {
          runtimeGroupId: opts.runtimeGroupId,
          creatorSessionId: opts.creatorSessionId,
          newSessionId: sessionId,
        })
      : null;

    return {
      id: sessionId,
      ...(placement
        ? { runtimeGroupId: placement.runtimeGroupId, runtimeGroupName: placement.runtimeGroupName }
        : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Runtime session groups (manageable overlay). Directory/project grouping is
  // covered by directory_list / project_list / session_list — not duplicated here.
  // ---------------------------------------------------------------------------

  listSessionGroups(): RuntimeGroup[] {
    return this.requireRuntimeGroupManager().list();
  }

  createSessionGroup(name: string): RuntimeGroup {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('name is required');
    return this.requireRuntimeGroupManager().create(trimmed);
  }

  addSessionToGroup(groupId: string, sessionRef: string): RuntimeGroup {
    const manager = this.requireRuntimeGroupManager();
    const session = this.findSession(sessionRef);
    if (!session) throw new Error(`Session not found: ${sessionRef}`);
    const group = manager.addSession(groupId, session.id);
    if (!group) throw new Error(`Runtime group not found: ${groupId}`);
    return group;
  }

  removeSessionFromGroups(sessionRef: string): { ok: true } {
    const manager = this.requireRuntimeGroupManager();
    const session = this.findSession(sessionRef);
    if (!session) throw new Error(`Session not found: ${sessionRef}`);
    manager.removeSessionEverywhere(session.id);
    return { ok: true };
  }

  renameSessionGroup(groupId: string, name: string): RuntimeGroup {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('name is required');
    const group = this.requireRuntimeGroupManager().rename(groupId, trimmed);
    if (!group) throw new Error(`Runtime group not found: ${groupId}`);
    return group;
  }

  closeSessionGroup(groupId: string): { ok: true } {
    const removed = this.requireRuntimeGroupManager().closeGroup(groupId);
    if (!removed) throw new Error(`Runtime group not found: ${groupId}`);
    return { ok: true };
  }

  /**
   * Continue a session under another CLI: strip its transcript, spawn the new
   * CLI in the same directory and runtime group with a prompt to read it, and
   * (by default) close the source — it lands in the recycle bin, restorable.
   */
  switchCli(
    sessionRef: string,
    cliType: string,
    opts: { handover?: string; closeSource?: boolean; creatorSessionId?: string; name?: string } = {},
  ): { ok: true; oldSessionId: string; newSessionId: string; transcriptFile: string; sourceClosed: boolean } {
    const source = this.findSession(sessionRef);
    if (!source) throw new Error(`Session not found: ${sessionRef}`);
    if (!source.workingDir) throw new Error(`Session "${source.name}" has no working directory to continue in`);
    this.requireCliEntry(cliType);

    const transcriptFile = writeStrippedTranscript(source);
    const group = this.runtimeGroupManager?.groupForSession(source.id);
    const created = this.spawnCli(cliType, source.workingDir, opts.name ?? source.name, {
      ...(opts.creatorSessionId ? { creatorSessionId: opts.creatorSessionId } : {}),
      runtimeGroupId: group?.id ?? 'none',
      initialPrompt: buildTranscriptResumePrompt(transcriptFile, opts.handover),
    });
    // Before the close: closing clears the source's artifacts.
    this.copySessionArtifacts?.(source.id, created.id);

    const closeSource = opts.closeSource !== false && !source.locked;
    if (closeSource) this.closeSession(source.id);
    logger.info(`[HelmControlService] session_switch_cli "${source.name}" ${source.cliType} → ${cliType} (${created.id})`);
    return { ok: true, oldSessionId: source.id, newSessionId: created.id, transcriptFile, sourceClosed: closeSource };
  }

  /**
   * Fork a session: the same CLI reads back a stripped copy of the transcript
   * in a new session alongside it, so the two can diverge from the same history.
   */
  cloneSession(sessionRef: string, opts: { handover?: string; creatorSessionId?: string } = {}) {
    const source = this.findSession(sessionRef);
    if (!source) throw new Error(`Session not found: ${sessionRef}`);
    return this.switchCli(source.id, source.cliType, { ...opts, closeSource: false, name: `${source.name} (clone)` });
  }

  closeSession(sessionRef: string): { ok: true } {
    const session = this.findSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }
    if (session.locked) {
      throw new Error(`Session "${session.name}" is locked and cannot be closed`);
    }
    try {
      this.ptyManager.kill(session.id);
    } catch (killError) {
      logger.warn(`[HelmControlService] Failed to kill PTY for session ${session.id}: ${killError}`);
    }
    this.sessionManager.removeSession(session.id);
    return { ok: true };
  }

  setSessionLocked(sessionRef: string, locked: boolean): { ok: true; locked: boolean } {
    const session = this.findSession(sessionRef);
    if (!session) throw new Error(`Session not found: ${sessionRef}`);
    this.sessionManager.setSessionLocked(session.id, locked);
    return { ok: true, locked };
  }

  setSessionFrozen(sessionRef: string, frozen: boolean): { ok: true; frozen: boolean } {
    const session = this.findSession(sessionRef);
    if (!session) throw new Error(`Session not found: ${sessionRef}`);
    this.sessionManager.setSessionFrozen(session.id, frozen);
    return { ok: true, frozen };
  }

  setSessionKeepWarm(sessionRef: string, on: boolean): { ok: true; keepWarm: boolean; keepWarmUntilEpochMs?: number } {
    const session = this.findSession(sessionRef);
    if (!session) throw new Error(`Session not found: ${sessionRef}`);
    const now = Date.now();
    const until = on
      ? (session.keepWarmUntil != null && session.keepWarmUntil > now
        ? session.keepWarmUntil
        : now + KEEP_WARM_DEFAULT_MS)
      : undefined;
    this.sessionManager.updateSession(session.id, { keepWarmUntil: until });
    return { ok: true, keepWarm: on, ...(until != null ? { keepWarmUntilEpochMs: until } : {}) };
  }

  /** AI-side mission write; validation lives in SessionManager (shared with IPC). */
  setSessionMission(sessionRef: string, text: string): { ok: true; mission: SessionInfo['mission'] | null } {
    const session = this.findSession(sessionRef);
    if (!session) throw new Error(`Session not found: ${sessionRef}`);
    const updated = this.sessionManager.setMission(session.id, text, 'ai');
    return { ok: true, mission: updated.mission ?? null };
  }

  renameSession(sessionRef: string, name: string): { ok: true } {
    const session = this.findSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }
    this.sessionManager.renameSession(session.id, name.trim());
    return { ok: true };
  }

  setAiagentState(sessionRef: string, state: 'planning' | 'implementing' | 'completed' | 'idle'): { ok: true } {
    const session = this.findSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }

    this.sessionManager.updateSession(session.id, { aiagentState: state });
    return { ok: true };
  }

  async readSessionTerminal(
    sessionRef: string,
    requestedLines = 50,
    mode: TerminalReadMode = 'both',
    stripBlankLines = false,
  ): Promise<SessionTerminalTailResponse> {
    const session = this.findSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }
    if (!Number.isInteger(requestedLines) || requestedLines < 1) {
      throw new Error('lines must be a positive integer');
    }

    const screen = mode === 'screen'
      ? await this.ptyManager.getTerminalScreenTail(session.id, requestedLines)
      : undefined;
    const tail: TerminalTail = mode === 'screen'
      ? {}
      : this.ptyManager.getTerminalTail(session.id, requestedLines, mode, stripBlankLines);
    const rawLength = tail.raw?.length ?? 0;
    const strippedLength = tail.stripped?.length ?? 0;

    return {
      sessionId: session.id,
      name: session.name,
      cliType: session.cliType,
      cliTypeName: this.configLoader.getCliTypeLabel(session.cliType),
      workingDir: session.workingDir,
      returnedLines: Math.max(rawLength, strippedLength, screen?.length ?? 0),
      ptyRunning: this.ptyManager.has(session.id),
      ...(tail.lastOutputAt !== undefined ? { lastOutputAt: tail.lastOutputAt } : {}),
      ...(tail.raw ? { raw: tail.raw } : {}),
      ...(tail.stripped ? { stripped: tail.stripped } : {}),
      ...(screen ? { screen } : {}),
    };
  }

  claimSessionPlan(sessionRef: string, planId: string): { ok: true } {
    return this.planService.claimPlan(sessionRef, planId);
  }

  private toSessionSummary(session: SessionInfo): SessionSummary {
    // While the dot is green, the session is active right now, so report "now".
    // Otherwise report the frozen last-active moment (fall back to createdAt).
    const isActive = session.activityLevel === 'active';
    const lastActiveMs = isActive ? Date.now() : (session.lastActiveAt ?? session.createdAt);
    const cliEntry = this.configLoader.getCliTypeEntry(session.cliType);
    const gitBranch = session.remote ? undefined : this.gitBranchResolver.get(session.workingDir);
    return {
      id: session.id,
      name: session.name,
      cliType: session.cliType,
      cliTypeName: this.configLoader.getCliTypeLabel(session.cliType),
      workingDir: session.workingDir,
      ...(gitBranch ? { gitBranch } : {}),
      projectId: session.projectId,
      projectPath: session.projectPath,
      state: session.state,
      questionPending: session.questionPending,
      cliSessionName: session.cliSessionName,
      currentPlanId: session.currentPlanId,
      windowId: session.windowId,
      ...(session.createdAt != null
        ? { createdAtEpochMs: session.createdAt, createdAtIso: new Date(session.createdAt).toISOString() }
        : {}),
      ...(lastActiveMs != null
        ? { lastActiveAtEpochMs: lastActiveMs, lastActiveAtIso: new Date(lastActiveMs).toISOString() }
        : {}),
      ...(session.activityLevel ? { activityLevel: session.activityLevel } : {}),
      ...(session.createdByPeerId ? { createdByPeerId: session.createdByPeerId } : {}),
      ...(session.remote ? { remote: { ...session.remote } } : {}),
      ...(session.aiagentState ? { aiagentState: session.aiagentState } : {}),
      ...(session.locked ? { locked: true } : {}),
      ...(session.frozen ? { frozen: true } : {}),
      ...(session.keepWarmUntil != null && session.keepWarmUntil > Date.now()
        ? { keepWarmUntilEpochMs: session.keepWarmUntil } : {}),
      ...(session.lastPromptAt != null ? { lastPromptAtEpochMs: session.lastPromptAt } : {}),
      cacheWarnMinutes: warnAfterMs(cliEntry) / 60_000,
      cacheExpireMinutes: expireAfterMs(cliEntry) / 60_000,
      ...(cliEntry?.noPromptCache ? { noPromptCache: true } : {}),
      ...(session.mission ? { mission: { ...session.mission } } : {}),
      ...(session.role ? { role: session.role } : {}),
      ...(session.apiTool ? { apiTool: true } : {}),
      ...(session.comfyUiTool ? { comfyUiTool: true } : {}),
      ...(session.comfyUiProfiles ? { comfyUiProfiles: session.comfyUiProfiles } : {}),
      ...(session.comfyUiImageSizes ? { comfyUiImageSizes: session.comfyUiImageSizes } : {}),
      ...(session.subagentOf ? { subagentOf: session.subagentOf } : {}),
      ...(session.pendingSubagents ? { pendingSubagents: session.pendingSubagents } : {}),
    };
  }

  private contextSizeFor(session: SessionInfo): SessionContextSize {
    const cliEntry = this.configLoader.getCliTypeEntry(session.cliType);
    const apiContext = session.apiTool ? this.apiContextSizeLookup?.(session.id) : undefined;
    return resolveSessionContextSize({
      cliTranscriptPath: session.cliTranscriptPath,
      provider: cliEntry?.provider,
      apiTool: session.apiTool,
      comfyUiTool: session.comfyUiTool,
      remote: session.remote,
    }, {
      contextWindow: cliEntry?.contextWindow,
      ...(apiContext ? { apiContext } : {}),
    });
  }

  private findSession(sessionRef: string): SessionInfo | null {
    const nameMatches = this.sessionManager.getAllSessions().filter((session) => session.name === sessionRef);
    if (nameMatches.length > 1) {
      throw new Error(`Multiple sessions found with name: ${sessionRef}. Use sessionId instead.`);
    }
    // Names are user-facing handles, so resolve exact names before IDs to avoid
    // routing a handoff to an unrelated session when a ref could be interpreted both ways.
    if (nameMatches.length === 1) return nameMatches[0];
    return this.sessionManager.getSession(sessionRef);
  }

  /**
   * MCP callers address CLI types by whatever handle they have — a uuid, an old
   * slug, or the display name they saw in `directory_list`. All three go through
   * the one resolver so the rest of this service only ever deals in uuids.
   */
  private requireCliEntry(cliType: string) {
    const resolved = this.configLoader.resolveCliType(cliType);
    if (!resolved) {
      throw new Error(`Unknown CLI type: ${cliType}`);
    }
    return resolved;
  }

  private requireWorkingDirectory(dirPath: string) {
    return resolveWorkingDirectory(this.configLoader, this.projectStore, dirPath);
  }
}
