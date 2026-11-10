import { EventEmitter } from 'events';
import type { PatternRule } from '../config/loader.js';
import { parseScheduledTime } from '../utils/time-parser.js';
import { parseSequence, type SequenceAction } from '../input/sequence-parser.js';
import { actionToPtyData } from '../input/sequence-executor.js';
import logger from '../utils/logger.js';

// ============================================================================
// Events
// ============================================================================

export interface PatternMatchedEvent {
  sessionId: string;
  cliType: string;
  ruleIndex: number;
  matchedText: string;
}

export interface ScheduleCreatedEvent {
  sessionId: string;
  scheduledAt: Date;
  ruleIndex: number;
}

export interface ScheduleFiredEvent {
  sessionId: string;
}

export interface ScheduleCancelledEvent {
  sessionId: string;
}

// ============================================================================
// Internal state
// ============================================================================

interface PendingSchedule {
  timer: ReturnType<typeof setTimeout>;
  scheduledAt: Date;
  ruleIndex: number;
}

/** Per-session, per-rule last-fired timestamp for dedup. */
type LastFiredMap = Map<string, Map<number, number>>;

const DEFAULT_COOLDOWN_MS = 300_000; // 5 minutes

/** Strip terminal styling/control sequences before applying text rules. */
export function stripAnsiSequences(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\][^\x07\x1b]*/g, '');
}

/** Compile the shared case-insensitive regex format used by PTY text watchers. */
export function compileCaseInsensitiveRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** Match a compiled rule without allowing stateful regex flags to leak between chunks. */
export function findRegexMatch(text: string, regex: RegExp): RegExpMatchArray | null {
  regex.lastIndex = 0;
  return text.match(regex);
}

// ============================================================================
// PatternMatcher
// ============================================================================

/**
 * Matches user-defined regex patterns against ANSI-stripped PTY output per CLI type.
 *
 * For each matching rule:
 * - 'send-text'  → immediately calls ptyWriteFn(sessionId, sequence)
 * - 'wait-until' → parses a scheduled time (from capture group or fixed waitMs),
 *                  sets a timer, then calls ptyWriteFn at the scheduled time
 *
 * Deduplication: each rule fires at most once per session per cooldownMs window.
 * One pending schedule per session (new schedule replaces any previous for that session).
 *
 * Events:
 *  - 'pattern-matched'    (PatternMatchedEvent)    — rule matched
 *  - 'schedule-created'   (ScheduleCreatedEvent)   — wait-until scheduled
 *  - 'schedule-fired'     (ScheduleFiredEvent)     — timer fired, sequence sent
 *  - 'schedule-cancelled' (ScheduleCancelledEvent) — timer cancelled
 */
export class PatternMatcher extends EventEmitter {
  private readonly ptyWriteFn: (sessionId: string, data: string) => void | Promise<void>;
  private readonly getPatternsFn: (cliType: string) => PatternRule[];
  private readonly resolveCliTypeFn: (cliType: string) => string;

  private pendingSchedules: Map<string, PendingSchedule> = new Map();
  private lastFired: LastFiredMap = new Map();

  /**
   * @param resolveCliTypeFn Maps a CLI type reference to its canonical id. Without
   *   it, a session stored under a legacy slug and one stored under the uuid would
   *   each get their own regex-cache entry for the same rules.
   */
  constructor(
    ptyWriteFn: (sessionId: string, data: string) => void | Promise<void>,
    getPatternsFn: (cliType: string) => PatternRule[],
    resolveCliTypeFn: (cliType: string) => string = (cliType) => cliType,
  ) {
    super();
    this.ptyWriteFn = ptyWriteFn;
    this.getPatternsFn = getPatternsFn;
    this.resolveCliTypeFn = resolveCliTypeFn;
  }

  /**
   * Feed raw or pre-stripped PTY output for a session. ANSI sequences are stripped internally.
   * Call this after StateDetector.processOutput.
   */
  processOutput(sessionId: string, cliTypeRef: string, rawText: string): void {
    // Canonicalize first: rules, the emitted event, and the regex cache key must
    // all agree on one identity for the CLI type regardless of how it was addressed.
    const cliType = this.resolveCliTypeFn(cliTypeRef);
    const cleanText = stripAnsiSequences(rawText);
    const rules = this.getPatternsFn(cliType);
    if (rules.length === 0) return;

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!this.isReady(sessionId, i, rule.cooldownMs)) continue;

      const regex = this.getRegex(cliType, i, rule.regex);
      if (!regex) continue;

      const match = findRegexMatch(cleanText, regex);
      if (!match) continue;

      this.recordFired(sessionId, i);
      this.emit('pattern-matched', {
        sessionId, cliType, ruleIndex: i, matchedText: match[0],
      } satisfies PatternMatchedEvent);

      if (rule.action === 'send-text') {
        this.executeSendText(sessionId, rule);
      } else if (rule.action === 'wait-until') {
        this.executeWaitUntil(sessionId, i, match, rule);
      }
    }
  }

  /**
   * Cancel the pending schedule for a session (user-initiated or on session close).
   */
  cancelSchedule(sessionId: string): void {
    const pending = this.pendingSchedules.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSchedules.delete(sessionId);
    this.emit('schedule-cancelled', { sessionId } satisfies ScheduleCancelledEvent);
    logger.info(`[PatternMatcher] Schedule cancelled for session ${sessionId}`);
  }

  /**
   * Remove all state for a closed session (cancels any pending schedule).
   */
  removeSession(sessionId: string): void {
    this.cancelSchedule(sessionId);
    this.lastFired.delete(sessionId);
  }

  /** Get the pending schedule for a session, or null. */
  getPendingSchedule(sessionId: string): { scheduledAt: Date; ruleIndex: number } | null {
    const p = this.pendingSchedules.get(sessionId);
    return p ? { scheduledAt: p.scheduledAt, ruleIndex: p.ruleIndex } : null;
  }

  /** Clean up all timers on shutdown. */
  dispose(): void {
    for (const sessionId of [...this.pendingSchedules.keys()]) {
      this.cancelSchedule(sessionId);
    }
    this.lastFired.clear();
  }

  // ---------- Private helpers -----------------------------------------------

  /** Compiled regex cache keyed by `cliType:index:regex`. Avoids re-compilation per data chunk. */
  private regexCache: Map<string, RegExp | null> = new Map();

  private getRegex(cliType: string, index: number, pattern: string): RegExp | null {
    const key = `${cliType}:${index}:${pattern}`;
    if (this.regexCache.has(key)) return this.regexCache.get(key)!;
    const regex = compileCaseInsensitiveRegex(pattern);
    if (!regex) {
      logger.warn(`[PatternMatcher] Invalid regex for ${cliType}[${index}]: ${pattern}`);
    }
    this.regexCache.set(key, regex);
    return regex;
  }

  private executeSendText(sessionId: string, rule: PatternRule): void {
    const seq = rule.sequence ?? '';
    if (!seq) {
      logger.warn(`[PatternMatcher] send-text rule has no sequence`);
      return;
    }
    const actions = parseSequence(seq);
    const output = this.sequenceToString(actions);
    Promise.resolve(this.ptyWriteFn(sessionId, output)).catch((err) => {
      logger.error(`[PatternMatcher] ptyWriteFn failed:`, err);
    });
  }

  private sequenceToString(actions: SequenceAction[]): string {
    let result = '';
    for (const action of actions) {
      if (action.type === 'text') {
        result += action.value;
      } else if (action.type === 'key') {
        const esc = actionToPtyData(action);
        if (esc) result += esc;
      } else if (action.type === 'combo') {
        const esc = actionToPtyData(action);
        if (esc) result += esc;
      }
      // wait and modifiers are ignored in suffix context
    }
    return result;
  }

  private executeWaitUntil(
    sessionId: string,
    ruleIndex: number,
    match: RegExpMatchArray,
    rule: PatternRule,
  ): void {
    let scheduledAt: Date | null = null;

    // Try time from capture group first
    if (rule.timeGroup !== undefined && rule.timeGroup > 0) {
      const captured = match[rule.timeGroup];
      if (captured) {
        scheduledAt = parseScheduledTime(captured);
        if (!scheduledAt) {
          logger.warn(`[PatternMatcher] Could not parse time from capture group ${rule.timeGroup}: "${captured}"`);
        }
      }
    }

    // Fall back to fixed waitMs
    if (!scheduledAt && rule.waitMs && rule.waitMs > 0) {
      scheduledAt = new Date(Date.now() + rule.waitMs);
    }

    if (!scheduledAt) {
      logger.warn(`[PatternMatcher] wait-until rule has no parseable time and no waitMs — skipping`);
      return;
    }

    // Cancel any existing schedule for this session
    const existing = this.pendingSchedules.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingSchedules.delete(sessionId);
    }

    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.pendingSchedules.delete(sessionId);
      const seq = rule.onResume ?? '';
      if (seq) {
        const actions = parseSequence(seq);
        const output = this.sequenceToString(actions);
        Promise.resolve(this.ptyWriteFn(sessionId, output)).catch((err) => {
          logger.error(`[PatternMatcher] scheduled ptyWriteFn failed:`, err);
        });
      }
      this.emit('schedule-fired', { sessionId } satisfies ScheduleFiredEvent);
      logger.info(`[PatternMatcher] Schedule fired for session ${sessionId}`);
    }, delay);

    this.pendingSchedules.set(sessionId, { timer, scheduledAt, ruleIndex });
    this.emit('schedule-created', { sessionId, scheduledAt, ruleIndex } satisfies ScheduleCreatedEvent);
    logger.info(`[PatternMatcher] Scheduled resume for ${sessionId} at ${scheduledAt.toISOString()}`);
  }

  private isReady(sessionId: string, ruleIndex: number, cooldownMs?: number): boolean {
    const cooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const sessionMap = this.lastFired.get(sessionId);
    if (!sessionMap) return true;
    const last = sessionMap.get(ruleIndex);
    if (last === undefined) return true;
    return Date.now() - last >= cooldown;
  }

  private recordFired(sessionId: string, ruleIndex: number): void {
    let sessionMap = this.lastFired.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.lastFired.set(sessionId, sessionMap);
    }
    sessionMap.set(ruleIndex, Date.now());
  }
}
