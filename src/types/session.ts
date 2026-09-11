/**
 * Pipeline state for an AI CLI session.
 * Updated by explicit UI controls and pipeline machinery. AIAGENT phase state is
 * stored separately in aiagentState and is updated through MCP.
 */
export type SessionState = 'implementing' | 'waiting' | 'planning' | 'completed' | 'idle';

/** Runtime-safe list of valid SessionState values for input validation. */
export const VALID_SESSION_STATES: readonly SessionState[] = ['implementing', 'waiting', 'planning', 'completed', 'idle'];

/**
 * Output-timing based activity level for the visual dot indicator.
 * Independent of SessionState — purely based on stdout/stderr output timing.
 */
export type ActivityLevel = 'active' | 'inactive' | 'idle';

/**
 * CLI session information
 */
export interface SessionInfo {
  /** Unique session identifier */
  id: string;
  /** Display name for the session */
  name: string;
  /** Type of CLI (e.g., 'claude-code', 'copilot-cli') */
  cliType: string;
  /** Process ID */
  processId: number;
  /** Working directory the session was spawned in */
  workingDir?: string;
  /** First-class project identity for the session's current repo/product context. */
  projectId?: string;
  /** Canonical project path used for shared backlog grouping across worktrees. */
  projectPath?: string;
  /** Pipeline state for manual/pipeline coordination */
  state?: SessionState;
  /** True when AIAGENT-QUESTION detected; clears on next non-question output */
  questionPending?: boolean;
  /** CLI-internal session name used for resume (UUID v4, e.g., 'a1b2c3d4-e5f6-...'). Set after spawn. */
  cliSessionName?: string;
  /** Explicit plan item to show on the session row as the current working plan. */
  currentPlanId?: string;
  /** Telegram forum topic ID for this session's topic thread. The typed view of
   *  `chatBindings.telegram` — see src/session/chat/chat-bindings.ts, which owns
   *  the mirroring in both directions. */
  topicId?: number;
  /** Where this session lives on each chat surface, keyed by provider. Generic
   *  so a third surface is a new key, not a new field; an unrecognised key is
   *  preserved across a load/save round-trip rather than dropped. */
  chatBindings?: Record<string, string | number>;
  /** Last real PTY output or session/input activity timestamp for elapsed timers. */
  lastOutputAt?: number;
  /** Wall-clock epoch MILLISECONDS when this hub session was first spawned. Persists across restarts. */
  createdAt?: number;
  /** Wall-clock epoch MILLISECONDS of when the activity dot last left green (active→inactive).
   *  While the session is currently active, MCP reports this as "now". Persists across restarts. */
  lastActiveAt?: number;
  /** Current activity dot level. Ephemeral — NOT persisted; kept in sync by the pty activity-change listener. */
  activityLevel?: ActivityLevel;
  /** BrowserWindow ID if this session is snapped out to a child window. Undefined/null means main window. */
  windowId?: number;
  /** AIAGENT state controlled by external agents (planning, implementing, completed, idle). Persists across restarts. */
  aiagentState?: 'planning' | 'implementing' | 'completed' | 'idle';
  /** Which channel the user last interacted through. Ephemeral — not persisted. */
  interactionChannel?: 'telegram' | 'desktop';
  /** Id of the remote Fleet peer that created this session, when it was spawned
   *  by an inbound peer proxy call rather than locally. Drives the sidebar's
   *  peer-created card tint. Persists across restarts. */
  createdByPeerId?: string;
  /** Id of the paired phone (MobileDevice record id) that created this session,
   *  when it was spawned by an inbound mobile proxy call rather than locally.
   *  Drives the MobileGate ownership rule — a phone may only close its own
   *  sessions. Persists across restarts. */
  createdByMobileDeviceId?: string;
  /** Prevent deliberate user, MCP, or Telegram closure until explicitly cleared. */
  locked?: boolean;
}

/**
 * Session change event data
 */
export interface SessionChangeEvent {
  /** The session that became active */
  sessionId: string | null;
  /** Previous session ID */
  previousSessionId: string | null;
  /** Timestamp of change */
  timestamp: number;
}

/**
 * Session added event data
 */
export interface SessionAddedEvent extends SessionInfo {
  timestamp: number;
}

/**
 * Session removed event data
 */
export interface SessionRemovedEvent {
  sessionId: string;
  /** Snapshot of the session at removal time (for cleanup handlers). */
  session: SessionInfo;
  timestamp: number;
}

/**
 * Session metadata updated event data
 */
export interface SessionUpdatedEvent extends SessionInfo {
  timestamp: number;
}

/**
 * Emitted when a session's pipeline state changes.
 */
export interface SessionStateChangeEvent {
  sessionId: string;
  previousState: SessionState;
  newState: SessionState;
  timestamp: number;
}

/**
 * A draft prompt memo attached to a session.
 * Composed while the CLI is busy, sent later when ready.
 */
export interface DraftPrompt {
  /** Unique draft identifier (UUID v4) */
  id: string;
  /** Owning session ID */
  sessionId: string;
  /** Short title for pill display */
  label: string;
  /** Full prompt content (sequence parser syntax) */
  text: string;
  /** Creation timestamp */
  createdAt: number;
}
