import { EventEmitter } from 'node:events';
import type { StartupPromptRule } from '../config/loader.js';
import { compileCaseInsensitiveRegex, stripAnsiSequences } from './pattern-matcher.js';
import { logger } from '../utils/logger.js';

export interface StartupPromptStart {
  sessionId: string;
  cliType: string;
  creatorSessionId?: string;
}

export interface StartupPromptBlockedEvent {
  sessionId: string;
  cliType: string;
  creatorSessionId?: string;
  excerpt: string;
  repeat: boolean;
}

export interface StartupPromptWatcherOptions {
  getPrompts: (cliType: string) => StartupPromptRule[];
  updateSession: (sessionId: string, updates: { blockedOn: 'startup-prompt' | undefined }) => void;
  startupWindowMs?: number;
  reminderDelayMs?: number;
  tailLimit?: number;
}

interface CompiledPrompt {
  source: string;
  regex: RegExp;
}

interface WatchState extends StartupPromptStart {
  prompts: CompiledPrompt[];
  rawTail: string;
  startupTimer: ReturnType<typeof setTimeout>;
  reminderTimer?: ReturnType<typeof setTimeout>;
  blockedPrompt?: CompiledPrompt;
}

const DEFAULT_STARTUP_WINDOW_MS = 60_000;
const DEFAULT_REMINDER_DELAY_MS = 30_000;
const DEFAULT_TAIL_LIMIT = 4_000;
const MAX_EXCERPT_LENGTH = 240;

/** Find the final reset in the bounded tail so text from the previous screen is discarded. */
function outputAfterLastScreenReset(rawTail: string): string {
  let keepFrom = 0;
  for (const match of rawTail.matchAll(/\x1b(?:\[(?:2|3)J|c)/g)) {
    keepFrom = (match.index ?? 0) + match[0].length;
  }
  return rawTail.slice(keepFrom);
}

function findLastRegexMatch(text: string, regex: RegExp): RegExpMatchArray | null {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  let lastMatch: RegExpMatchArray | null = null;
  for (const match of text.matchAll(new RegExp(regex.source, flags))) lastMatch = match;
  return lastMatch;
}

function matchIsAtTail(text: string, match: RegExpMatchArray): boolean {
  const matchEnd = (match.index ?? -1) + match[0].length;
  return matchEnd >= 0 && /^\s*$/.test(text.slice(matchEnd));
}

/** Observes a new CLI's startup output and reports trust prompts without answering them. */
export class StartupPromptWatcher extends EventEmitter {
  private readonly watches = new Map<string, WatchState>();
  private readonly startupWindowMs: number;
  private readonly reminderDelayMs: number;
  private readonly tailLimit: number;

  constructor(private readonly options: StartupPromptWatcherOptions) {
    super();
    this.startupWindowMs = options.startupWindowMs ?? DEFAULT_STARTUP_WINDOW_MS;
    this.reminderDelayMs = options.reminderDelayMs ?? DEFAULT_REMINDER_DELAY_MS;
    this.tailLimit = options.tailLimit ?? DEFAULT_TAIL_LIMIT;
  }

  /** Arm only configured CLI types; unknown types stay inert. */
  watch(start: StartupPromptStart): void {
    this.finish(start.sessionId, true);
    let configured: StartupPromptRule[];
    try {
      configured = this.options.getPrompts(start.cliType);
    } catch (error) {
      logger.warn(`[StartupPromptWatcher] Could not load prompts for ${start.cliType}: ${String(error)}`);
      return;
    }
    const prompts = configured.flatMap((rule, index) => {
      if (!rule || typeof rule.regex !== 'string' || !rule.regex.trim()) {
        logger.warn(`[StartupPromptWatcher] Missing regex for ${start.cliType}[${index}]`);
        return [];
      }
      const regex = compileCaseInsensitiveRegex(rule.regex);
      if (!regex) {
        logger.warn(`[StartupPromptWatcher] Invalid regex for ${start.cliType}[${index}]: ${rule.regex}`);
        return [];
      }
      return [{ source: rule.regex, regex }];
    });
    if (!prompts.length) return;

    const state: WatchState = {
      ...start,
      prompts,
      rawTail: '',
      startupTimer: setTimeout(() => this.finish(start.sessionId, true), this.startupWindowMs),
    };
    this.watches.set(start.sessionId, state);
  }

  /** Feed a raw PTY chunk. Text is retained only for this bounded startup window. */
  processOutput(sessionId: string, rawText: string): void {
    const state = this.watches.get(sessionId);
    if (!state) return;
    state.rawTail = outputAfterLastScreenReset((state.rawTail + rawText).slice(-this.tailLimit));

    const found = state.prompts
      .map(prompt => ({ prompt, match: this.findCurrentMatch(state, prompt) }))
      .find(candidate => candidate.match);
    if (!found?.match) {
      this.clearBlocked(state);
      return;
    }
    if (state.blockedPrompt === found.prompt) return;

    const wasBlocked = Boolean(state.blockedPrompt);
    this.clearReminder(state);
    state.blockedPrompt = found.prompt;
    if (!wasBlocked) this.updateBlockedOn(sessionId, 'startup-prompt');
    this.emitBlocked(state, found.match[0], false);
    state.reminderTimer = setTimeout(() => this.repeatIfStillBlocked(state), this.reminderDelayMs);
  }

  /** A correlated hook or active signal means the CLI is ready for its first instruction. */
  markReady(sessionId: string): void {
    this.finish(sessionId, true);
  }

  /** Drop timers without mutating a session that is already being removed. */
  removeSession(sessionId: string): void {
    this.finish(sessionId, false);
  }

  dispose(): void {
    for (const sessionId of [...this.watches.keys()]) this.finish(sessionId, true);
    this.removeAllListeners();
  }

  private repeatIfStillBlocked(state: WatchState): void {
    state.reminderTimer = undefined;
    if (this.watches.get(state.sessionId) !== state || !state.blockedPrompt) return;
    const match = this.findCurrentMatch(state, state.blockedPrompt);
    if (!match) {
      this.clearBlocked(state);
      return;
    }
    this.emitBlocked(state, match[0], true);
  }

  private emitBlocked(state: WatchState, matchedText: string, repeat: boolean): void {
    const excerpt = matchedText.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, MAX_EXCERPT_LENGTH).trim();
    this.emit('blocked', {
      sessionId: state.sessionId,
      cliType: state.cliType,
      ...(state.creatorSessionId ? { creatorSessionId: state.creatorSessionId } : {}),
      excerpt,
      repeat,
    } satisfies StartupPromptBlockedEvent);
  }

  private findCurrentMatch(state: WatchState, prompt: CompiledPrompt): RegExpMatchArray | null {
    const cleanTail = stripAnsiSequences(state.rawTail);
    const match = findLastRegexMatch(cleanTail, prompt.regex);
    return match && matchIsAtTail(cleanTail, match) ? match : null;
  }

  private clearBlocked(state: WatchState): void {
    if (!state.blockedPrompt) return;
    state.blockedPrompt = undefined;
    this.clearReminder(state);
    this.updateBlockedOn(state.sessionId, undefined);
  }

  private clearReminder(state: WatchState): void {
    if (state.reminderTimer) clearTimeout(state.reminderTimer);
    state.reminderTimer = undefined;
  }

  private finish(sessionId: string, clearBlocked: boolean): void {
    const state = this.watches.get(sessionId);
    if (!state) return;
    clearTimeout(state.startupTimer);
    this.clearReminder(state);
    this.watches.delete(sessionId);
    if (clearBlocked) this.clearBlocked(state);
  }

  private updateBlockedOn(sessionId: string, blockedOn: 'startup-prompt' | undefined): void {
    try {
      this.options.updateSession(sessionId, { blockedOn });
    } catch (error) {
      logger.debug(`[StartupPromptWatcher] Could not update session ${sessionId}: ${String(error)}`);
    }
  }
}
