/**
 * ContextInjector — hook context, nudges and token-pressure reminders.
 *
 * Its injections are independently optional, SILENT when there is
 * nothing worth saying (null — the common case must be free):
 *
 * A. SessionStart injection — the session's claimed plan and pending
 *    handover note, out-of-band, directory-scoped, size-capped,
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
 * Context pressure alerts are amber on each prompt and red on each hook.
 * Red can accompany StopFailure, but never blocks or retries the failed turn.
 *
 * All deps are injected read functions; this class owns only the
 * once-per-session ledgers. Fail-open lives in the receiver's catch — a
 * throwing dep degrades to no-op, never to a broken session.
 */

import type { SessionInfo, SessionMission } from '../../types/session.js';
import { encodeAdditionalContext, encodeStopBlock } from './hook-encoder.js';
import type { HookEvent } from './hook-normaliser.js';
import {
  resolveReminderDelivery,
  type ReminderDeliveryMode,
  type ReminderId,
} from '../reminder-delivery.js';
import type { LoopDriver } from './loop-driver.js';
import { logger } from '../../utils/logger.js';
import { appendManifestoContext, formatManifestoContext } from '../artifact-context.js';
import { contextLevel, type ContextLimits } from '../context-limits.js';
import { renderHookInjection, type HookInjectionOverrides } from './hook-injections.js';
import { renderSessionTodoContext } from '../todo-context.js';
import type { SessionTodo } from '../../types/todo.js';
import { supportsPostToolUseContext } from './hook-providers.js';
import { buildToolSuggestionQuery } from './tool-suggestion-query.js';

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
  /** Persistent artifact context; every selected manifesto is included. */
  getManifestos?(sessionId: string): Array<{ title: string; content: string }>;
  /** Handover text pending across a compaction, when armed. */
  getHandover(sessionId: string): string | undefined;
  /** The handover just went out in SessionStart context; no paste needed. */
  onHandoverInjected?(sessionId: string): void;
  /**
   * The session's mission TL;DR. Absent dep = mission feature not wired (the
   * injector stays byte-identical to before); present and returning undefined
   * = no mission yet, and the AI is asked to set one.
   */
  getMission?(sessionId: string): SessionMission | undefined;
  /** The session's persistent checklist. Present even when empty so it survives context resets. */
  getTodos?(sessionId: string): SessionTodo[];
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
  /** Tool-result hint path; kept separate so it does not train prompt usage weights. */
  suggestTool?(sessionId: string, query: string, projectId: string | null): Promise<string | null>;
  /** Reset no-repeat hints after a context reset, and tool hints on a new prompt. */
  resetSuggestions?(sessionId: string): void;
  resetToolSuggestionTurn?(sessionId: string): void;
  /** Directory → project id, for pre-filtering suggester candidates. */
  getProjectIdForDirectory(dirPath: string): string | null;
  /**
   * G9: the user's per-reminder delivery mode from settings. Absent means
   * every reminder keeps its default — inject, as G4 already did. The hook
   * FIRING is the capability proof, so capability is always true here; mode
   * 'pty' means the prepend path owns the reminder and nothing is injected.
   */
  getReminderMode?(reminder: ReminderId): ReminderDeliveryMode | undefined;
  /** Last known token thresholds and editable injection templates. */
  getContextLimits?(session: SessionInfo): ContextLimits | undefined;
  getHookInjectionOverrides?(): HookInjectionOverrides;
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
// drops that event's output, so it keeps prepended rules; its separate
// userPromptTransformed event is used only for prompt-specific additions.
// Shared with hook-capability.ts: the delivery side must consult the SAME set
// before deciding the prepended rules header is redundant.
export const PROMPT_INJECTION_PROVIDERS = new Set(['claude', 'codex']);

/** Per-source cap: a source longer than this is truncated, not dropped. */
const SOURCE_CAP_CHARS = 800;
/** Whole-payload cap for any one injected context. */
const TOTAL_CAP_CHARS = 2500;
/** A requested compact that never lands stops suspending todo/ETA bookkeeping after this. */
const COMPACT_PENDING_TTL_MS = 10 * 60_000;

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap - 1) + '…';
}

export class ContextInjector {
  private readonly deps: ContextInjectorDeps;
  /** Per-session ledger of one-shot nudges already delivered. */
  private readonly nudged = new Map<string, Set<string>>();
  /** The one-shot Stop ledger: a session is nudged at most once. CAP = 1. */
  private readonly stopNudged = new Set<string>();
  /** Open-todo Stop reminder: once per user turn, re-armed by the next prompt. */
  private readonly stopTodosNudged = new Set<string>();
  private readonly stopEtaNudged = new Set<string>();
  /** Last context reset (SessionStart compact/clear or PreCompact) per session, epoch ms. */
  private readonly contextResetAt = new Map<string, number>();
  /** Sessions whose telegram-mode entry the injected mode block covered. */
  private readonly telegramModeAnnounced = new Set<string>();

  constructor(deps: ContextInjectorDeps) {
    this.deps = deps;
  }

  private injection(id: Parameters<typeof renderHookInjection>[0], values: Record<string, string | number | undefined> = {}): string {
    return renderHookInjection(id, values, this.deps.getHookInjectionOverrides?.());
  }

  /** A closed session takes its ledgers with it. */
  forgetSession(sessionId: string): void {
    this.nudged.delete(sessionId);
    this.stopNudged.delete(sessionId);
    this.stopTodosNudged.delete(sessionId);
    this.stopEtaNudged.delete(sessionId);
    this.contextResetAt.delete(sessionId);
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

    if (event.event === 'UserPromptSubmit' || event.event === 'UserPromptTransformed') {
      this.stopTodosNudged.delete(session.id);
      this.stopEtaNudged.delete(session.id);
      this.deps.resetToolSuggestionTurn?.(session.id);
    }
    if (event.event === 'PreCompact' ||
      (event.event === 'SessionStart' && ['clear', 'compact'].includes(event.source?.toLowerCase() ?? ''))) {
      this.deps.resetSuggestions?.(session.id);
      this.contextResetAt.set(session.id, Date.now());
    }

    let response: InjectorResponse;
    switch (event.event) {
      case 'SessionStart':
        response = this.respondSessionStart(event, session);
        break;
      case 'UserPromptSubmit':
        // Copilot discards this event's command output. Its supported
        // userPromptTransformed event carries the per-prompt injection.
        if (event.cli === 'copilot') {
          const alert = this.contextAlert(session, false);
          return alert ? { statusCode: 200, body: encodeAdditionalContext(event, alert) } : null;
        }
        response = await this.respondUserPrompt(event, session);
        break;
      case 'UserPromptTransformed':
        response = await this.respondUserPrompt(event, session);
        break;
      case 'PostToolUse':
        response = await this.respondPostToolUse(event, session);
        break;
      case 'Stop':
        response = this.respondStop(event, session);
        break;
      default:
        response = null;
        break;
    }
    const alert = event.event === 'UserPromptSubmit' || event.event === 'UserPromptTransformed'
      ? null
      : this.contextAlert(session, false);
    return alert ? this.attachAlert(event, response, alert) : response;
  }

  // -- A. SessionStart: plan + handover ---------------------------

  private respondSessionStart(event: HookEvent, session: SessionInfo): InjectorResponse {
    // Manifesto context and any already-pending handover travel together, but
    // keep the whole persistent section ahead of capped incidental context.
    const parts: string[] = session.role === 'operator' ? [this.injection('operatorMantra')] : [];
    const formattedManifesto = formatManifestoContext(this.deps.getManifestos?.(session.id) ?? []);
    const manifestoContext = formattedManifesto ? this.injection('manifestoContext', { content: formattedManifesto }) : '';
    const plan = this.deps.getClaimedPlan(session.id);
    if (plan) {
      parts.push(
        truncate(
          this.injection('workingPlan', { humanId: plan.humanId ?? 'P-?', title: plan.title, status: plan.status }),
          SOURCE_CAP_CHARS,
        ),
      );
    }
    // Open tasks lead: the total cap drops trailing sources first, and a
    // dropped task is an ask the operator silently stops chasing.
    const tasks = session.role === 'operator' ? this.deps.getOpenTasks?.(session.id) ?? [] : [];
    if (tasks.length > 0) {
      parts.push(truncate(
        this.injection('openTasks', { tasks: tasks.join('; ') }),
        SOURCE_CAP_CHARS,
      ));
    }
    // Leads the non-operator sources: without it the session answers a user
    // who is not watching instead of the operator that is waiting.
    if (session.reportsTo) {
      parts.push(
        this.injection('reportsTo', { sessionId: session.reportsTo }),
      );
    }
    const mission = this.deps.getMission?.(session.id);
    if (mission) parts.push(truncate(this.injection('missionStart', { text: mission.text }), SOURCE_CAP_CHARS));
    const todos = this.deps.getTodos?.(session.id);
    if (todos && !this.compactPending(session)) parts.push(truncate(renderSessionTodoContext(todos, this.deps.getHookInjectionOverrides?.()), SOURCE_CAP_CHARS));
    const rings = session.role === 'operator' ? this.deps.getRingRequests?.(session.id) ?? [] : [];
    if (rings.length > 0) {
      parts.push(truncate(
        this.injection('ringRequests', { requests: rings.join('; ') }),
        SOURCE_CAP_CHARS,
      ));
    }
    const handover = this.deps.getHandover(session.id);
    const persistentContext = appendManifestoContext(
      handover ? this.injection('handover', { content: handover }) : undefined,
      manifestoContext,
    );
    if (persistentContext) {
      if (manifestoContext) parts.unshift(persistentContext);
      else parts.push(truncate(persistentContext, SOURCE_CAP_CHARS));
    }
    if (parts.length === 0) return null;

    // Manifestos are explicitly opted-in persistent context: reserve space for
    // every one plus the ordinary allowance for other context sources.
    const protectedLength = manifestoContext ? persistentContext?.length ?? 0 : 0;
    const context = capJoined(parts, protectedLength + TOTAL_CAP_CHARS);
    if (handover) this.deps.onHandoverInjected?.(session.id);
    logger.info(
      `[HookInject] SessionStart session=${session.id} (${session.name}): ` +
        `${parts.length} source(s), ${context.length} chars`,
    );
    return { statusCode: 200, body: encodeAdditionalContext(event, context) };
  }

  // -- B/C/E. UserPromptSubmit: rules, suggester pointer, nudges ------------

  private async respondUserPrompt(event: HookEvent, session: SessionInfo): Promise<InjectorResponse> {
    if (event.event === 'UserPromptTransformed') {
      // Copilot exposes transformed prompt mutation, but this new path only
      // carries the token alert; it does not change existing prompt behavior.
      if (event.cli !== 'copilot' || typeof event.transformedPrompt !== 'string') return null;
      const alert = this.contextAlert(session, true);
      return alert ? { statusCode: 200, body: encodeAdditionalContext(event, alert) } : null;
    }
    if (!PROMPT_INJECTION_PROVIDERS.has(event.cli)) return null;
    const hookCanCarryStandingRules = PROMPT_INJECTION_PROVIDERS.has(event.cli);
    const context = await this.userPromptContext(session, event.prompt ?? '', () => true, true, hookCanCarryStandingRules);
    return context ? { statusCode: 200, body: encodeAdditionalContext(event, context) } : null;
  }

  private async respondPostToolUse(event: HookEvent, session: SessionInfo): Promise<InjectorResponse> {
    if (!this.deps.suggestTool || !supportsPostToolUseContext(event.cli)) return null;
    const query = buildToolSuggestionQuery(event);
    if (!query) return null;
    const projectId = session.workingDir ? this.deps.getProjectIdForDirectory(session.workingDir) : null;
    const pointer = await this.deps.suggestTool(session.id, query, projectId);
    return pointer
      ? { statusCode: 200, body: encodeAdditionalContext(event, this.injection('suggestionPointer', { content: pointer })) }
      : null;
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
    return this.userPromptContext(session, prompt, tools ? (tool) => tools.has(tool) : () => true, true);
  }

  private async userPromptContext(
    session: SessionInfo,
    prompt: string,
    can: (tool: string) => boolean = () => true,
    includePromptAlert = false,
    hookCanCarryStandingRules = true,
  ): Promise<string | null> {
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
      if (can('chat_send') && resolveReminderDelivery('helmMsgRules', mode('helmMsgRules'), hookCanCarryStandingRules).channel === 'hook') {
        parts.push(this.injection('helmMsgRules'));
      }
    } else if (prompt.includes('[HELM_TELEGRAM')) {
      if (resolveReminderDelivery('telegramInstruction', mode('telegramInstruction'), hookCanCarryStandingRules).channel === 'hook') {
        parts.push(this.injection('telegramRules'));
      }
      // The mode block is announced once per entry into Telegram mode — the
      // injected twin of the relay's first-contact prepend.
      if (
        session.interactionChannel === 'telegram' &&
        !this.telegramModeAnnounced.has(session.id) &&
        resolveReminderDelivery('telegramModeInstructions', mode('telegramModeInstructions'), hookCanCarryStandingRules).channel === 'hook'
      ) {
        this.telegramModeAnnounced.add(session.id);
        parts.push(this.injection('telegramMode'));
      }
    }

    // Mission rides on every prompt, right after the rules so the payload cap
    // (which drops trailing parts first) never cuts it. Hook-only by design: it
    // has no prepend twin, so it is not a G9 ReminderId (docs/mission-statement.md).
    // Without session_mission_set the mission is a fact to read, not an instruction.
    if (this.deps.getMission) {
      const mission = this.deps.getMission(session.id);
      if (can('session_mission_set')) {
        parts.push(mission
          ? this.injection('missionPromptCurrent', { text: mission.text })
          : this.injection('missionPromptUnset'));
      } else if (mission) parts.push(this.injection('missionStart', { text: mission.text }));
    }

    if (this.deps.getTodos && !this.compactPending(session)) {
      parts.push(truncate(
        renderSessionTodoContext(this.deps.getTodos(session.id), this.deps.getHookInjectionOverrides?.()),
        SOURCE_CAP_CHARS,
      ));
    }

    const projectId = session.workingDir ? this.deps.getProjectIdForDirectory(session.workingDir) : null;
    const pointer = await this.deps.suggest(session.id, prompt, projectId);
    if (pointer && (can('memory_get') || can('skill_get'))) parts.push(this.injection('suggestionPointer', { content: pointer }));

    const nudge = this.oneShotNudges(session, can);
    if (nudge) parts.push(nudge);

    const alert = this.contextAlert(session, includePromptAlert);
    if (alert) parts.unshift(alert);
    if (parts.length === 0) return null;
    const context = capJoined(parts, TOTAL_CAP_CHARS);
    logger.debug(
      `[HookInject] UserPromptSubmit session=${session.id}: ${parts.length} part(s), ${context.length} chars`,
    );
    return context;
  }

  /** The session asked to be compacted and no compact or clear has landed since. */
  private compactPending(session: SessionInfo): boolean {
    const at = session.compactRequestedAt;
    if (at === undefined || Date.now() - at > COMPACT_PENDING_TTL_MS) return false;
    return Math.max(session.lastCliCompactAt ?? 0, this.contextResetAt.get(session.id) ?? 0) < at;
  }

  private contextAlert(session: SessionInfo, promptEvent: boolean): string | null {
    const tokens = session.contextUsage?.tokens;
    const limits = this.deps.getContextLimits?.(session);
    if (typeof tokens !== 'number' || tokens <= 0 || !limits) return null;
    const level = contextLevel(tokens, limits);
    const values = { tokens, amber: limits.amber, red: limits.red, level: level === 'hot' ? 'red' : 'amber' };
    const overrides = this.deps.getHookInjectionOverrides?.();
    if (level === 'hot') return renderHookInjection('redContextAlert', values, overrides);
    if (promptEvent && level === 'warn') return renderHookInjection('amberContextAlert', values, overrides);
    return null;
  }

  /** Attach an alert without changing the hook's allow/deny/stop decision. */
  private attachAlert(event: HookEvent, response: InjectorResponse, alert: string): InjectorResponse {
    if (response && event.event === 'Stop') {
      const body = { ...response.body };
      if (body.decision === 'block' && typeof body.reason === 'string') {
        body.reason = `${body.reason}\n\n${alert}`;
        return { ...response, body };
      }
    }
    if (!response) return { statusCode: 200, body: encodeAdditionalContext(event, alert) };
    const body = { ...response.body };
    const specific = body.hookSpecificOutput;
    if (specific && typeof specific === 'object' && !Array.isArray(specific)) {
      const nested = specific as Record<string, unknown>;
      const current = typeof nested.additionalContext === 'string' ? nested.additionalContext : '';
      body.hookSpecificOutput = { ...nested, additionalContext: current ? `${current}\n\n${alert}` : alert };
    } else {
      const current = typeof body.additionalContext === 'string' ? body.additionalContext : '';
      body.additionalContext = current ? `${current}\n\n${alert}` : alert;
    }
    return { ...response, body };
  }

  /**
   * Conditional nudges — only when something is actually outstanding, once
   * per thing per session. Nagging every turn is the failure mode.
   */
  private oneShotNudges(session: SessionInfo, can: (tool: string) => boolean): string | null {
    const lines: string[] = [];
    if (session.aiagentState === undefined && can('session_set_aiagent_state')) {
      if (this.markNudged(session.id, 'aiagent-state')) {
        lines.push(this.injection('aiagentNudge'));
      }
    }
    if (can('session_plan_claim') && !this.deps.getClaimedPlan(session.id)) {
      const dirPath = session.workingDir ?? '';
      for (const plan of this.deps.getStartablePlans(dirPath)) {
        const key = `startable:${plan.humanId ?? plan.title}`;
        if (!this.markNudged(session.id, key)) continue;
        lines.push(this.injection('startablePlanNudge', { humanId: plan.humanId ?? '?', title: plan.title }));
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
      return { statusCode: 200, body: encodeStopBlock(event, this.injection('loopStopBlock', { content: loopBlock })) };
    }

    const plan = this.deps.getClaimedPlan(session.id);
    const unsettled = session.aiagentState === undefined;
    // The plan/state nudge fires once per session (the second Stop always passes);
    // the todo reminder once per user turn.
    const nudge = (plan || unsettled) && !this.stopNudged.has(session.id);
    // A requested compact makes todo/ETA nudges moot: the turn ends so the
    // compact can run, and the nudges re-arm once it lands.
    const bookkeeping = !this.compactPending(session);
    const openTodos = !bookkeeping || this.stopTodosNudged.has(session.id)
      ? []
      : (this.deps.getTodos?.(session.id) ?? []).filter(todo => todo.status === 'open');
    const openEta = bookkeeping && session.eta !== undefined && !this.stopEtaNudged.has(session.id);
    if (!nudge && openTodos.length === 0 && !openEta) return null;

    const lines: string[] = [];
    if (nudge) {
      this.stopNudged.add(session.id);
      if (plan) lines.push(this.injection('stopPlanNudge', { humanId: plan.humanId ?? '?', title: plan.title }));
      if (unsettled) lines.push(this.injection('stopAiagentNudge'));
    }
    if (openTodos.length) {
      this.stopTodosNudged.add(session.id);
      lines.push(this.injection('stopTodosNudge', { todos: openTodos.map(todo => `- ${todo.text}`).join('\n') }));
    }
    if (openEta) {
      this.stopEtaNudged.add(session.id);
      lines.push(this.injection('stopEtaNudge'));
    }
    logger.info(`[HookInject] Stop nudge session=${session.id} (${session.name}): blocked once`);
    return { statusCode: 200, body: encodeStopBlock(event, lines.join('\n')) };
  }
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
