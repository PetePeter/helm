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

/** Surface where the user most recently submitted a prompt. */
export type UserPromptSource = 'terminal' | 'phone';

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
  /** The CLI's OWN session/thread id, as reported by its hooks (`session_id`).
   *  Distinct from cliSessionName, which Helm mints. Resolves `{cliThreadId}` in
   *  resumeCommand — codex resumes by thread UUID. Newest reported id wins. */
  cliThreadId?: string;
  /** Absolute path of the CLI's own conversation log, as reported by its hooks
   *  (`transcript_path`). Source for quick compact and CLI switch. Newest wins. */
  cliTranscriptPath?: string;
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
  /** Set when this row is a VIEW of a fleet peer's session (Remote): its PTY
   *  lives on `peerId` as `sessionId`, streamed here. Ephemeral — remote rows
   *  are never persisted, recycle-binned or resume-spawned locally. */
  remote?: { peerId: string; sessionId: string };
  /** Id of the paired phone (MobileDevice record id) that created this session,
   *  when it was spawned by an inbound mobile proxy call rather than locally.
   *  Drives the MobileGate ownership rule — a phone may only close its own
   *  sessions. Persists across restarts. */
  createdByMobileDeviceId?: string;
  /** The operator session this one works for: set when the operator creates it,
   *  so it reports progress, results and questions back to the operator rather
   *  than the user. Cleared once the user messages it directly. Persists. */
  reportsTo?: string;
  /** When the session last received a prompt (epoch ms) — the session row's
   *  timer counts from it. Set by the UserPromptSubmit hook and by Enter typed
   *  on the desktop. Persists. */
  lastPromptAt?: number;
  /** Timestamp and source of the last actual user-submitted prompt. */
  lastUserPromptAt?: number;
  lastUserPromptSource?: UserPromptSource;
  /** Keep-warm is on until this epoch ms: KeepWarmer pings the session 10 s
   *  before its CLI's short prompt cache would lapse, so it never does. Persists. */
  keepWarmUntil?: number;
  /** Refuse ALL stdin — desktop keys, other sessions, schedules, chat, Mess
   *  pokes — until the user unfreezes it. Persists. */
  frozen?: boolean;
  /** Prevent deliberate user, MCP, or Telegram closure until explicitly cleared. */
  locked?: boolean;
  /** Hook-reported turn failure (G3, Claude StopFailure — e.g. a usage limit or
   *  API error that killed the turn). Set when the CLI reports the stall,
   *  cleared when work resumes. Persists across restarts so a stall that
   *  happened while you were away is still visible; unlike a silent terminal,
   *  this is fact, not a guess from timing. */
  hookStall?: { at: number; reason: string };
  /** Consecutive G8 auto-continues issued. Session-row visibility for an
   *  in-progress loop — an active loop must never be invisible. Ephemeral:
   *  NOT persisted; cleared when a Stop is finally allowed. (G10 removed the
   *  per-session loopDriving opt-in — autoImplement on the plan is the only
   *  consent.) */
  loopContinues?: number;
  /** The session's TL;DR — what it is meant to be doing. Set by the user (UI)
   *  or the AI (MCP session_mission_set); current value only, no history.
   *  Persists across restarts and recycle-bin restore. See docs/mission-statement.md. */
  mission?: SessionMission;
  /** Per-session height (px) of the resizable mission bar. Persists. */
  missionBarHeight?: number;
  /** System role. 'operator' marks the router-only "Helm" singleton voice
   *  clients talk to (docs/voice-operator.md). Persists; clients match the
   *  literal string, so it is a wire contract. */
  role?: SessionRole;
  /** An API-tool session: Helm hosts its agent loop (no CLI) and its pane
   *  defaults to the chat view. Ephemeral — re-derived from the CLI type at
   *  every (resume) spawn, so never persisted. */
  apiTool?: boolean;
  /** Set on a subagent session: the session whose Agent call spawned it. Such rows
   *  are hidden from session pickers — the parent shows a 🔥 count instead.
   *  Ephemeral: subagents close when they answer, and are never resumed. */
  subagentOf?: string;
  /** Subagents this session is waiting on right now (the 🔥 badge). Ephemeral. */
  pendingSubagents?: number;
}

/** Known system roles. Only one today; unknown values drop on load. */
export type SessionRole = 'operator';

/** A session's mission statement. Text is trimmed, 1–500 chars (src/session/mission.ts). */
export interface SessionMission {
  text: string;
  setBy: 'user' | 'ai';
  /** Epoch ms of the last change. */
  setAt: number;
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
