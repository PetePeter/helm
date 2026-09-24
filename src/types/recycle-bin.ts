import type { SessionMission } from './session.js';

/**
 * Recycle-bin entry — a recoverable record of a closed session.
 *
 * Only sessions that carried a `cliSessionName` (the UUID used to resume the
 * CLI-internal session) are recoverable, so every entry always has one.
 */
export interface RecycleBinEntry {
  /** Stable id for this bin entry (UUID). Distinct from the original session id. */
  id: string;
  /** Original hub session id at close time (informational). */
  sessionId: string;
  /** Display name the session had when closed. */
  name: string;
  /** CLI type (e.g. 'claude-code'), used to re-spawn on restore. */
  cliType: string;
  /** Working directory the session ran in — also its recycle-bin group. */
  workingDir: string;
  /** CLI-internal resume UUID. Passed as resumeSessionName when restoring. */
  cliSessionName: string;
  /** The CLI's own thread id at close time (SessionInfo.cliThreadId) — resolves `{cliThreadId}` on restore. */
  cliThreadId?: string;
  /** Epoch ms the session was closed / added to the bin. */
  closedAt: number;
  /** Project the session belonged to at close time — used for the bin's Project tree level. Absent for entries whose dir maps to no project (or pre-dating this field). */
  projectId?: string;
  /** The project's display name at close time (captured so the tree needn't re-resolve id→name). */
  projectName?: string;
  /** If the closed session was in a runtime group, its group id — restore re-adds it (recreating the group if gone). */
  runtimeGroupId?: string;
  /** The runtime group's display name at close time, used to recreate the group on restore. */
  runtimeGroupName?: string;
  /** The session's mission at close time — re-applied verbatim on restore. */
  mission?: SessionMission;
  /** The session's mission-bar height at close time. */
  missionBarHeight?: number;
}
