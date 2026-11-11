import { EventEmitter } from 'events';
import type { ActivityLevel } from '../types/session.js';
import { logger } from '../utils/logger.js';

export interface ActivityChange {
  sessionId: string;
  level: ActivityLevel;
  /** Timestamp of the last PTY output — included so renderer can sync timer display with dot. */
  lastOutputAt?: number;
}

interface SessionTracking {
  lastOutputAt: number;
  activityLevel: ActivityLevel;
  frozen: boolean;
  /** Hookless only: user input opened a turn that output may track. */
  turnArmed: boolean;
  /** The CLI's hooks are installed: hook events alone drive the dot; PTY in/out never does. */
  hooked: boolean;
  /** When true, processOutput skips activity promotion (resize redraws). */
  resizing: boolean;
  /** When true, processOutput skips activity promotion (terminal switch/focus redraws). */
  switching: boolean;
  /** When true, processOutput skips activity promotion (post-restore shell startup). */
  restoring: boolean;
}

/** Default timeout before considering a session inactive (no output for 10s) */
export const DEFAULT_INACTIVE_TIMEOUT_MS = 10_000;

/** Default timeout before considering a session idle (no output for 5 minutes) */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/**
 * A hooked session with no hook event for this long goes blue even without a
 * Stop — an Esc interrupt or a crash never sends one. Long enough to cover a
 * slow tool, which fires nothing between PreToolUse and PostToolUse.
 */
export const DEFAULT_HOOK_SILENCE_MS = 10 * 60_000;

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
  hookSilenceMs: number;
}

/**
 * Tracks PTY activity for sessions. Nothing is parsed from terminal text.
 *
 * Events:
 * - 'activity-change'   (ActivityChange)   — session activity level changed
 *
 * Hookless sessions use per-session debounced PTY timeouts:
 * - Input, or output in an armed turn: level → 'active', reset both timers
 * - After inactiveMs (10s default): level → 'inactive'
 * - After idleMs (5min default): level → 'idle'
 * Hooked sessions ignore PTY input and output — typing is not a submitted
 * prompt. Every cache-touching hook event goes green; a turn end (Stop /
 * StopFailure) goes blue at once; with neither, hookSilenceMs after the last
 * hook goes blue. Grey follows idleMs after blue.
 */
export class StateDetector extends EventEmitter {
  private sessionStates: Map<string, SessionTracking> = new Map();
  private inactiveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private resizeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private switchTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private restoreTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Per-session debounce timers for small output chunks (TUI noise filtering). */
  private activityDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly inactiveTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly hookSilenceMs: number;
  /** Threshold for immediate activity promotion (larger chunks bypass debounce). */
  private readonly activityPromoteThreshold: number;
  /** Debounce window for small output chunks. */
  private readonly activityDebounceMs: number;

  constructor(timeouts?: Partial<ActivityTimeouts>) {
    super();
    this.inactiveTimeoutMs = timeouts?.inactiveMs ?? DEFAULT_INACTIVE_TIMEOUT_MS;
    this.idleTimeoutMs = timeouts?.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.hookSilenceMs = timeouts?.hookSilenceMs ?? DEFAULT_HOOK_SILENCE_MS;
    this.activityPromoteThreshold = DEFAULT_ACTIVITY_PROMOTE_THRESHOLD;
    this.activityDebounceMs = DEFAULT_ACTIVITY_DEBOUNCE_MS;
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
   *  Unlike processOutput, this only touches activity state. */
  markActive(sessionId: string): void {
    const tracking = this.getOrCreate(sessionId);
    if (tracking.frozen) return;

    // Real user input clears the resizing flag
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

    // Hooked: only a submitted prompt (UserPromptSubmit) counts, never keystrokes.
    if (tracking.hooked) return;
    tracking.turnArmed = true;
    if (tracking.lastOutputAt <= 0) {
      tracking.lastOutputAt = Date.now();
    }
    this.setLevel(sessionId, tracking, 'active', 'pty input');
    this.resetActivityTimers(sessionId);
  }

  /** Arm output-based activity detection for a prompt in a session without hooks. */
  armTurn(sessionId: string): void {
    const tracking = this.getOrCreate(sessionId);
    if (tracking.frozen) return;
    if (!tracking.turnArmed && !tracking.hooked) {
      tracking.turnArmed = true;
      this.resetActivityTimers(sessionId);
    }
  }

  /**
   * Whether hook events, rather than PTY in/out, drive this session's dot.
   * Resolved from the CLI type's hook install at spawn; any hook event also
   * proves it.
   */
  setHooked(sessionId: string, hooked: boolean): void {
    const tracking = this.getOrCreate(sessionId);
    if (tracking.hooked === hooked) return;
    tracking.hooked = hooked;
    tracking.turnArmed = false;
    const debounceTimer = this.activityDebounceTimers.get(sessionId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.activityDebounceTimers.delete(sessionId);
    }
  }

  isHooked(sessionId: string): boolean {
    return this.sessionStates.get(sessionId)?.hooked ?? false;
  }

  /** Freeze lifecycle activity while allowing actual PTY output to remain visible. */
  setSessionFrozen(sessionId: string, frozen: boolean): void {
    const tracking = this.getOrCreate(sessionId);
    if (tracking.frozen === frozen) return;

    tracking.frozen = frozen;
    if (!frozen) return;

    tracking.turnArmed = false;
    this.clearActivityTimers(sessionId);
    const debounceTimer = this.activityDebounceTimers.get(sessionId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.activityDebounceTimers.delete(sessionId);
    }

    tracking.activityLevel = 'idle';
  }

  /**
   * A cache-touching hook event (session start, prompt submit, tool start or
   * finish, compaction): green, then blue hookSilenceMs later unless another
   * hook event or a turn end comes first.
   */
  markHookActivity(sessionId: string, cause: string): void {
    if (this.sessionStates.get(sessionId)?.frozen) return;
    this.setHooked(sessionId, true);
    const tracking = this.sessionStates.get(sessionId)!;
    if (tracking.lastOutputAt <= 0) tracking.lastOutputAt = Date.now();
    this.setLevel(sessionId, tracking, 'active', cause);
    this.startTimers(sessionId, this.hookSilenceMs);
  }

  /**
   * Hook-reported turn end (Stop or StopFailure): the agent is done, so the
   * dot leaves green at once and greys idleMs from now.
   */
  markHookTurnEnded(sessionId: string, cause: string): void {
    if (this.sessionStates.get(sessionId)?.frozen) return;
    this.setHooked(sessionId, true);
    const tracking = this.sessionStates.get(sessionId)!;
    tracking.lastOutputAt = Date.now();
    this.setLevel(sessionId, tracking, 'inactive', cause);
    this.startTimers(sessionId, 0);
  }

  /** Feed output data from a session's PTY. */
  processOutput(sessionId: string, data: string): void {
    const tracking = this.getOrCreate(sessionId);
    // Don't update lastOutputAt during switching suppression — resize redraws
    // during a switch would cause promoteIfRecentOutput to falsely go green.
    if (!tracking.switching) {
      tracking.lastOutputAt = Date.now();
    }

    // Output is activity evidence only inside a fallback turn. Hook-aware
    // sessions use hook events as truth, while idle TUI repaints stay inert.
    if ((tracking.frozen || (tracking.turnArmed && !tracking.hooked)) && !tracking.resizing && !tracking.switching && !tracking.restoring) {
      // Large output chunks immediately promote to active (genuine content)
      if (data.length >= this.activityPromoteThreshold) {
        const existing = this.activityDebounceTimers.get(sessionId);
        if (existing) {
          clearTimeout(existing);
          this.activityDebounceTimers.delete(sessionId);
        }
        this.setLevel(sessionId, tracking, 'active', `output ${data.length} chars`);
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
          if (current && (current.frozen || (current.turnArmed && !current.hooked))) {
            this.setLevel(sessionId, current, 'active', 'debounced output');
            this.resetActivityTimers(sessionId);
          }
        }, this.activityDebounceMs));
      }
    }
  }

  /** Remove tracking for a session. */
  removeSession(sessionId: string): void {
    this.clearActivityTimers(sessionId);
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
    for (const timer of this.resizeTimers.values()) clearTimeout(timer);
    for (const timer of this.switchTimers.values()) clearTimeout(timer);
    for (const timer of this.restoreTimers.values()) clearTimeout(timer);
    for (const timer of this.activityDebounceTimers.values()) clearTimeout(timer);
    this.inactiveTimers.clear();
    this.idleTimers.clear();
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

  /** Restart the PTY-silence countdowns: blue after inactiveMs, grey after idleMs. */
  private resetActivityTimers(sessionId: string): void {
    this.startTimers(sessionId, this.inactiveTimeoutMs, this.idleTimeoutMs);
  }

  /** Blue after blueMs (none when 0), grey after greyMs — by default idleMs after blue. */
  private startTimers(sessionId: string, blueMs: number, greyMs = blueMs + this.idleTimeoutMs): void {
    this.clearActivityTimers(sessionId);
    if (blueMs > 0) {
      this.inactiveTimers.set(sessionId, setTimeout(() => {
        this.inactiveTimers.delete(sessionId);
        const tracking = this.sessionStates.get(sessionId);
        if (tracking?.activityLevel === 'active') {
          this.setLevel(sessionId, tracking, 'inactive', `silent ${blueMs / 1000}s`);
        }
      }, blueMs));
    }
    this.idleTimers.set(sessionId, setTimeout(() => {
      this.idleTimers.delete(sessionId);
      const tracking = this.sessionStates.get(sessionId);
      if (!tracking) return;
      tracking.turnArmed = false;
      this.setLevel(sessionId, tracking, 'idle', `silent ${greyMs / 1000}s`);
    }, greyMs));
  }

  /** After suppression clears, promote to active if output arrived during the
   *  suppression window. This realigns the activity timers so the inactive
   *  countdown starts from the actual last output, not from before suppression. */
  private promoteIfRecentOutput(sessionId: string): void {
    const tracking = this.sessionStates.get(sessionId);
    if (!tracking || tracking.frozen || tracking.hooked || tracking.lastOutputAt === 0) return;
    const elapsed = Date.now() - tracking.lastOutputAt;
    if (elapsed < this.inactiveTimeoutMs) {
      this.setLevel(sessionId, tracking, 'active', 'output during resize/restore');
      this.resetActivityTimers(sessionId);
    }
  }

  /**
   * The one place a level changes. Each change is logged with its cause so a
   * dot stuck green (e.g. a hook turn armed with no Stop) can be traced.
   */
  private setLevel(sessionId: string, tracking: SessionTracking, level: ActivityLevel, cause: string): void {
    if (tracking.activityLevel === level) return;
    logger.info(`[StateDetector] ${sessionId} ${tracking.activityLevel} → ${level} (${cause}${tracking.hooked ? ', hooked' : ''})`);
    tracking.activityLevel = level;
    this.emit('activity-change', { sessionId, level, lastOutputAt: tracking.lastOutputAt } satisfies ActivityChange);
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
      tracking = { lastOutputAt: 0, activityLevel: 'idle', frozen: false, turnArmed: false, hooked: false, resizing: false, switching: false, restoring: false };
      this.sessionStates.set(sessionId, tracking);
    }
    return tracking;
  }
}
