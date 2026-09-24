import { EventEmitter } from 'events';
import type { SessionInfo, SessionChangeEvent, SessionAddedEvent, SessionRemovedEvent, SessionUpdatedEvent } from '../types/session.js';
import { saveSessions, loadSessions } from './persistence.js';
import { logger } from '../utils/logger.js';
import type { ProjectStore } from './project-store.js';
import { normalizeProjectPath } from './project-identity.js';
import { normalizeMissionBarHeight, normalizeMissionText, isSessionMission } from './mission.js';
import type { SessionMission } from '../types/session.js';

/**
 * Manages CLI sessions, tracking active sessions and handling focus switching.
 *
 * ## Events
 *
 * SessionManager extends EventEmitter and emits the following events that
 * external code can subscribe to:
 *
 * - `session:added`   (SessionAddedEvent)   — A new session was registered.
 * - `session:removed` (SessionRemovedEvent)  — A session was removed.
 * - `session:updated` (SessionUpdatedEvent)  — Session metadata changed.
 * - `session:changed` (SessionChangeEvent)   — The active session changed
 *                                              (including when cleared to null).
 */
export class SessionManager extends EventEmitter {
  private sessions: Map<string, SessionInfo> = new Map();
  private activeSessionId: string | null = null;
  private sessionOrder: string[] = [];

  constructor(private readonly projectStore?: ProjectStore) {
    super();
  }

  /**
   * Add a new CLI session
   * @param sessionInfo - Session information
   */
  addSession(sessionInfo: SessionInfo, skipPersist = false): void {
    this.applyProjectIdentity(sessionInfo);
    const { id } = sessionInfo;

    if (this.sessions.has(id)) {
      throw new Error(`Session with id "${id}" already exists`);
    }

    // Stamp creation/last-active times on first registration. Preserved on restore
    // (restored sessions already carry persisted values, so we never overwrite them).
    if (sessionInfo.createdAt === undefined) {
      sessionInfo.createdAt = Date.now();
    }
    if (sessionInfo.lastActiveAt === undefined) {
      sessionInfo.lastActiveAt = sessionInfo.createdAt;
    }

    this.sessions.set(id, sessionInfo);
    this.sessionOrder.push(id);

    // Set as active if it's the first session
    if (this.sessions.size === 1) {
      this.setActiveSession(id, skipPersist);
    }

    if (!skipPersist) {
      this.persistSessions();
    }

    const event: SessionAddedEvent = {
      ...sessionInfo,
      timestamp: Date.now()
    };
    this.emit('session:added', event);
  }

  /**
   * Remove a session
   * @param sessionId - Session ID to remove
   */
  removeSession(sessionId: string, options: { force?: boolean } = {}): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session with id "${sessionId}" does not exist`);
    }
    if (session.locked && !options.force) {
      throw new Error(`Session "${session.name}" is locked and cannot be closed`);
    }

    this.sessions.delete(sessionId);
    this.sessionOrder = this.sessionOrder.filter(id => id !== sessionId);

    // If we removed the active session, switch to another
    if (this.activeSessionId === sessionId) {
      if (this.sessionOrder.length > 0) {
        // Switch to the next available session
        this.setActiveSession(this.sessionOrder[0]);
      } else {
        this.activeSessionId = null;
        const event: SessionChangeEvent = {
          sessionId: null,
          previousSessionId: sessionId,
          timestamp: Date.now()
        };
        this.emit('session:changed', event);
      }
    }

    this.persistSessions();

    const event: SessionRemovedEvent = {
      sessionId,
      session: { ...session },
      timestamp: Date.now()
    };
    this.emit('session:removed', event);
  }

  /**
   * Switch to the next session in order
   */
  nextSession(): void {
    if (this.sessionOrder.length === 0) {
      return;
    }

    const currentIndex = this.activeSessionId
      ? this.sessionOrder.indexOf(this.activeSessionId)
      : -1;

    const nextIndex = (currentIndex + 1) % this.sessionOrder.length;
    this.setActiveSession(this.sessionOrder[nextIndex]);
  }

  /**
   * Switch to the previous session in order
   */
  previousSession(): void {
    if (this.sessionOrder.length === 0) {
      return;
    }

    const currentIndex = this.activeSessionId
      ? this.sessionOrder.indexOf(this.activeSessionId)
      : -1;

    const prevIndex = currentIndex <= 0
      ? this.sessionOrder.length - 1
      : currentIndex - 1;

    this.setActiveSession(this.sessionOrder[prevIndex]);
  }

  /**
   * Get the current active session
   * @returns Active session info or null if no active session
   */
  getActiveSession(): SessionInfo | null {
    if (!this.activeSessionId) {
      return null;
    }
    return this.sessions.get(this.activeSessionId) ?? null;
  }

  /**
   * Set a session as active
   * @param sessionId - Session ID to activate
   */
  setActiveSession(sessionId: string, skipPersist = false): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session with id "${sessionId}" does not exist`);
    }

    const previousId = this.activeSessionId;

    // Only emit if actually changing
    if (previousId !== sessionId) {
      this.activeSessionId = sessionId;

      if (!skipPersist) {
        this.persistSessions();
      }

      const event: SessionChangeEvent = {
        sessionId,
        previousSessionId: previousId,
        timestamp: Date.now()
      };
      this.emit('session:changed', event);
    }
  }

  /**
   * Get a session by ID
   * @param sessionId - Session ID
   * @returns Session info or null if not found
   */
  getSession(sessionId: string): SessionInfo | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Find a session by its display name.
   * Returns undefined if not found or if multiple sessions share the same name
   * (ambiguous match — prevents routing to the wrong session).
   */
  findByName(name: string): SessionInfo | undefined {
    const matches = this.getAllSessions().filter(s => s.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Update a session's fields in-place.
   * @param sessionId - Session ID
   * @param updates - Partial fields to update
   */
  updateSession(sessionId: string, updates: Partial<SessionInfo>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session with id "${sessionId}" does not exist`);
    }
    Object.assign(session, updates);
    this.applyProjectIdentity(session);
    this.persistSessions();

    const event: SessionUpdatedEvent = {
      ...session,
      timestamp: Date.now(),
    };
    this.emit('session:updated', event);
  }

  /** Throw when a deliberate close operation targets a locked session. */
  assertSessionClosable(sessionId: string): SessionInfo {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session with id "${sessionId}" does not exist`);
    if (session.locked) throw new Error(`Session "${session.name}" is locked and cannot be closed`);
    return session;
  }

  /** Persist a session lock change and notify every projection. */
  setSessionLocked(sessionId: string, locked: boolean): SessionInfo {
    this.updateSession(sessionId, { locked });
    return this.sessions.get(sessionId)!;
  }

  /**
   * Set or clear the session's mission TL;DR. Validation is shared with every
   * write path (src/session/mission.ts): over-limit text throws BEFORE any
   * mutation, so the existing mission survives a rejected write. An empty
   * string clears — the key stays present (undefined) on the update event
   * because the renderer spread-merges updates.
   */
  setMission(sessionId: string, text: string, setBy: SessionMission['setBy']): SessionInfo {
    if (!this.sessions.has(sessionId)) throw new Error(`Session with id "${sessionId}" does not exist`);
    const normalized = normalizeMissionText(text);
    const mission = normalized ? { text: normalized, setBy, setAt: Date.now() } : undefined;
    this.updateSession(sessionId, { mission });
    return this.sessions.get(sessionId)!;
  }

  /** Persist the user's chosen mission-bar height (clamped, rounded px). */
  setMissionBarHeight(sessionId: string, px: number): SessionInfo {
    if (!this.sessions.has(sessionId)) throw new Error(`Session with id "${sessionId}" does not exist`);
    this.updateSession(sessionId, { missionBarHeight: normalizeMissionBarHeight(px) });
    return this.sessions.get(sessionId)!;
  }

  /**
   * Recycle-bin restore: re-apply the mission verbatim (keeping who set it and
   * when) and the bar height captured at close time. Malformed values are ignored.
   */
  restoreMission(sessionId: string, mission: unknown, missionBarHeight: unknown): void {
    const updates: Partial<SessionInfo> = {};
    if (isSessionMission(mission)) updates.mission = { ...mission };
    if (typeof missionBarHeight === 'number' && Number.isFinite(missionBarHeight)) {
      updates.missionBarHeight = normalizeMissionBarHeight(missionBarHeight);
    }
    if (Object.keys(updates).length > 0) this.updateSession(sessionId, updates);
  }

  /**
   * Get all sessions
   * @returns Array of all sessions in order
   */
  getAllSessions(): SessionInfo[] {
    return this.sessionOrder
      .map(id => this.sessions.get(id))
      .filter((session): session is SessionInfo => session !== undefined);
  }

  /**
   * Get the number of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Check if a session exists
   * @param sessionId - Session ID to check
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Rename a session
   * @param sessionId - Session ID to rename
   * @param newName - New display name (trimmed, max 50 chars)
   * @returns The updated session info
   * @throws Error if session doesn't exist or name is invalid
   */
  renameSession(sessionId: string, newName: string): SessionInfo {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session with id "${sessionId}" does not exist`);
    }

    const trimmedName = newName.trim();
    if (trimmedName.length === 0) {
      throw new Error('Session name cannot be empty');
    }
    if (trimmedName.length > 50) {
      throw new Error('Session name cannot exceed 50 characters');
    }

    // Only update if name actually changed
    if (session.name !== trimmedName) {
      session.name = trimmedName;
      this.persistSessions();

      // Emit both events: updated carries the new metadata, changed signals active-session reorder
      const updatedEvent: SessionUpdatedEvent = {
        ...session,
        timestamp: Date.now(),
      };
      this.emit('session:updated', updatedEvent);

      const changedEvent: SessionChangeEvent = {
        sessionId,
        previousSessionId: this.activeSessionId,
        timestamp: Date.now()
      };
      this.emit('session:changed', changedEvent);

      return session;
    }

    return session;
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.sessions.clear();
    this.sessionOrder = [];
    const previousId = this.activeSessionId;
    this.activeSessionId = null;

    if (previousId !== null) {
      const event: SessionChangeEvent = {
        sessionId: null,
        previousSessionId: previousId,
        timestamp: Date.now()
      };
      this.emit('session:changed', event);
    }

    this.persistSessions();
  }

  /**
   * Restore sessions from disk that were persisted before a restart/crash.
   * Skips sessions that already exist in memory.
   */
  restoreSessions(): SessionInfo[] {
    const saved = loadSessions();
    for (const session of saved) {
      if (!this.getSession(session.id)) {
        this.addSession(session, true);
      }
    }
    if (saved.length > 0) {
      this.persistSessions();
    }
    return saved;
  }

  /** Write current session list to disk. */
  private persistSessions(): void {
    this.projectStore?.save();
    saveSessions(this.getAllSessions());
  }

  private applyProjectIdentity(session: SessionInfo): void {
    if (!this.projectStore || !session.workingDir) return;
    const project = this.projectStore.findByPath(session.workingDir);
    session.projectId = project?.id;
    session.projectPath = normalizeProjectPath(session.workingDir);
  }
}
