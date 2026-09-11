import { logger } from '../../utils/logger.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { SessionManager } from '../../session/manager.js';
import type { PtyManager } from '../../session/pty-manager.js';
import type { TerminalOutputMode } from '../../session/terminal-output-buffer.js';
import type { PlanStatus } from '../../types/plan.js';
import type { SessionInfo } from '../../types/session.js';
import type { SessionSummary, SessionTerminalTailResponse } from '../helm-control-service.js';
import { spawnConfiguredSession } from '../../session/configured-session-spawn.js';
import { HelmSessionPlanService } from './helm-session-plan-service.js';
import { normalizeProjectPath } from '../../session/project-identity.js';
import { resolveWorkingDirectory } from './working-dir-gate.js';
import type { ProjectStore } from '../../session/project-store.js';
import type { RuntimeGroupManager } from '../../session/runtime-group-manager.js';
import type { RuntimeGroup } from '../../types/runtime-group.js';
import { placeSessionInRuntimeGroup } from '../../session/runtime-group-placement.js';
import { peerIdFromProxySessionId } from '../peer/proxy-identity.js';
import { deviceIdFromMobileSessionId } from '../../mobile/mobile-identity.js';

/** Throw if value is null, otherwise return it. */
function requireResult<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}

/**
 * Session lifecycle: list, get, spawn, close, read terminal, set AIAGENT state.
 * Plan assignment delegated to HelmSessionPlanService.
 */
export class HelmSessionService {
  readonly planService: HelmSessionPlanService;
  /** Runtime session groups (optional overlay on top of project grouping). */
  private runtimeGroupManager: RuntimeGroupManager | null = null;

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
    return session ? this.toSessionSummary(session) : null;
  }

  spawnCli(
    cliType: string,
    dirPath: string,
    name: string,
    opts: { creatorSessionId?: string; runtimeGroupId?: string } = {},
  ): { id: string; runtimeGroupId?: string; runtimeGroupName?: string } {
    const workingDir = this.requireWorkingDirectory(dirPath);
    const cli = this.requireCliEntry(cliType);
    const sessionName = name.trim();
    // A `peer:<id>` creator means this spawn arrived over the Fleet proxy, so the
    // session is marked as remotely created; a local creator is a real UUID.
    const createdByPeerId = peerIdFromProxySessionId(opts.creatorSessionId);
    // A `mobile:<deviceId>` creator means this spawn arrived over the BLE mobile
    // proxy. Recorded so MobileGate can let that phone — and only that phone —
    // close the session again.
    const createdByMobileDeviceId = deviceIdFromMobileSessionId(opts.creatorSessionId);
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
    });

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

  readSessionTerminal(
    sessionRef: string,
    requestedLines = 50,
    mode: TerminalOutputMode = 'both',
    stripBlankLines = false,
  ): SessionTerminalTailResponse {
    const session = this.findSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }
    if (!Number.isInteger(requestedLines) || requestedLines < 1) {
      throw new Error('lines must be a positive integer');
    }

    const tail = this.ptyManager.getTerminalTail(session.id, requestedLines, mode, stripBlankLines);
    const rawLength = tail.raw?.length ?? 0;
    const strippedLength = tail.stripped?.length ?? 0;

    return {
      sessionId: session.id,
      name: session.name,
      cliType: session.cliType,
      cliTypeName: this.configLoader.getCliTypeLabel(session.cliType),
      workingDir: session.workingDir,
      returnedLines: Math.max(rawLength, strippedLength),
      ptyRunning: this.ptyManager.has(session.id),
      ...(tail.lastOutputAt !== undefined ? { lastOutputAt: tail.lastOutputAt } : {}),
      ...(tail.raw ? { raw: tail.raw } : {}),
      ...(tail.stripped ? { stripped: tail.stripped } : {}),
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
    return {
      id: session.id,
      name: session.name,
      cliType: session.cliType,
      cliTypeName: this.configLoader.getCliTypeLabel(session.cliType),
      workingDir: session.workingDir,
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
      ...(session.createdByPeerId ? { createdByPeerId: session.createdByPeerId } : {}),
      ...(session.aiagentState ? { aiagentState: session.aiagentState } : {}),
      ...(session.locked ? { locked: true } : {}),
    };
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
