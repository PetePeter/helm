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
import { OPERATOR_MANTRA } from '../../mcp/guides/operator-guide.js';
import { logger } from '../../utils/logger.js';

/** A claimed plan reduced to what a nudge names. */
export interface ClaimedPlanSummary {
  humanId?: string;
  title: string;
  status: string;
}

/** Tldr prefix marking an operator memory as a pending "call me when…" watch. */
export const RING_ME_PREFIX = '[RING-ME]';

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
  /**
   * The operator's pending "call me when…" requests — the tldrs of its
   * `RING_ME_PREFIX` memories. Asked only for the operator, the one session
   * allowed to ring; SessionStart fires after every compaction, so the watch
   * survives the context it was made in.
   */
  getRingRequests?(sessionId: string): string[];
  /** The user spoke to an operator-started session directly: it now answers the user. */
  clearReportsTo?(sessionId: string): void;
  /** The operator's open task plans, one line each. Asked for the operator only. */
  getOpenTasks?(sessionId: string): string[];
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
    // The mantra leads for the operator: the cap drops trailing sources first.
    const parts: string[] = session.role === 'operator' ? [OPERATOR_MANTRA] : [];
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
    // Open tasks lead: the total cap drops trailing sources first, and a
    // dropped task is an ask the operator silently stops chasing.
    const tasks = session.role === 'operator' ? this.deps.getOpenTasks?.(session.id) ?? [] : [];
    if (tasks.length > 0) {
      parts.push(truncate(
        `Your open tasks: ${tasks.join('; ')}. ` +
          'Keep following each until done; when one is, plan_complete it (Helm cancels its timer).',
        SOURCE_CAP_CHARS,
      ));
    }
    // Leads the non-operator sources: without it the session answers a user
    // who is not watching instead of the operator that is waiting.
    if (session.reportsTo) {
      parts.push(
        `You were started by the Helm operator (session "${session.reportsTo}") and work for it. ` +
          'Report progress, results and ANY questions to it with session_send_text ' +
          `(sessionId "${session.reportsTo}"; expectsResponse=true for questions) — not to the user — ` +
          'until the user messages you directly.',
      );
    }
    for (const draft of this.deps.getDrafts(session.id)) {
      parts.push(truncate(`Draft memo "${draft.label}": ${draft.text}`, SOURCE_CAP_CHARS));
    }
    const mission = this.deps.getMission?.(session.id);
    if (mission) parts.push(truncate(missionLine(mission), SOURCE_CAP_CHARS));
    const rings = session.role === 'operator' ? this.deps.getRingRequests?.(session.id) ?? [] : [];
    if (rings.length > 0) {
      parts.push(truncate(
        `Pending ring-me requests (your ${RING_ME_PREFIX} memories): ${rings.join('; ')}. ` +
          'Check each; when one is met, ring_user with a short reason, then memory_delete it.',
        SOURCE_CAP_CHARS,
      ));
    }
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
    const context = await this.userPromptContext(session, event.prompt ?? '');
    return context ? { statusCode: 200, body: encodeAdditionalContext(event, context) } : null;
  }

  /**
   * The per-prompt context as plain text — the CLI hook reply encodes it, an
   * API-tool session appends it to its user message. Null = nothing to say.
   * `tools` = what the session can actually call: a hint whose tool it lacks
   * is dropped, because a small model will burn turns hunting for that tool.
   */
  async promptContext(sessionId: string, prompt: string, tools?: ReadonlySet<string>): Promise<string | null> {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;
    if (session.interactionChannel !== 'telegram') this.telegramModeAnnounced.delete(session.id);
    return this.userPromptContext(session, prompt, tools ? (tool) => tools.has(tool) : () => true);
  }

  private async userPromptContext(session: SessionInfo, prompt: string, can: (tool: string) => boolean = () => true): Promise<string | null> {
    const parts: string[] = [];

    // The user reaching an operator-started session themselves (phone or
    // Telegram) takes it over: from now on it answers them, not the operator.
    if (session.reportsTo && (prompt.includes('"fromSessionId":"mobile:') || prompt.includes('[HELM_TELEGRAM'))) {
      this.deps.clearReportsTo?.(session.id);
    }

    // The rules ride along with the message they govern — a prompt that is
    // not an inter-session envelope gets no rules block. G9: only when the
    // reminder's delivery resolves to hook; 'pty' leaves them to the prepend,
    // 'off' suppresses them, so one message never carries both forms.
    const mode = (reminder: ReminderId) => this.deps.getReminderMode?.(reminder);
    if (prompt.includes('[HELM_MSG')) {
      if (can('chat_send') && resolveReminderDelivery('helmMsgRules', mode('helmMsgRules'), true).channel === 'hook') {
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
    // Without session_mission_set the mission is a fact to read, not an instruction.
    if (this.deps.getMission) {
      const mission = this.deps.getMission(session.id);
      if (can('session_mission_set')) parts.push(missionReminder(mission));
      else if (mission) parts.push(missionLine(mission));
    }

    const projectId = session.workingDir ? this.deps.getProjectIdForDirectory(session.workingDir) : null;
    const pointer = await this.deps.suggest(session.id, prompt, projectId);
    if (pointer && (can('memory_get') || can('skill_get'))) parts.push(pointer);

    const nudge = this.oneShotNudges(session, can);
    if (nudge) parts.push(nudge);

    if (parts.length === 0) return null;
    const context = capJoined(parts, TOTAL_CAP_CHARS);
    logger.debug(
      `[HookInject] UserPromptSubmit session=${session.id}: ${parts.length} part(s), ${context.length} chars`,
    );
    return context;
  }

  /**
   * Conditional nudges — only when something is actually outstanding, once
   * per thing per session. Nagging every turn is the failure mode.
   */
  private oneShotNudges(session: SessionInfo, can: (tool: string) => boolean): string | null {
    const lines: string[] = [];
    if (session.aiagentState === undefined && can('session_set_aiagent_state')) {
      if (this.markNudged(session.id, 'aiagent-state')) {
        lines.push(
          'Your AIAGENT state is unset — call session_set_aiagent_state so your row shows what you are doing.',
        );
      }
    }
    if (can('session_plan_claim') && !this.deps.getClaimedPlan(session.id)) {
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
