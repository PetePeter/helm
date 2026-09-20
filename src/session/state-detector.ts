import { EventEmitter } from 'events';
import type { ActivityLevel } from '../types/session.js';

export interface QuestionDetected {
  sessionId: string;
}

export interface QuestionCleared {
  sessionId: string;
}

export interface ActivityChange {
  sessionId: string;
  level: ActivityLevel;
  /** Timestamp of the last PTY output — included so renderer can sync timer display with dot. */
  lastOutputAt?: number;
}

interface SessionTracking {
  questionPending: boolean;
  lastOutputAt: number;
  activityLevel: ActivityLevel;
  /** When true, processOutput skips marker scanning (scroll redraws). */
  scrolling: boolean;
  /** When true, processOutput skips activity promotion (resize redraws). */
  resizing: boolean;
  /** When true, processOutput skips activity promotion (terminal switch/focus redraws). */
  switching: boolean;
  /** When true, processOutput skips activity promotion (post-restore shell startup). */
  restoring: boolean;
}

/** Strip ANSI escape sequences so keyword detection works on raw PTY output. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')              // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // Complete OSC sequences
    .replace(/\x1b\][^\x07\x1b]*/g, '');                  // Incomplete OSC (strip prefix)
}

const QUESTION_KEYWORD = 'AIAGENT-QUESTION';

/** Default timeout before considering a session inactive (no output for 10s) */
export const DEFAULT_INACTIVE_TIMEOUT_MS = 10_000;

/** Default timeout before considering a session idle (no output for 5 minutes) */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** How long after the last scroll input before marker scanning resumes (2s) */
export const DEFAULT_SCROLL_CLEAR_MS = 2_000;

/** How long after the last resize before activity promotion resumes (1s) */
export const DEFAULT_RESIZE_CLEAR_MS = 1_000;

/** Grace period after session restore — shell startup output is suppressed (3s) */
export const DEFAULT_RESTORE_GRACE_MS = 3_000;

/**
 * Minimum data size (in chars) that immediately promotes a session to active.
 * Smaller chunks are debounced to filter out TUI redraw noise (cursor blink,
 * spinner ticks, etc.) from Ink-based CLIs like Copilot.
 */
export const DEFAULT_ACTIVITY_PROMOTE_THRESHOLD = 32;

/**
 * Debounce window for small output chunks. If multiple small chunks arrive
 * within this window, activity promotion is delayed until the window passes
 * without new output. This prevents continuous TUI redraws from keeping the
 * dot green indefinitely while still allowing genuine small output to promote
 * after a brief pause.
 */
export const DEFAULT_ACTIVITY_DEBOUNCE_MS = 150;

export interface ActivityTimeouts {
  inactiveMs: number;
  idleMs: number;
}

/**
 * Tracks PTY activity and question markers for sessions.
 * AIAGENT phase state is intentionally not parsed from terminal text; agents
 * must update durable phase state through the MCP session_set_aiagent_state tool.
 *
 * Events:
 * - 'question-detected'  (QuestionDetected) — AIAGENT-QUESTION found
 * - 'question-cleared'   (QuestionCleared)  — new output arrived after question
 * - 'activity-change'   (ActivityChange)   — session activity level changed
 *
 * Activity detection uses per-session debounced timeouts:
 * - On output: level → 'active', reset both timers
 * - After inactiveMs (10s default): level → 'inactive'
 * - After idleMs (5min default): level → 'idle'
 */
export class StateDetector extends EventEmitter {
  private sessionStates: Map<string, SessionTracking> = new Map();
  private inactiveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private scrollTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private resizeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private switchTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private restoreTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Per-session debounce timers for small output chunks (TUI noise filtering). */
  private activityDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly inactiveTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  /** Threshold for immediate activity promotion (larger chunks bypass debounce). */
  private readonly activityPromoteThreshold: number;
  /** Debounce window for small output chunks. */
  private readonly activityDebounceMs: number;

  constructor(timeouts?: Partial<ActivityTimeouts>) {
    super();
    this.inactiveTimeoutMs = timeouts?.inactiveMs ?? DEFAULT_INACTIVE_TIMEOUT_MS;
    this.idleTimeoutMs = timeouts?.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.activityPromoteThreshold = DEFAULT_ACTIVITY_PROMOTE_THRESHOLD;
    this.activityDebounceMs = DEFAULT_ACTIVITY_DEBOUNCE_MS;
  }

  /** Mark a session as scrolling — processOutput skips marker scanning.
   *  Auto-clears after 2s of no further scroll input. */
  markScrolling(sessionId: string): void {
    const tracking = this.getOrCreate(sessionId);
    tracking.scrolling = true;

    // Reset the auto-clear timer
    const existing = this.scrollTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.scrollTimers.set(sessionId, setTimeout(() => {
      tracking.scrolling = false;
      this.scrollTimers.delete(sessionId);
    }, DEFAULT_SCROLL_CLEAR_MS));
  }

  /** Mark a session as resizing — processOutput skips activity promotion.
   *  Auto-clears after 1s of no further resize events. */
  markResizing(sessionId: string): void {
    const tracking = this.getOrCreate(sessionId);
    tracking.resizing = true;

    const existing = this.resizeTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.resizeTimers.set(sessionId, setTimeout(() => {
      tracking.resizing = false;
      this.resizeTimers.delete(sessionId);
      // If output arrived during suppression, realign activity timers so the
      // inactive countdown starts from the latest output, not from before resize.
      this.promoteIfRecentOutput(sessionId);
    }, DEFAULT_RESIZE_CLEAR_MS));
  }

  /** Mark a session as switching/focusing — processOutput skips activity promotion.
   *  Unlike resize/restore suppression, focus redraws are not promoted when the
   *  suppression window clears. */
  markSwitching(sessionId: string): void {
    const tracking = this.getOrCreate(sessionId);
    tracking.switching = true;

    const existing = this.switchTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.switchTimers.set(sessionId, setTimeout(() => {
      tracking.switching = false;
      this.switchTimers.delete(sessionId);
    }, DEFAULT_RESIZE_CLEAR_MS));
  }

  /** Mark a session as recently restored — shell startup output won't promote
   *  activity from grey to green. Auto-clears after 3s. */
  markRestored(sessionId: string): void {
    const tracking = this.getOrCreate(sessionId);
    tracking.restoring = true;

    const existing = this.restoreTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.restoreTimers.set(sessionId, setTimeout(() => {
      tracking.restoring = false;
      this.restoreTimers.delete(sessionId);
      // If output arrived during the restore grace period, realign activity timers.
      this.promoteIfRecentOutput(sessionId);
    }, DEFAULT_RESTORE_GRACE_MS));
  }

  /** Mark a session as active due to user input (PTY stdin).
   *  Unlike processOutput, this only touches activity state.
   *  Clears the scrolling flag since this is real user input. */
  markActive(sessionId: string): void {
    const tracking = this.getOrCreate(sessionId);
    if (tracking.lastOutputAt <= 0) {
      tracking.lastOutputAt = Date.now();
    }

    // Real user input clears scrolling and resizing flags
    tracking.scrolling = false;
    const scrollTimer = this.scrollTimers.get(sessionId);
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      this.scrollTimers.delete(sessionId);
    }
    tracking.resizing = false;
    const resizeTimer = this.resizeTimers.get(sessionId);
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      this.resizeTimers.delete(sessionId);
    }
    tracking.switching = false;
    const switchTimer = this.switchTimers.get(sessionId);
    if (switchTimer) {
      clearTimeout(switchTimer);
      this.switchTimers.delete(sessionId);
    }
    tracking.restoring = false;
    const restoreTimer = this.restoreTimers.get(sessionId);
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      this.restoreTimers.delete(sessionId);
    }

    const debounceTimer = this.activityDebounceTimers.get(sessionId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.activityDebounceTimers.delete(sessionId);
    }

    if (tracking.activityLevel !== 'active') {
      tracking.activityLevel = 'active';
      this.emit('activity-change', { sessionId, level: 'active', lastOutputAt: tracking.lastOutputAt } satisfies ActivityChange);
    }

    this.resetActivityTimers(sessionId);
  }

  /**
   * Hook-reported work (G3): the CLI's own hooks say real work is happening —
   * a tool is running, a prompt was accepted. A second producer of the same
   * activity events as PTY output, with an identical contract, so downstream
   * consumers cannot tell the two apart. Sessions without hooks installed
   * simply never call this and keep the timing behaviour unchanged.
   */
  markHookWorking(sessionId: string): void {
    this.markActive(sessionId);
  }

  /**
   * Hook-reported turn end (Stop). The agent SAID it finished, so the dot
   * leaves green immediately rather than after the 10s silence timer, and the
   * idle countdown restarts from this moment. Trailing PTY output still
   * promotes normally — the timing path is never disabled, so hooks going
   * silent mid-session cannot stick the dot in any state.
   */
  markHookTurnEnded(sessionId: string): void {
    const tracking = this.getOrCreate(sessionId);
    tracking.lastOutputAt = Date.now();
    if (tracking.activityLevel !== 'inactive') {
      tracking.activityLevel = 'inactive';
      this.emit('activity-change', { sessionId, level: 'inactive', lastOutputAt: tracking.lastOutputAt } satisfies ActivityChange);
    }
    this.resetActivityTimers(sessionId);
  }

  /** Feed output data from a session's PTY. */
  processOutput(sessionId: string, data: string): void {
    const tracking = this.getOrCreate(sessionId);
    // Don't update lastOutputAt during switching suppression — resize redraws
    // during a switch would cause promoteIfRecentOutput to falsely go green.
    if (!tracking.switching) {
      tracking.lastOutputAt = Date.now();
    }

    // Skip activity promotion during resize or restore (shell startup output is not new user activity)
    if (!tracking.resizing && !tracking.switching && !tracking.restoring) {
      // Large output chunks immediately promote to active (genuine content)
      if (data.length >= this.activityPromoteThreshold) {
        const existing = this.activityDebounceTimers.get(sessionId);
        if (existing) {
          clearTimeout(existing);
          this.activityDebounceTimers.delete(sessionId);
        }
        if (tracking.activityLevel !== 'active') {
          tracking.activityLevel = 'active';
          this.emit('activity-change', { sessionId, level: 'active', lastOutputAt: tracking.lastOutputAt } satisfies ActivityChange);
        }
        this.resetActivityTimers(sessionId);
      } else {
        // Small chunks are debounced to filter out TUI noise (cursor blink, spinner ticks, etc.)
        // Debounce even while already active so continuous TUI redraw ticks do
        // not keep extending the green activity window forever.
        const existing = this.activityDebounceTimers.get(sessionId);
        if (existing) clearTimeout(existing);
        this.activityDebounceTimers.set(sessionId, setTimeout(() => {
          this.activityDebounceTimers.delete(sessionId);
          const current = this.sessionStates.get(sessionId);
          if (current && current.activityLevel !== 'active') {
            current.activityLevel = 'active';
            this.emit('activity-change', { sessionId, level: 'active', lastOutputAt: current.lastOutputAt } satisfies ActivityChange);
          }
          this.resetActivityTimers(sessionId);
        }, this.activityDebounceMs));
      }
    }

    // Skip marker scanning during scroll — output is a screen redraw, not new CLI content.
    if (tracking.scrolling) return;

    const clean = stripAnsi(data);

    let hasQuestion = false;
    {
      let pos = 0;
      while ((pos = clean.indexOf(QUESTION_KEYWORD, pos)) !== -1) {
        hasQuestion = true;
        pos += QUESTION_KEYWORD.length;
      }
    }

    if (!hasQuestion && tracking.questionPending) {
      tracking.questionPending = false;
      this.emit('question-cleared', { sessionId } satisfies QuestionCleared);
      return;
    }

    if (hasQuestion && !tracking.questionPending) {
      tracking.questionPending = true;
      this.emit('question-detected', { sessionId } satisfies QuestionDetected);
    }
  }

  /** Check if a session has a pending question. */
  hasQuestion(sessionId: string): boolean {
    return this.sessionStates.get(sessionId)?.questionPending ?? false;
  }

  /** Remove tracking for a session. */
  removeSession(sessionId: string): void {
    this.clearActivityTimers(sessionId);
    const scrollTimer = this.scrollTimers.get(sessionId);
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      this.scrollTimers.delete(sessionId);
    }
    const resizeTimer = this.resizeTimers.get(sessionId);
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      this.resizeTimers.delete(sessionId);
    }
    const switchTimer = this.switchTimers.get(sessionId);
    if (switchTimer) {
      clearTimeout(switchTimer);
      this.switchTimers.delete(sessionId);
    }
    const restoreTimer = this.restoreTimers.get(sessionId);
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      this.restoreTimers.delete(sessionId);
    }
    const debounceTimer = this.activityDebounceTimers.get(sessionId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.activityDebounceTimers.delete(sessionId);
    }
    this.sessionStates.delete(sessionId);
  }

  /** Clean up all timers (call on shutdown). */
  dispose(): void {
    for (const timer of this.inactiveTimers.values()) clearTimeout(timer);
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    for (const timer of this.scrollTimers.values()) clearTimeout(timer);
    for (const timer of this.resizeTimers.values()) clearTimeout(timer);
    for (const timer of this.switchTimers.values()) clearTimeout(timer);
    for (const timer of this.restoreTimers.values()) clearTimeout(timer);
    for (const timer of this.activityDebounceTimers.values()) clearTimeout(timer);
    this.inactiveTimers.clear();
    this.idleTimers.clear();
    this.scrollTimers.clear();
    this.resizeTimers.clear();
    this.switchTimers.clear();
    this.restoreTimers.clear();
    this.activityDebounceTimers.clear();
    this.sessionStates.clear();
  }

  // ---------- Activity tracking ------------------------------------------

  /** Get the timestamp of the last output for a session. Returns 0 for unknown sessions. */
  getLastOutputTime(sessionId: string): number {
    return this.sessionStates.get(sessionId)?.lastOutputAt ?? 0;
  }

  /** Reset (or start) both activity timers for a session. */
  private resetActivityTimers(sessionId: string): void {
    this.clearActivityTimers(sessionId);

    // Timer 1: inactive after inactiveTimeoutMs of silence
    const inactiveTimer = setTimeout(() => {
      this.inactiveTimers.delete(sessionId);
      const tracking = this.sessionStates.get(sessionId);
      if (tracking && tracking.activityLevel === 'active') {
        tracking.activityLevel = 'inactive';
        this.emit('activity-change', { sessionId, level: 'inactive', lastOutputAt: tracking.lastOutputAt } satisfies ActivityChange);
      }
    }, this.inactiveTimeoutMs);
    this.inactiveTimers.set(sessionId, inactiveTimer);

    // Timer 2: idle after idleTimeoutMs of silence
    const idleTimer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      const tracking = this.sessionStates.get(sessionId);
      if (tracking && tracking.activityLevel !== 'idle') {
        tracking.activityLevel = 'idle';
        this.emit('activity-change', { sessionId, level: 'idle', lastOutputAt: tracking.lastOutputAt } satisfies ActivityChange);
      }
    }, this.idleTimeoutMs);
    this.idleTimers.set(sessionId, idleTimer);
  }

  /** After suppression clears, promote to active if output arrived during the
   *  suppression window. This realigns the activity timers so the inactive
   *  countdown starts from the actual last output, not from before suppression. */
  private promoteIfRecentOutput(sessionId: string): void {
    const tracking = this.sessionStates.get(sessionId);
    if (!tracking || tracking.lastOutputAt === 0) return;
    const elapsed = Date.now() - tracking.lastOutputAt;
    if (elapsed < this.inactiveTimeoutMs) {
      if (tracking.activityLevel !== 'active') {
        tracking.activityLevel = 'active';
        this.emit('activity-change', { sessionId, level: 'active', lastOutputAt: tracking.lastOutputAt } satisfies ActivityChange);
      }
      this.resetActivityTimers(sessionId);
    }
  }

  /** Clear both activity timers for a session. */
  private clearActivityTimers(sessionId: string): void {
    const inactiveTimer = this.inactiveTimers.get(sessionId);
    if (inactiveTimer) {
      clearTimeout(inactiveTimer);
      this.inactiveTimers.delete(sessionId);
    }
    const idleTimer = this.idleTimers.get(sessionId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(sessionId);
    }
  }

  private getOrCreate(sessionId: string): SessionTracking {
    let tracking = this.sessionStates.get(sessionId);
    if (!tracking) {
      tracking = { questionPending: false, lastOutputAt: 0, activityLevel: 'idle', scrolling: false, resizing: false, switching: false, restoring: false };
      this.sessionStates.set(sessionId, tracking);
    }
    return tracking;
  }
}
