/**
 * ContextInjector — G4's decision brain for the non-deny hook events.
 *
 * THREE things it can say, each independently optional, SILENT when there is
 * nothing worth saying (null — the common case must be free):
 *
 * A. SessionStart injection — the session's claimed plan, draft memos and
 *    pending handover note, out-of-band, directory-scoped, size-capped,
 *    logged. Nothing is preloaded wholesale.
 * B. UserPromptSubmit — the inter-session rules as additionalContext instead
 *    of prompt text (prompt with a [HELM_MSG] / [HELM_TELEGRAM] envelope),
 *    plus the hint-only suggester pointer, plus conditional nudges, plus the
 *    [HELM_MISSION] line on EVERY prompt (the deliberate exception to
 *    "silent when nothing to say": the mission must track the work, so the AI
 *    is asked each turn whether the direction changed).
 * C. Stop — the one-shot nudge. A claimed plan still open or an unset
 *    AIAGENT state blocks the turn ONCE; the second Stop always passes.
 *    The cap is 1 by decision and is NOT configurable.
 *
 * StopFailure is NEVER answered — a usage-limit stall must not be retried in
 * a loop. (Loop driving, if it ever lands, is a separate flag behind these
 * same events and inherits this rule.)
 *
 * All deps are injected read functions; this class owns only the
 * once-per-session ledgers. Fail-open lives in the receiver's catch — a
 * throwing dep degrades to no-op, never to a broken session.
 */

import type { SessionInfo, SessionMission } from '../../types/session.js';
import { encodeAdditionalContext, encodeStopBlock } from './hook-encoder.js';
import type { HookEvent } from './hook-normaliser.js';
import { HELM_MSG_HOOK_RULES, HELM_TELEGRAM_HOOK_RULES, HELM_TELEGRAM_MODE_INSTRUCTIONS } from '../intersession-directive.js';
import {
  resolveReminderDelivery,
  type ReminderDeliveryMode,
  type ReminderId,
} from '../reminder-delivery.js';
import type { LoopDriver } from './loop-driver.js';
import { logger } from '../../utils/logger.js';

/** A claimed plan reduced to what a nudge names. */
export interface ClaimedPlanSummary {
  humanId?: string;
  title: string;
  status: string;
}

export interface ContextInjectorDeps {
  /** Session lookup; null means the hook was uncorrelated — never nudge it. */
  getSession(helmSessionId: string): SessionInfo | null;
  /** The session's claimed plan, when one is claimed and not done. */
  getClaimedPlan(sessionId: string): ClaimedPlanSummary | null;
  /** Startable (unclaimed, unblocked) plans in a directory. */
  getStartablePlans(dirPath: string): ClaimedPlanSummary[];
  /** Draft memos for the session. */
  getDrafts(sessionId: string): { label: string; text: string }[];
  /** Handover text pending across a compaction, when armed. */
  getHandover(sessionId: string): string | undefined;
  /**
   * The session's mission TL;DR. Absent dep = mission feature not wired (the
   * injector stays byte-identical to before); present and returning undefined
   * = no mission yet, and the AI is asked to set one.
   */
  getMission?(sessionId: string): SessionMission | undefined;
  /** The hint-only suggester: tuple payload or null. Promise = the worker seam. */
  suggest(sessionId: string, prompt: string, projectId: string | null): Promise<string | null>;
  /** Directory → project id, for pre-filtering suggester candidates. */
  getProjectIdForDirectory(dirPath: string): string | null;
  /**
   * G9: the user's per-reminder delivery mode from settings. Absent means
   * every reminder keeps its default — inject, as G4 already did. The hook
   * FIRING is the capability proof, so capability is always true here; mode
   * 'pty' means the prepend path owns the reminder and nothing is injected.
   */
  getReminderMode?(reminder: ReminderId): ReminderDeliveryMode | undefined;
  /**
   * G8 loop driving: continuation (autoImplement-gated) and verification
   * (completionRecap-gated) on the same Stop event. Checked BEFORE the
   * one-shot nudge; exactly one block is ever emitted per Stop. Absent in
   * pre-G8 wiring — the Stop path is then byte-identical to before.
   */
  loop?: Pick<LoopDriver, 'stopBlock'>;
}

/** One hook reply: 200 with a body the CLI reads, or null (send nothing). */
export type InjectorResponse = { statusCode: 200; body: Record<string, unknown> } | null;

// CLIs whose UserPromptSubmit command-hook output reaches the model. Copilot
// drops that event's command-hook output entirely, so injecting there is
// writing into the void — Copilot sessions keep the prepended rules header.
// Shared with hook-capability.ts: the delivery side must consult the SAME set
// before deciding the prepended rules header is redundant.
export const PROMPT_INJECTION_PROVIDERS = new Set(['claude', 'codex']);

/** Per-source cap: a source longer than this is truncated, not dropped. */
const SOURCE_CAP_CHARS = 800;
/** Whole-payload cap for any one injected context. */
const TOTAL_CAP_CHARS = 2500;

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap - 1) + '…';
}

export class ContextInjector {
  private readonly deps: ContextInjectorDeps;
  /** Per-session ledger of one-shot nudges already delivered. */
  private readonly nudged = new Map<string, Set<string>>();
  /** The one-shot Stop ledger: a session is nudged at most once. CAP = 1. */
  private readonly stopNudged = new Set<string>();
  /** Sessions whose telegram-mode entry the injected mode block covered. */
  private readonly telegramModeAnnounced = new Set<string>();

  constructor(deps: ContextInjectorDeps) {
    this.deps = deps;
  }

  /** A closed session takes its ledgers with it. */
  forgetSession(sessionId: string): void {
    this.nudged.delete(sessionId);
    this.stopNudged.delete(sessionId);
    this.telegramModeAnnounced.delete(sessionId);
  }

  /** Route one normalised hook event, or null when there is nothing to say. */
  async respond(event: HookEvent): Promise<InjectorResponse> {
    if (!event.helmSessionId) return null;
    const session = this.deps.getSession(event.helmSessionId);
    if (!session) return null;

    // Leaving Telegram mode re-arms the one-shot mode block: the next entry
    // is a new mode entry and must be announced again, exactly as the
    // prepended first-contact block would be.
    if (session.interactionChannel !== 'telegram') this.telegramModeAnnounced.delete(session.id);

    switch (event.event) {
      case 'SessionStart':
        return this.respondSessionStart(event, session);
      case 'UserPromptSubmit':
        return this.respondUserPrompt(event, session);
      case 'Stop':
        return this.respondStop(event, session);
      default:
        // StopFailure and every other event: no-op, always. A died turn is
        // reported fact, not something to retry or steer.
        return null;
    }
  }

  // -- A. SessionStart: plan + drafts + handover ---------------------------

  private respondSessionStart(event: HookEvent, session: SessionInfo): InjectorResponse {
    const parts: string[] = [];
    const plan = this.deps.getClaimedPlan(session.id);
    if (plan) {
      parts.push(
        truncate(
          `Working plan: ${plan.humanId ?? 'P-?'} "${plan.title}" (${plan.status}). ` +
            'Complete it with plan_complete when done; session_plan_claim to put it down or take another.',
          SOURCE_CAP_CHARS,
        ),
      );
    }
    for (const draft of this.deps.getDrafts(session.id)) {
      parts.push(truncate(`Draft memo "${draft.label}": ${draft.text}`, SOURCE_CAP_CHARS));
    }
    const mission = this.deps.getMission?.(session.id);
    if (mission) parts.push(truncate(missionLine(mission), SOURCE_CAP_CHARS));
    const handover = this.deps.getHandover(session.id);
    if (handover) {
      parts.push(truncate(`Handover note carried across your last compaction:\n${handover}`, SOURCE_CAP_CHARS));
    }
    if (parts.length === 0) return null;

    const context = capJoined(parts, TOTAL_CAP_CHARS);
    logger.info(
      `[HookInject] SessionStart session=${session.id} (${session.name}): ` +
        `${parts.length} source(s), ${context.length} chars`,
    );
    return { statusCode: 200, body: encodeAdditionalContext(event, context) };
  }

  // -- B/C/E. UserPromptSubmit: rules, suggester pointer, nudges ------------

  private async respondUserPrompt(event: HookEvent, session: SessionInfo): Promise<InjectorResponse> {
    // Copilot drops command-hook output for this event entirely — anything we
    // return is written into the void. Its sessions keep the prepended rules.
    if (!PROMPT_INJECTION_PROVIDERS.has(event.cli)) return null;

    const prompt = event.prompt ?? '';
    const parts: string[] = [];

    // The rules ride along with the message they govern — a prompt that is
    // not an inter-session envelope gets no rules block. G9: only when the
    // reminder's delivery resolves to hook; 'pty' leaves them to the prepend,
    // 'off' suppresses them, so one message never carries both forms.
    const mode = (reminder: ReminderId) => this.deps.getReminderMode?.(reminder);
    if (prompt.includes('[HELM_MSG')) {
      if (resolveReminderDelivery('helmMsgRules', mode('helmMsgRules'), true).channel === 'hook') {
        parts.push(HELM_MSG_HOOK_RULES);
      }
    } else if (prompt.includes('[HELM_TELEGRAM')) {
      if (resolveReminderDelivery('telegramInstruction', mode('telegramInstruction'), true).channel === 'hook') {
        parts.push(HELM_TELEGRAM_HOOK_RULES);
      }
      // The mode block is announced once per entry into Telegram mode — the
      // injected twin of the relay's first-contact prepend.
      if (
        session.interactionChannel === 'telegram' &&
        !this.telegramModeAnnounced.has(session.id) &&
        resolveReminderDelivery('telegramModeInstructions', mode('telegramModeInstructions'), true).channel === 'hook'
      ) {
        this.telegramModeAnnounced.add(session.id);
        parts.push(HELM_TELEGRAM_MODE_INSTRUCTIONS);
      }
    }

    // Mission rides on every prompt, right after the rules so the payload cap
    // (which drops trailing parts first) never cuts it. Hook-only by design: it
    // has no prepend twin, so it is not a G9 ReminderId (docs/mission-statement.md).
    if (this.deps.getMission) parts.push(missionReminder(this.deps.getMission(session.id)));

    const projectId = session.workingDir ? this.deps.getProjectIdForDirectory(session.workingDir) : null;
    const pointer = await this.deps.suggest(session.id, prompt, projectId);
    if (pointer) parts.push(pointer);

    const nudge = this.oneShotNudges(session);
    if (nudge) parts.push(nudge);


    if (parts.length === 0) return null;
    const context = capJoined(parts, TOTAL_CAP_CHARS);
    logger.debug(
      `[HookInject] UserPromptSubmit session=${session.id}: ${parts.length} part(s), ${context.length} chars`,
    );
    return { statusCode: 200, body: encodeAdditionalContext(event, context) };
  }

  /**
   * Conditional nudges — only when something is actually outstanding, once
   * per thing per session. Nagging every turn is the failure mode.
   */
  private oneShotNudges(session: SessionInfo): string | null {
    const lines: string[] = [];
    if (session.aiagentState === undefined) {
      if (this.markNudged(session.id, 'aiagent-state')) {
        lines.push(
          'Your AIAGENT state is unset — call session_set_aiagent_state so your row shows what you are doing.',
        );
      }
    }
    if (!this.deps.getClaimedPlan(session.id)) {
      const dirPath = session.workingDir ?? '';
      for (const plan of this.deps.getStartablePlans(dirPath)) {
        const key = `startable:${plan.humanId ?? plan.title}`;
        if (!this.markNudged(session.id, key)) continue;
        lines.push(
          `Startable plan here: ${plan.humanId ?? '?'} "${plan.title}" — claim it with session_plan_claim if you want the work.`,
        );
        break; // one pointer is a nudge; a list is a nag
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }

  /** True (and record) on first sight of a nudge key; false afterwards. */
  private markNudged(sessionId: string, key: string): boolean {
    let ledger = this.nudged.get(sessionId);
    if (!ledger) {
      ledger = new Set();
      this.nudged.set(sessionId, ledger);
    }
    if (ledger.has(key)) return false;
    ledger.add(key);
    return true;
  }

  // -- D. Stop: the one-shot nudge -----------------------------------------

  private respondStop(event: HookEvent, session: SessionInfo): InjectorResponse {
    // G8 FIRST: continuation into an auto-implement follow-up, then the
    // one-shot recap verification. Exactly one block per Stop event — when
    // the loop speaks, the nudge below stays silent (and its ledger intact).
    const loopBlock = this.deps.loop?.stopBlock(session);
    if (loopBlock) {
      return { statusCode: 200, body: encodeStopBlock(event, loopBlock) };
    }

    const plan = this.deps.getClaimedPlan(session.id);
    const unsettled = session.aiagentState === undefined;
    if (!plan && !unsettled) return null;
    if (this.stopNudged.has(session.id)) return null; // second Stop ALWAYS passes
    this.stopNudged.add(session.id);

    const lines: string[] = [];
    if (plan) {
      lines.push(
        `You are stopping with plan item ${plan.humanId ?? '?'} "${plan.title}" still claimed and open. ` +
          'Finish it, or complete/set it down with plan_complete or session_plan_claim, then stop again.',
      );
    }
    if (unsettled) {
      lines.push('Your AIAGENT state is unset — call session_set_aiagent_state (e.g. "completed") before stopping.');
    }
    logger.info(`[HookInject] Stop nudge session=${session.id} (${session.name}): blocked once`);
    return { statusCode: 200, body: encodeStopBlock(event, lines.join('\n')) };
  }
}

/** The SessionStart form: just the fact. */
function missionLine(mission: SessionMission): string {
  return `[HELM_MISSION] Current mission: "${mission.text}".`;
}

/** The per-prompt form: the fact plus the standing instruction to keep it current. */
function missionReminder(mission: SessionMission | undefined): string {
  if (!mission) {
    return '[HELM_MISSION] No mission set. Call session_mission_set with a one-line TL;DR of what this session is doing.';
  }
  return `${missionLine(mission)} If this prompt changes the direction of work, call session_mission_set ` +
    'with a new TL;DR (max 500 chars). Otherwise ignore.';
}

/** Join parts and cut the whole payload deterministically — never mid-line. */
function capJoined(parts: string[], cap: number): string {
  const joined = parts.join('\n');
  if (joined.length <= cap) return joined;
  // Drop whole parts from the end until the remainder fits, then truncate
  // what is left. Deterministic: first parts win, lines are never half-cut.
  let kept = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const next = kept + '\n' + parts[i];
    if (next.length > cap) break;
    kept = next;
  }
  return truncate(kept, cap);
}
