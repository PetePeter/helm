import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { logger } from '../utils/logger.js';
import type { SessionInfo } from '../types/session.js';
import { SESSIONS_FILE } from './persistence-paths.js';
import { atomicWriteFileSync, isNumber, isRecord, isString } from './persistence-utils.js';
import { normalizeProjectPath } from './project-identity.js';
import { hydrateChatBindings, serializeChatBindings } from './chat/chat-bindings.js';
import { isSessionMission } from './mission.js';

function serializeSession(s: SessionInfo): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    cliType: s.cliType,
    processId: s.processId,
    ...(s.workingDir ? { workingDir: s.workingDir } : {}),
    ...(s.projectId ? { projectId: s.projectId } : {}),
    ...(s.projectPath ? { projectPath: s.projectPath } : {}),
    ...(s.cliSessionName ? { cliSessionName: s.cliSessionName } : {}),
    ...(isString(s.cliThreadId) ? { cliThreadId: s.cliThreadId } : {}),
    ...(s.currentPlanId ? { currentPlanId: s.currentPlanId } : {}),
    // Generic per-provider chat bindings REPLACE the old Telegram-only topicId
    // on disk. serializeChatBindings derives the Telegram entry from topicId and
    // carries through any provider key this version does not recognise.
    ...((): Record<string, unknown> => {
      const chatBindings = serializeChatBindings(s);
      return chatBindings ? { chatBindings } : {};
    })(),
    ...(s.aiagentState ? { aiagentState: s.aiagentState } : {}),
    // G10: no loop-driving session consent is persisted — autoImplement on
    // the plan is the only switch — and the ephemeral loopContinues counter
    // is deliberately not here either (invariant 6: persistence is an
    // explicit allow-list).
    ...(s.createdAt != null ? { createdAt: s.createdAt } : {}),
    ...(s.lastActiveAt != null ? { lastActiveAt: s.lastActiveAt } : {}),
    ...(s.createdByPeerId ? { createdByPeerId: s.createdByPeerId } : {}),
    ...(s.createdByMobileDeviceId ? { createdByMobileDeviceId: s.createdByMobileDeviceId } : {}),
    // Durable hook-derived stall (G3). Absent = not stalled; omitted key means
    // the same as no stall, so a cleared stall simply drops off disk.
    ...(isHookStall(s.hookStall) ? { hookStall: s.hookStall } : {}),
    // The mission TL;DR and its bar height (docs/mission-statement.md).
    ...(isSessionMission(s.mission) ? { mission: s.mission } : {}),
    ...(isNumber(s.missionBarHeight) ? { missionBarHeight: s.missionBarHeight } : {}),
    // System role (docs/voice-operator.md): the operator must survive a restart
    // or a second "Helm" would be spawned next launch.
    ...(s.role === 'operator' ? { role: s.role } : {}),
    // Always written, both states. The renderer folds this snapshot over its
    // cached session records with a spread merge, so an omitted key means
    // "keep whatever you had" — which would make unlocking invisible.
    locked: Boolean(s.locked),
  };
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (!isRecord(value)) return false;
  return isString(value.id) && isString(value.name) && isString(value.cliType) && isNumber(value.processId);
}

/** Type guard for the durable hook-stall record — malformed shapes drop off on load. */
function isHookStall(value: unknown): value is SessionInfo['hookStall'] {
  return isRecord(value) && isNumber(value.at) && isString(value.reason);
}

export function saveSessions(sessions: SessionInfo[], sessionsFile = SESSIONS_FILE): void {
  try {
    atomicWriteFileSync(sessionsFile, YAML.stringify({ sessions: sessions.map(serializeSession) }));
  } catch (err) {
    logger.error(`Failed to save sessions: ${err}`);
  }
}

export function loadSessions(sessionsFile = SESSIONS_FILE): SessionInfo[] {
  try {
    if (!existsSync(sessionsFile)) return [];
    const parsed = YAML.parse(readFileSync(sessionsFile, 'utf8')) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.filter(isSessionInfo).map(session => {
      // Normalize workingDir and projectPath on load to ensure consistent casing across platforms
      if (session.workingDir) {
        session.workingDir = normalizeProjectPath(session.workingDir);
      }
      if (session.projectPath) {
        session.projectPath = normalizeProjectPath(session.projectPath);
      }
      // Drop a malformed stall record rather than let a hand-edited file put a
      // bogus shape on SessionInfo (invariant 6: durable fields hydrate validated).
      if (session.hookStall !== undefined && !isHookStall(session.hookStall)) {
        delete session.hookStall;
      }
      if (session.cliThreadId !== undefined && !isString(session.cliThreadId)) {
        delete session.cliThreadId;
      }
      if (session.mission !== undefined && !isSessionMission(session.mission)) {
        delete session.mission;
      }
      if (session.missionBarHeight !== undefined && !isNumber(session.missionBarHeight)) {
        delete session.missionBarHeight;
      }
      if (session.role !== undefined && session.role !== 'operator') {
        delete session.role;
      }
      // G10 removed SessionInfo.loopDriving (the per-session loop-driving
      // opt-in). A stale key in pre-G10 sessions.yaml is not an error — the
      // value is silently dropped: consent lives on the plan's autoImplement.
      if ('loopDriving' in session) {
        delete (session as Record<string, unknown>).loopDriving;
      }
      // Rehydrate chat bindings, migrating a pre-chatBindings record's topicId.
      return hydrateChatBindings(session);
    });
  } catch (err) {
    logger.error(`Failed to load sessions: ${err}`);
    return [];
  }
}

export function clearPersistedSessions(sessionsFile = SESSIONS_FILE): void {
  try {
    if (existsSync(sessionsFile)) {
      atomicWriteFileSync(sessionsFile, YAML.stringify({ sessions: [] }));
    }
  } catch (err) {
    logger.error(`Failed to clear persisted sessions: ${err}`);
  }
}
