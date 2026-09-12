import { logger } from '../../utils/logger.js';
import type { HelmControlService } from '../helm-control-service.js';
import type { AuthContext } from './types.js';
import { isFleetSessionId, parseFleetSessionId } from '../peer/fleet-session-id.js';
import {
  asAiagentState,
  asArtifactKind,
  asBoolean,
  asContextBindingTargetType,
  asFiniteNumber,
  asDreamCandidateCount,
  asDreamPercentile,
  asEnum,
  asGraphDepth,
  MEMORY_SORT_FIELDS,
  MEMORY_SORT_ORDERS,
  asMemoryExportFormat,
  asPlanFilter,
  asPlanStatus,
  asPlanTypeOrNull,
  asRecord,
  asString,
  asStringArray,
  asStringValue,
  asTerminalOutputMode,
  requireBooleanResult,
  requireResult,
} from './validation.js';

/**
 * Resolve the caller's own session for session-scoped tools (artifacts). The
 * only trustworthy identity is the server-derived authContext.sessionId; throw
 * a clear error when Helm did not inject it, mirroring telegram_chat.
 */
function requireCallerSession(authContext: AuthContext, tool: string): string {
  if (!authContext.sessionId) {
    throw new Error(
      `${tool} could not determine your session. Call session_info to get your own ` +
        'sessionId and ensure Helm injected the X-Helm-Session-Id header ' +
        '(HELM_SESSION_ID env var) at startup.',
    );
  }
  return authContext.sessionId;
}

/**
 * Resolve who a session_send_* call is FROM, for the delivery envelope.
 *
 * Three cases, in order:
 *  • FLEET sender — a `fleet:<peerId>:<id>` id names a session on the peer that
 *    called us (the InboundCallGate wrapped it). It is deliberately not a local
 *    session, so the known-session check does not apply; the gate already
 *    vouched for the caller.
 *  • IMPLICIT sender — no explicit id, so the server-derived authContext is
 *    trusted as-is (session-scoped token).
 *  • EXPLICIT LOCAL sender — must match a live local session, else the caller
 *    guessed or constructed the id and the message is refused.
 */
function resolveSenderIdentity(
  listSessions: () => Array<{ id: string; name: string }>,
  args: Record<string, unknown>,
  authContext: AuthContext,
): { senderSessionId: string; senderSessionName: string } {
  const explicitSenderId = typeof args.senderSessionId === 'string' ? args.senderSessionId : undefined;
  const senderSessionId = explicitSenderId ?? authContext.sessionId;
  if (!senderSessionId) {
    throw new Error(
      'senderSessionId is required — use the HELM_SESSION_ID environment variable injected by Helm at startup.',
    );
  }
  if (isFleetSessionId(explicitSenderId)) {
    return { senderSessionId, senderSessionName: authContext.sessionName ?? senderSessionId };
  }
  if (!explicitSenderId && authContext.sessionName) {
    return { senderSessionId, senderSessionName: authContext.sessionName };
  }
  const senderSession = listSessions().find((s) => s.id === senderSessionId);
  if (!senderSession) {
    throw new Error(
      `Unknown sender session: senderSessionId "${senderSessionId}" does not match any active Helm session. ` +
        'senderSessionId must be the exact value of the HELM_SESSION_ID environment variable ' +
        'that Helm injected into your session at startup — do not guess or construct this value.',
    );
  }
  return { senderSessionId, senderSessionName: senderSession.name };
}

export interface McpToolDispatcherDeps {
  service: HelmControlService;
  setPlanStateWithValidation: (
    id: string,
    status: 'planning' | 'ready' | 'coding' | 'review' | 'blocked',
    stateInfo?: string,
  ) => unknown;
  completePlanWithValidation: (id: string, documentation: string) => unknown;
  /** Optional hook called after plan_get succeeds; used to record a read for the recap gate. */
  onPlanRead?: (planId: string) => void;
}

export async function callMcpTool(
  deps: McpToolDispatcherDeps,
  name: string,
  args: Record<string, unknown>,
  authContext: AuthContext,
): Promise<unknown> {
  const { service, setPlanStateWithValidation, completePlanWithValidation } = deps;

    logger.info(`[MCP] callTool: ${name} | session=${authContext.sessionId ?? 'anonymous'} (${authContext.sessionName ?? '-'})`);
    switch (name) {
      case 'plan_list':
        return service.listPlans(asString(args.dirPath, 'dirPath is required'), asPlanFilter(args.filter));
      case 'plan_summary':
        return service.plansSummary(asString(args.dirPath, 'dirPath is required'), asPlanFilter(args.filter));
      case 'tool_list':
        return service.listClis();
      case 'skill_list':
        return service.listSkills({
          ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}),
          ...(typeof args.dirPath === 'string' ? { dirPath: args.dirPath } : {}),
        }, authContext);
      case 'skill_get': {
        const type = typeof args.type === 'string' ? args.type : undefined;
        if (type && args.id !== undefined) {
          throw new Error('Pass either id or type to skill_get, not both');
        }
        if (type) {
          return requireResult(
            service.resolveSkill(type, {
              ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}),
              ...(typeof args.dirPath === 'string' ? { dirPath: args.dirPath } : {}),
            }),
            `Skill not found for type: ${type}`,
          );
        }
        return requireResult(
          service.getSkill(asString(args.id, 'id is required')),
          `Skill not found: ${asString(args.id, 'id is required')}`,
        );
      }
      case 'skill_submit_feedback':
        return service.submitSkillFeedback(
          asString(args.skillId, 'skillId is required'),
          Number(args.stars),
          asString(args.summary, 'summary is required'),
          typeof args.improvement === 'string' ? args.improvement : undefined,
          authContext,
        );
      case 'skill_get_feedback':
        return service.getSkillStats(asString(args.skillId, 'skillId is required'));
      case 'skill_clear_reviews':
        return service.clearSkillReviews(asString(args.skillId, 'skillId is required'));
      case 'skill_create':
        return service.createSkill({
          name: asString(args.name, 'name is required'),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...(typeof args.body === 'string' ? { body: args.body } : {}),
          ...(typeof args.type === 'string' ? { type: args.type } : {}),
          ...(typeof args.aiAmendable === 'boolean' ? { aiAmendable: args.aiAmendable } : {}),
          ...(typeof args.allProjects === 'boolean' ? { allProjects: args.allProjects } : {}),
          ...(Array.isArray(args.projectIds) ? { projectIds: args.projectIds.filter((item): item is string => typeof item === 'string') } : {}),
        });
      case 'skill_update': {
        const id = asString(args.id, 'id is required');
        const updates: Record<string, unknown> = {};
        for (const field of ['name', 'description', 'body', 'type', 'aiAmendable', 'allProjects', 'projectIds'] as const) {
          if (args[field] !== undefined) updates[field] = args[field];
        }
        if (Array.isArray(updates.projectIds)) {
          updates.projectIds = updates.projectIds.filter((item): item is string => typeof item === 'string');
        }
        return service.updateSkill(id, updates);
      }
      case 'skill_delete':
        return {
          deleted: requireBooleanResult(
            service.deleteSkill(asString(args.id, 'id is required')),
            `Skill not found: ${asString(args.id, 'id is required')}`,
          ),
        };
      case 'skill_activate': {
        const skillId = asString(args.skillId, 'skillId is required');
        const context = typeof args.context === 'string' ? args.context : undefined;
        return requireResult(
          service.activateSkill(skillId, context),
          `Skill not found: ${skillId}`,
        );
      }
      case 'plan_get': {
        const planId = asString(args.uuid, 'uuid is required');
        const plan = requireResult(
          service.getPlan(planId),
          `Plan not found: ${planId}`,
        );
        // Record the read for the completion recap gate (resolves using canonical UUID)
        deps.onPlanRead?.(plan.id);
        return plan;
      }
      case 'plan_get_id':
        return service.getPlanIdMapping(asString(args.humanId, 'humanId is required'));
      case 'plan_create':
        return service.createPlan(
          asString(args.dirPath, 'dirPath is required'),
          asString(args.title, 'title is required'),
          asString(args.description, 'description is required'),
          typeof args.type === 'string' ? (args.type as 'bug' | 'feature' | 'research') : undefined,
          typeof args.autoImplement === 'boolean' ? args.autoImplement : undefined,
        );
      case 'plan_update':
        return requireResult(
          service.updatePlan(asString(args.uuid, 'uuid is required'), {
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...(typeof args.description === 'string' ? { description: args.description } : {}),
            ...(Object.prototype.hasOwnProperty.call(args, 'type') ? { type: asPlanTypeOrNull(args.type) } : {}),
            ...(typeof args.autoImplement === 'boolean' ? { autoImplement: args.autoImplement } : {}),
            ...(typeof args.completionRecap === 'boolean' ? { completionRecap: args.completionRecap } : {}),
          }),
          `Plan not found: ${asString(args.uuid, 'uuid is required')}`,
        );
      case 'plan_delete':
        return {
          deleted: requireBooleanResult(
            service.deletePlan(asString(args.uuid, 'uuid is required')),
            `Plan not found: ${asString(args.uuid, 'uuid is required')}`,
          ),
        };
      case 'plan_set_state':
        return setPlanStateWithValidation(
          asString(args.uuid, 'uuid is required'),
          asPlanStatus(args.status),
          typeof args.stateInfo === 'string' ? args.stateInfo : undefined,
        );
      case 'plan_complete':
        return completePlanWithValidation(
          asString(args.uuid, 'uuid is required'),
          asString(args.documentation, 'documentation is required (minimum 10 characters)'),
        );
      case 'plan_context_list':
        return service.listPlanContexts(asString(args.planId, 'planId is required'));
      case 'plan_reopen':
        return requireResult(
          service.reopenPlan(asString(args.uuid, 'uuid is required')),
          `Plan ${asString(args.uuid, 'uuid is required')} could not be reopened — it may not be in done state`,
        );
      case 'plan_nextplan_link':
        service.linkPlans(
          asString(args.fromId, 'fromId is required'),
          asString(args.toId, 'toId is required'),
        );
        return { linked: true };
      case 'plan_nextplan_unlink':
        service.unlinkPlans(
          asString(args.fromId, 'fromId is required'),
          asString(args.toId, 'toId is required'),
        );
        return { unlinked: true };
      case 'sequence_list':
        return service.listPlanSequences({
          ...(typeof args.dirPath === 'string' ? { dirPath: args.dirPath } : {}),
          ...(typeof args.planId === 'string' ? { planRef: args.planId } : {}),
        });
      case 'sequence_get':
        return requireResult(
          service.getPlanSequence(asString(args.id, 'id is required')),
          `Sequence not found: ${asString(args.id, 'id is required')}`,
        );
      case 'sequence_create':
        return service.createPlanSequence({
          dirPath: asString(args.dirPath, 'dirPath is required'),
          title: asString(args.title, 'title is required'),
          ...(typeof args.missionStatement === 'string' ? { missionStatement: args.missionStatement } : {}),
          ...(typeof args.sharedMemory === 'string' ? { sharedMemory: args.sharedMemory } : {}),
        });
      case 'sequence_update':
        return service.updatePlanSequence(
          asString(args.id, 'id is required'),
          {
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...(typeof args.missionStatement === 'string' ? { missionStatement: args.missionStatement } : {}),
            ...(typeof args.sharedMemory === 'string' ? { sharedMemory: args.sharedMemory } : {}),
            ...(typeof args.order === 'number' ? { order: args.order } : {}),
            ...(typeof args.expectedUpdatedAt === 'number' ? { expectedUpdatedAt: args.expectedUpdatedAt } : {}),
          },
        );
      case 'sequence_delete':
        return {
          deleted: requireBooleanResult(
            service.deletePlanSequence(asString(args.id, 'id is required')),
            `Sequence not found: ${asString(args.id, 'id is required')}`,
          ),
        };
      case 'sequence_assign':
        return service.assignPlanSequence(
          asString(args.planId, 'planId is required'),
          args.sequenceId === null ? null : asString(args.sequenceId, 'sequenceId is required or null'),
        );
      case 'context_list':
        return service.listContexts(asString(args.projectId, 'projectId is required'));
      case 'context_create':
        return service.createContext({
          projectId: asString(args.projectId, 'projectId is required'),
          title: asString(args.title, 'title is required'),
          ...(typeof args.type === 'string' ? { type: args.type } : {}),
          ...(args.permission === 'readonly' || args.permission === 'writable' ? { permission: args.permission } : {}),
          ...(typeof args.content === 'string' ? { content: args.content } : {}),
          ...(typeof args.x === 'number' || args.x === null ? { x: args.x as number | null } : {}),
          ...(typeof args.y === 'number' || args.y === null ? { y: args.y as number | null } : {}),
        });
      case 'context_update':
        return service.updateContext(
          asString(args.id, 'id is required'),
          {
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...(typeof args.type === 'string' ? { type: args.type } : {}),
            ...(args.permission === 'readonly' || args.permission === 'writable' ? { permission: args.permission } : {}),
            ...(typeof args.content === 'string' ? { content: args.content } : {}),
            ...(typeof args.x === 'number' || args.x === null ? { x: args.x as number | null } : {}),
            ...(typeof args.y === 'number' || args.y === null ? { y: args.y as number | null } : {}),
          },
          typeof args.expectedUpdatedAt === 'number' ? args.expectedUpdatedAt : undefined,
        );
      case 'context_delete':
        return {
          deleted: requireBooleanResult(
            service.deleteContext(asString(args.id, 'id is required')),
            `Context not found: ${asString(args.id, 'id is required')}`,
          ),
        };
      case 'context_get':
        return requireResult(
          service.getContext(asString(args.id, 'id is required')),
          `Context not found: ${asString(args.id, 'id is required')}`,
        );
      case 'context_set_position':
        return service.setContextPosition(
          asString(args.id, 'id is required'),
          typeof args.x === 'number' || args.x === null ? args.x as number | null : null,
          typeof args.y === 'number' || args.y === null ? args.y as number | null : null,
        );
      case 'context_bind':
        return {
          bound: requireBooleanResult(
            service.bindContext(
              asString(args.id, 'id is required'),
              asContextBindingTargetType(args.targetType),
              asString(args.targetId, 'targetId is required'),
            ),
            `Context could not be bound to ${asString(args.targetId, 'targetId is required')}`,
          ),
        };
      case 'context_unbind':
        return {
          unbound: requireBooleanResult(
            service.unbindContext(
              asString(args.id, 'id is required'),
              asContextBindingTargetType(args.targetType),
              asString(args.targetId, 'targetId is required'),
            ),
            `Context binding not found for ${asString(args.targetId, 'targetId is required')}`,
          ),
        };
      case 'plan_attachment_list':
        return service.listPlanAttachments(asString(args.planId, 'planId is required'));
      case 'plan_attachment_add':
        return service.addPlanAttachment(
          asString(args.planId, 'planId is required'),
          {
            filePath: asString(args.filePath, 'filePath is required'),
            ...(typeof args.contentType === 'string' ? { contentType: args.contentType } : {}),
          },
        );
      case 'plan_attachment_delete':
        return {
          deleted: requireBooleanResult(
            service.deletePlanAttachment(
              asString(args.planId, 'planId is required'),
              asString(args.attachmentId, 'attachmentId is required'),
            ),
            `Attachment not found: ${asString(args.attachmentId, 'attachmentId is required')}`,
          ),
        };
      case 'plan_attachment_get':
        return service.getPlanAttachment(
          asString(args.planId, 'planId is required'),
          asString(args.attachmentId, 'attachmentId is required'),
        );
      case 'directory_list':
        return service.listDirectories();
      case 'project_create':
        return service.createProject(
          asString(args.dirPath, 'dirPath is required'),
          typeof args.name === 'string' ? args.name : undefined,
        );
      case 'project_rename':
        return service.renameProject(
          asString(args.projectId, 'projectId is required'),
          asString(args.name, 'name is required'),
        );
      case 'project_delete':
        return service.deleteProject(asString(args.projectId, 'projectId is required'));
      case 'project_list':
        return service.listProjects();
      case 'project_dir_list':
        return service.listProjectDirs(asString(args.projectId, 'projectId is required'));
      case 'project_dir_add':
        return service.addProjectDir(
          asString(args.projectId, 'projectId is required'),
          asString(args.dirPath, 'dirPath is required'),
        );
      case 'project_dir_remove':
        return service.removeProjectDir(
          asString(args.projectId, 'projectId is required'),
          asString(args.dirPath, 'dirPath is required'),
        );
      case 'session_create':
        return service.spawnCli(
          asString(args.cliType, 'cliType is required'),
          asString(args.dirPath, 'dirPath is required'),
          asString(args.name, 'name is required'),
          {
            ...(authContext.sessionId ? { creatorSessionId: authContext.sessionId } : {}),
            ...(typeof args.runtimeGroupId === 'string' ? { runtimeGroupId: args.runtimeGroupId } : {}),
          },
        );
      case 'session_group_list':
        return service.listSessionGroups();
      case 'session_group_create':
        return service.createSessionGroup(asString(args.name, 'name is required'));
      case 'session_group_add':
        return service.addSessionToGroup(
          asString(args.groupId, 'groupId is required'),
          asString(args.sessionId ?? args.name, 'sessionId or name is required'),
        );
      case 'session_group_remove':
        return service.removeSessionFromGroups(
          asString(args.sessionId ?? args.name, 'sessionId or name is required'),
        );
      case 'session_group_rename':
        return service.renameSessionGroup(
          asString(args.groupId, 'groupId is required'),
          asString(args.name, 'name is required'),
        );
      case 'session_group_close':
        return service.closeSessionGroup(asString(args.groupId, 'groupId is required'));
      case 'session_list':
        return service.listSessions(
          typeof args.dirPath === 'string' ? args.dirPath : undefined,
          typeof args.projectId === 'string' ? args.projectId : undefined,
        );
      case 'session_get':
        return requireResult(
          service.getSession(asString(args.sessionId ?? args.name, 'sessionId or name is required')),
          `Session not found: ${asString(args.sessionId ?? args.name, 'sessionId or name is required')}`,
        );
      case 'session_send_text': {
        // A fleet-addressed TARGET names a session on another machine — typically
        // the reply address this host handed a remote peer. Forward the call over
        // the fleet verbatim, with the id unwrapped to what that peer calls it;
        // the peer then delivers it locally. Checked BEFORE any local lookup,
        // since a remote id resolves to nothing here.
        const { senderSessionId, senderSessionName } = resolveSenderIdentity(
          () => service.listSessions(),
          args,
          authContext,
        );
        if (isFleetSessionId(args.sessionId as string | undefined)) {
          const fleetTarget = parseFleetSessionId(args.sessionId as string);
          if (!fleetTarget) {
            throw new Error(
              `Malformed fleet session id: "${args.sessionId}". Expected fleet:<peerId>:<sessionId>.`,
            );
          }
          return service.peerCall(fleetTarget.peerId, 'session_send_text', {
            sessionId: fleetTarget.realSessionId,
            text: asString(args.text, 'text is required'),
            senderSessionId,
            ...(typeof args.expectsResponse === 'boolean' ? { expectsResponse: args.expectsResponse } : {}),
          });
        }
        return service.sendTextToSession(
          asString(args.sessionId, 'sessionId is required'),
          asString(args.text, 'text is required'),
          {
            senderSessionId,
            senderSessionName,
            ...(typeof args.expectsResponse === 'boolean' ? { expectsResponse: args.expectsResponse } : {}),
          },
        );
      }
      case 'session_send_input': {
        const { senderSessionId, senderSessionName } = resolveSenderIdentity(
          () => service.listSessions(),
          args,
          authContext,
        );
        return service.sendInputToSession(
          asString(args.sessionId, 'sessionId is required'),
          asString(args.sequence, 'sequence is required'),
          {
            senderSessionId,
            senderSessionName,
            ...(typeof args.impliedSubmit === 'boolean' ? { impliedSubmit: args.impliedSubmit } : {}),
            ...(typeof args.verify === 'boolean' ? { verify: args.verify } : {}),
          },
        );
      }
      case 'session_clear': {
        // Worker-control: clears the TARGET session (sessionId required); sender is for audit only.
        const explicitSenderId = typeof args.senderSessionId === 'string' ? args.senderSessionId : undefined;
        const senderSessionId = explicitSenderId ?? authContext.sessionId;
        return service.clearSession(asString(args.sessionId, 'sessionId is required'), {
          ...(senderSessionId ? { senderSessionId } : {}),
          ...(authContext.sessionName ? { senderSessionName: authContext.sessionName } : {}),
          ...(typeof args.context === 'string' ? { context: args.context } : {}),
        });
      }
      case 'session_compact':
        return service.compactSession(asString(args.sessionId, 'sessionId is required'), {
          ...(typeof args.instruction === 'string' ? { instruction: args.instruction } : {}),
          ...(typeof args.handover === 'string' ? { handover: args.handover } : {}),
        });
      case 'session_export':
        return service.exportSession(asString(args.sessionId, 'sessionId is required'), {
          path: asString(args.path, 'path is required'),
        });
      case 'session_read_terminal':
        return service.readSessionTerminal(
          asString(args.sessionId ?? args.name, 'sessionId or name is required'),
          typeof args.lines === 'number' ? args.lines : undefined,
          asTerminalOutputMode(args.mode),
          typeof args.stripBlankLines === 'boolean' ? args.stripBlankLines : undefined,
        );
      case 'session_plan_claim':
        return service.claimSessionPlan(
          asString(args.sessionId ?? args.name, 'sessionId or name is required'),
          asString(args.planId, 'planId is required'),
        );
      case 'session_info':
        return service.getSessionInfo(authContext);
      case 'session_set_aiagent_state':
        return service.setAiagentState(
          asString(args.sessionId ?? args.name, 'sessionId or name is required'),
          asAiagentState(args.state, 'state must be one of planning, implementing, completed, or idle'),
        );
      case 'session_set_locked':
        return service.setSessionLocked(
          asString(args.sessionId ?? args.name, 'sessionId or name is required'),
          asBoolean(args.locked, 'locked must be true or false'),
        );
      case 'session_rename':
        return service.renameSession(
          asString(args.sessionId ?? args.name, 'sessionId or name is required'),
          asString(args.newName, 'newName is required'),
        );
      case 'session_close':
        return service.closeSession(asString(args.sessionId ?? args.name, 'sessionId or name is required'));
      case 'restart_helm':
        return service.restartHelm(args.resume !== false);
      case 'notify_user':
        return service.notifyUser(
          asString(args.sessionId ?? args.name, 'sessionId or name is required'),
          asString(args.title, 'title is required'),
          asString(args.content, 'content is required'),
        );
      case 'flash_attention':
        return service.flashAttention(asString(args.sessionId ?? args.name, 'sessionId or name is required'));
      case 'get_app_visibility':
        return service.getAppVisibility();
      case 'telegram_status':
        return service.getTelegramStatus();
      case 'telegram_chat': {
        // Route replies to the authenticated caller's own session topic. The only
        // trustworthy identity is the server-derived authContext.sessionId (from the
        // X-Helm-Session-Id header / session token). An explicit args.sessionId UUID
        // is accepted as a fallback for global-token callers, but resolving by NAME is
        // rejected: duplicate session names are ambiguous and silently mis-route the
        // reply to the wrong Telegram topic (cross-talk).
        const sessionRef = authContext.sessionId ?? (typeof args.sessionId === 'string' ? args.sessionId : undefined);
        if (!sessionRef) {
          throw new Error(
            'telegram_chat could not determine your session. Call session_info to get ' +
              'your own sessionId and pass it as sessionId. Ensure Helm injected the ' +
              'X-Helm-Session-Id header (HELM_SESSION_ID env var) at startup. ' +
              'Resolving by name is not allowed — duplicate session names route replies ' +
              'to the wrong Telegram topic.',
          );
        }
        const message = asString(args.message, 'message is required');
        const filePath = typeof args.filePath === 'string' ? args.filePath : undefined;
        return service.sendTelegramChat(sessionRef, message, filePath);
      }
      case 'telegram_send_voice': {
        // Mirror telegram_chat's identity resolution: route to the authenticated
        // caller's own session topic. Voice replies must never resolve by name.
        const sessionRef = authContext.sessionId ?? (typeof args.sessionId === 'string' ? args.sessionId : undefined);
        if (!sessionRef) {
          throw new Error(
            'telegram_send_voice could not determine your session. Call session_info to get ' +
              'your own sessionId and pass it as sessionId. Ensure Helm injected the ' +
              'X-Helm-Session-Id header (HELM_SESSION_ID env var) at startup. ' +
              'Resolving by name is not allowed — duplicate session names route replies ' +
              'to the wrong Telegram topic.',
          );
        }
        const text = asString(args.text, 'text is required');
        return service.sendTelegramVoice(sessionRef, text);
      }
      case 'telegram_channel_close':
        return service.closeTelegramChannel(asString(args.channelId, 'channelId is required'));
      case 'scheduler_create': {
        const planIds = (args.planIds as string[] | undefined) ?? [];
        const targetSessionId = args.targetSession === 'caller'
          ? requireCallerSession(authContext, 'scheduler_create')
          : args.targetSessionId as string | undefined;
        if (args.targetSession !== undefined && args.targetSession !== 'caller') {
          throw new Error('targetSession must be "caller" when provided');
        }
        return service.createScheduledTask({
          title: asString(args.title, 'title is required'),
          description: args.description as string | undefined,
          initialPrompt: asString(args.initialPrompt, 'initialPrompt is required'),
          // Direct mode derives the CLI type from the target session, so it is
          // optional here; the manager rejects a spawn task without one.
          cliType: (args.cliType as string | undefined) ?? '',
          dirPath: asString(args.dirPath, 'dirPath is required'),
          scheduledTime: asString(args.scheduledTime, 'scheduledTime is required'),
          scheduleKind: args.scheduleKind as 'once' | 'interval' | 'cron' | undefined,
          intervalMs: typeof args.intervalMs === 'number' ? args.intervalMs : undefined,
          cronExpression: args.cronExpression as string | undefined,
          endDate: args.endDate as string | undefined,
          planIds,
          mode: args.mode as 'spawn' | 'direct' | undefined,
          targetSessionId,
        });
      }
      case 'scheduler_list':
        return service.listScheduledTasks();
      case 'scheduler_get':
        return service.getScheduledTask(asString(args.id, 'id is required'));
      case 'scheduler_update': {
        const id = asString(args.id, 'id is required');
        const updates: Record<string, unknown> = { ...args };
        delete updates.id;
        if (updates.targetSession === 'caller') {
          updates.targetSessionId = requireCallerSession(authContext, 'scheduler_update');
        } else if (updates.targetSession !== undefined) {
          throw new Error('targetSession must be "caller" when provided');
        }
        delete updates.targetSession;
        if (typeof updates.planIds === 'undefined') delete updates.planIds;
        return service.updateScheduledTask(id, updates as Parameters<typeof service.updateScheduledTask>[1]);
      }
      case 'scheduler_cancel':
        return service.cancelScheduledTask(asString(args.id, 'id is required'));
      case 'scheduler_delete':
        return service.deleteScheduledTask(asString(args.id, 'id is required'));
      case 'artifact_create': {
        const sessionId = requireCallerSession(authContext, 'artifact_create');
        if (args.filePath !== undefined) {
          if (args.content !== undefined) throw new Error('Provide either content or filePath, not both');
          return service.createArtifactFromFile(
            sessionId,
            asString(args.filePath, 'filePath is required'),
            args.title === undefined ? undefined : asString(args.title, 'title must not be empty'),
            args.contentType === undefined ? undefined : asString(args.contentType, 'contentType must not be empty'),
          );
        }
        return service.createArtifact(
          sessionId,
          asString(args.title, 'title is required'),
          asArtifactKind(args.kind),
          asString(args.content, 'content is required'),
        );
      }
      case 'artifact_update': {
        const sessionId = requireCallerSession(authContext, 'artifact_update');
        if (args.filePath !== undefined) {
          if (args.content !== undefined) throw new Error('Provide either content or filePath, not both');
          return service.updateArtifactFromFile(
            sessionId,
            asString(args.id, 'id is required'),
            asString(args.filePath, 'filePath is required'),
            args.contentType === undefined ? undefined : asString(args.contentType, 'contentType must not be empty'),
          );
        }
        return service.updateArtifact(
          sessionId,
          asString(args.id, 'id is required'),
          asString(args.content, 'content is required'),
        );
      }
      case 'artifact_show': {
        const sessionId = requireCallerSession(authContext, 'artifact_show');
        return service.showArtifact(sessionId, asString(args.id, 'id is required'));
      }
      case 'artifact_delete': {
        const sessionId = requireCallerSession(authContext, 'artifact_delete');
        return service.deleteArtifact(sessionId, asString(args.id, 'id is required'));
      }
      case 'artifact_delete_all': {
        const sessionId = requireCallerSession(authContext, 'artifact_delete_all');
        return service.deleteAllArtifacts(sessionId);
      }
      case 'artifact_list': {
        const sessionId = requireCallerSession(authContext, 'artifact_list');
        return service.listArtifacts(sessionId);
      }
      case 'artifact_get': {
        const sessionId = requireCallerSession(authContext, 'artifact_get');
        const asFile = args.asFile === undefined ? false : asBoolean(args.asFile, 'asFile must be a boolean');
        const attachmentId = args.attachmentId === undefined
          ? undefined
          : asString(args.attachmentId, 'attachmentId must not be empty');
        return service.getArtifact(
          sessionId,
          asString(args.id, 'id is required'),
          typeof args.version === 'number' ? args.version : undefined,
          { asFile, ...(attachmentId ? { attachmentId } : {}) },
        );
      }
      case 'memory_list': {
        const sessionId = requireCallerSession(authContext, 'memory_list');
        return service.listMemories(sessionId, {
          ...(args.sortBy !== undefined
            ? { sortBy: asEnum(args.sortBy, MEMORY_SORT_FIELDS, 'sortBy') }
            : {}),
          ...(args.order !== undefined
            ? { order: asEnum(args.order, MEMORY_SORT_ORDERS, 'order') }
            : {}),
        });
      }
      case 'memory_dream': {
        const sessionId = requireCallerSession(authContext, 'memory_dream');
        return service.dreamMemories(sessionId, {
          ...(args.percentile !== undefined ? { percentile: asDreamPercentile(args.percentile) } : {}),
          ...(args.minCandidates !== undefined ? { minCandidates: asDreamCandidateCount(args.minCandidates, 'minCandidates') } : {}),
          ...(args.maxCandidates !== undefined ? { maxCandidates: asDreamCandidateCount(args.maxCandidates, 'maxCandidates') } : {}),
        });
      }
      case 'memory_set_dormant': {
        const sessionId = requireCallerSession(authContext, 'memory_set_dormant');
        return requireBooleanResult(
          service.setMemoryDormant(
            sessionId,
            asString(args.id, 'id is required'),
            asBoolean(args.dormant, 'dormant must be a boolean'),
          ),
          `Memory not found: ${String(args.id)}`,
        );
      }
      case 'memory_get': {
        const sessionId = requireCallerSession(authContext, 'memory_get');
        return requireResult(
          service.getMemory(sessionId, asString(args.id, 'id is required'), asGraphDepth(args.graphDepth)),
          `Memory not found: ${String(args.id)}`,
        );
      }
      case 'memory_create': {
        const sessionId = requireCallerSession(authContext, 'memory_create');
        return service.createMemory(sessionId, {
          tldr: asString(args.tldr, 'tldr is required'),
          content: asStringValue(args.content, 'content is required'),
        });
      }
      case 'memory_update': {
        const sessionId = requireCallerSession(authContext, 'memory_update');
        const updates: { tldr?: string; content?: string } = {};
        if (args.tldr !== undefined) updates.tldr = asString(args.tldr, 'tldr must be a non-empty string');
        if (args.content !== undefined) updates.content = asStringValue(args.content, 'content must be a string');
        if (Object.keys(updates).length === 0) throw new Error('Provide tldr and/or content to update');
        const expectedUpdatedAt = args.expectedUpdatedAt === undefined
          ? undefined
          : asFiniteNumber(args.expectedUpdatedAt, 'expectedUpdatedAt must be a finite number');
        return requireResult(
          service.updateMemory(sessionId, asString(args.id, 'id is required'), updates, expectedUpdatedAt),
          `Memory not found: ${String(args.id)}`,
        );
      }
      case 'memory_delete': {
        const sessionId = requireCallerSession(authContext, 'memory_delete');
        return requireBooleanResult(
          service.deleteMemory(sessionId, asString(args.id, 'id is required')),
          `Memory not found: ${String(args.id)}`,
        );
      }
      case 'memory_search': {
        const sessionId = requireCallerSession(authContext, 'memory_search');
        const regex = args.regex === undefined ? false : asBoolean(args.regex, 'regex must be a boolean');
        return service.searchMemories(sessionId, asStringValue(args.query, 'query is required'), {
          regex,
          graphDepth: asGraphDepth(args.graphDepth),
        });
      }
      case 'memory_graph': {
        const sessionId = requireCallerSession(authContext, 'memory_graph');
        return requireResult(
          service.graphMemory(sessionId, asString(args.rootId, 'rootId is required'), asGraphDepth(args.graphDepth)),
          `Memory not found: ${String(args.rootId)}`,
        );
      }
      case 'memory_export': {
        const sessionId = requireCallerSession(authContext, 'memory_export');
        const rootId = args.rootId === undefined ? undefined : asString(args.rootId, 'rootId must be a non-empty string');
        return service.exportMemories(
          sessionId,
          asMemoryExportFormat(args.format),
          rootId,
          asGraphDepth(args.graphDepth),
        );
      }
      case 'memory_link': {
        const sessionId = requireCallerSession(authContext, 'memory_link');
        return requireBooleanResult(
          service.linkMemory(
            sessionId,
            asString(args.fromId, 'fromId is required'),
            asString(args.toId, 'toId is required'),
          ),
          'Both memories must belong to the authenticated caller session',
        );
      }
      case 'memory_unlink': {
        const sessionId = requireCallerSession(authContext, 'memory_unlink');
        return requireBooleanResult(
          service.unlinkMemory(
            sessionId,
            asString(args.fromId, 'fromId is required'),
            asString(args.toId, 'toId is required'),
          ),
          'Memory edge not found or is outside the authenticated caller session',
        );
      }
      case 'memory_attachment_add': {
        const sessionId = requireCallerSession(authContext, 'memory_attachment_add');
        return service.addMemoryAttachment(
          sessionId,
          asString(args.memoryId, 'memoryId is required'),
          {
            filePath: asString(args.filePath, 'filePath is required'),
            filename: asString(args.filename, 'filename is required'),
            ...(args.contentType === undefined ? {} : { contentType: asString(args.contentType, 'contentType must be a non-empty string') }),
          },
        );
      }
      case 'memory_attachment_list': {
        const sessionId = requireCallerSession(authContext, 'memory_attachment_list');
        return service.listMemoryAttachments(sessionId, asString(args.memoryId, 'memoryId is required'));
      }
      case 'memory_attachment_get': {
        const sessionId = requireCallerSession(authContext, 'memory_attachment_get');
        return service.getMemoryAttachment(
          sessionId,
          asString(args.memoryId, 'memoryId is required'),
          asString(args.attachmentId, 'attachmentId is required'),
        );
      }
      case 'memory_attachment_delete': {
        const sessionId = requireCallerSession(authContext, 'memory_attachment_delete');
        return requireBooleanResult(
          service.deleteMemoryAttachment(
            sessionId,
            asString(args.memoryId, 'memoryId is required'),
            asString(args.attachmentId, 'attachmentId is required'),
          ),
          `Attachment not found: ${String(args.attachmentId)}`,
        );
      }
      case 'mess_post': {
        const sessionId = requireCallerSession(authContext, 'mess_post');
        return service.postMess(
          sessionId,
          asString(args.text, 'text is required'),
          args.to === undefined ? undefined : asString(args.to, 'to must be a non-empty session id'),
        );
      }
      case 'mess_check': {
        const sessionId = requireCallerSession(authContext, 'mess_check');
        return service.checkMess(sessionId);
      }
      case 'mess_history': {
        const sessionId = requireCallerSession(authContext, 'mess_history');
        return service.historyMess(sessionId, {
          ...(args.sinceHours === undefined ? {} : { sinceHours: asFiniteNumber(args.sinceHours, 'sinceHours must be a finite number') }),
          ...(args.limit === undefined ? {} : { limit: asFiniteNumber(args.limit, 'limit must be a finite number') }),
          ...(args.groupBy === undefined ? {} : { groupBy: asEnum(args.groupBy, ['day', 'month'] as const, 'groupBy') }),
        });
      }
      case 'mess_search': {
        const sessionId = requireCallerSession(authContext, 'mess_search');
        return service.searchMess(sessionId, {
          query: asString(args.query, 'query is required'),
          ...(args.before === undefined ? {} : { before: asFiniteNumber(args.before, 'before must be a finite number') }),
          ...(args.after === undefined ? {} : { after: asFiniteNumber(args.after, 'after must be a finite number') }),
          ...(args.limit === undefined ? {} : { limit: asFiniteNumber(args.limit, 'limit must be a finite number') }),
          ...(args.groupBy === undefined ? {} : { groupBy: asEnum(args.groupBy, ['day', 'month'] as const, 'groupBy') }),
        });
      }
      case 'peer_list':
        return service.peerList();
      case 'peer_tools':
        return service.peerTools(asString(args.peer, 'peer is required'));
      case 'peer_call':
        return service.peerCall(
          asString(args.peer, 'peer is required'),
          asString(args.tool, 'tool is required'),
          asRecord(args.args),
        );
      case 'mobile_pair_start':
        return service.mobilePairStart();
      case 'mobile_pair_status':
        return service.mobilePairStatus();
      case 'mobile_pair_confirm':
        return service.mobilePairConfirm(asBoolean(args.accepted, 'accepted is required'));
      case 'mobile_pair_cancel':
        return service.mobilePairCancel(
          args.reason === undefined ? undefined : asString(args.reason, 'reason must be a string'),
        );
      case 'mobile_device_list':
        return service.mobileDeviceList();
      case 'mobile_device_allow':
        return service.mobileDeviceAllow(
          asString(args.deviceId, 'deviceId is required'),
          asStringArray(args.allow, 'allow must be an array of strings'),
        );
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
}
