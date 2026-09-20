/**
 * LoopDriver — G8's Stop-block continuation, gated on consent that already
 * exists (plan P-0789; decided context node "Hook — loop driving: what
 * decides go vs stop").
 *
 * THE PRINCIPLE: loop driving NEVER decides for itself whether to continue.
 * It reads three facts something external already recorded:
 *
 *   autoImplement  → the go/no-go. Consent was recorded per plan, BEFORE the
 *                    loop started. Unticked means stop.
 *   followUpPlans  → the what-next, already computed by plan_complete. An
 *                    empty list is a natural terminator, not a heuristic.
 *   completionRecap→ a QUALITY gate ("did you verify what you claim"), never
 *                    a continuation gate. Conflating them produces a loop
 *                    that argues with itself about whether it is finished.
 *
 * TWO separate gates on the same Stop event, and the distinction is the
 * heart of the design:
 *   CONTINUATION — gated on autoImplement, may repeat to the cap, OFF by
 *                  default (per-session opt-in + global kill switch)
 *   VERIFICATION — gated on completionRecap, capped at 1, NOT configurable,
 *                  and must work when loop driving is off
 * Continuation is checked FIRST; exactly one block is ever emitted per Stop.
 *
 * HARD STOPS, all enforced in stopBlock:
 *   - consecutive auto-continue cap (default 5): allow the stop, flash once
 *   - no measurable progress since the last Stop (no edit, no commit, no
 *     completion): allow the stop. Spinning is the real failure.
 *   - StopFailure NEVER continues — it resets the loop instead. Retrying a
 *     usage-limit stall in a loop is the worst case this feature has.
 *
 * Everything here is fed from the receiver's hook stream and plan_complete;
 * failures are swallowed by the caller's fail-open (the injector), so a
 * throwing dep degrades to "no block", never to a dead Stop path.
 */

import type { EventEmitter } from 'node:events';
import type { HookEvent } from './hook-normaliser.js';
import { EDIT_TOOL_PATTERN } from './hook-tracker.js';
import type { SessionInfo } from '../../types/session.js';
import { logger } from '../../utils/logger.js';

/** Shipped consecutive auto-continue cap. Configurable in settings.yaml. */
export const DEFAULT_MAX_AUTO_CONTINUES = 5;

/** The whole G8 settings section, already validated and defaulted. */
export interface LoopConfig {
  enabled: boolean;
  maxAutoContinues: number;
}

/** A live plan read at Stop time — the slice of PlanItem the driver needs. */
export interface LoopPlanView {
  id: string;
  humanId?: string;
  title: string;
  status: string;
  autoImplement?: boolean;
  /** Whichever session currently claims the plan, when anyone does. */
  sessionId?: string;
}

/** What plan_complete hands over: the finished plan and its follow-ups. */
export interface LoopCompletionNotice {
  planId: string;
  humanId?: string;
  title: string;
  completionRecap?: boolean;
  followUps: Array<{ id: string; humanId?: string; title: string }>;
}

export interface LoopDriverDeps {
  getSession(sessionId: string): SessionInfo | null;
  /** Live plan lookup — eligibility is decided at Stop time, not snapshotted. */
  getPlan(planId: string): LoopPlanView | null;
  /** SessionManager.updateSession — the counter on the session row. */
  updateSession(sessionId: string, updates: Partial<SessionInfo>): void;
  /** The grab-the-user flash, fired once when the cap ends a loop. */
  flashAttention(sessionId: string): unknown;
  /** Live settings read — the global kill switch and the cap. */
  getLoopConfig(): LoopConfig;
}

/** Per-session loop state. Ephemeral — nothing here survives a restart. */
interface LoopState {
  /** The last plan this session completed, and its follow-ups. */
  completion: LoopCompletionNotice;
  /** Consecutive auto-continues issued. Resets on a user turn. */
  continues: number;
  /** Monotonic progress ticks: edits, commits, completions. */
  ticks: number;
  /** Ticks at the previous Stop — no delta means no progress. */
  lastStopTicks: number;
  /** The one-shot recap ledger for the current completion. */
  recapBlocked: boolean;
  /** Our last block reason, awaiting its UserPromptSubmit (or a Stop). */
  pendingReason: string | null;
  /** Flash-once guard for the cap, re-armed when the counter resets. */
  capFlashed: boolean;
}

export class LoopDriver {
  private readonly states = new Map<string, LoopState>();
  private receiver: EventEmitter | null = null;

  constructor(private readonly deps: LoopDriverDeps) {}

  /** Subscribe to the receiver's hook stream. */
  watch(receiver: EventEmitter): void {
    this.receiver = receiver;
    receiver.on('hook', this.handle);
  }

  dispose(): void {
    this.receiver?.off('hook', this.handle);
    this.receiver = null;
    this.states.clear();
  }

  /** A closed session takes its loop state with it. */
  forgetSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /**
   * One normalised hook event. Never throws: the stream feeds the Stop
   * decision, and a driver bug must not become a broken Stop path.
   */
  handle = (event: HookEvent): void => {
    try {
      this.dispatch(event);
    } catch (error) {
      logger.warn(`[LoopDriver] Swallowed a handler failure for ${event.event}: ${String(error)}`);
    }
  };

  private dispatch(event: HookEvent): void {
    const sessionId = event.helmSessionId;
    if (!sessionId || !this.deps.getSession(sessionId)) return;

    switch (event.event) {
      case 'UserPromptSubmit':
        this.notePrompt(sessionId, event.prompt ?? '');
        break;
      case 'PostToolUse':
        this.noteToolUse(event);
        break;
      case 'StopFailure':
        // The turn died on an API error. Retrying it in a loop is the worst
        // case this feature has, so the loop state dies with the turn.
        this.reset(sessionId, 'StopFailure');
        break;
      default:
        break;
    }
  }

  /** plan_complete reporting what finished and what could follow it. */
  noteCompletion(sessionId: string, notice: LoopCompletionNotice): void {
    const state = this.states.get(sessionId);
    // A completion is plan movement — it ticks progress even when nothing
    // else happened between the last Stop and this one.
    if (state) {
      state.completion = notice;
      state.recapBlocked = false;
      state.ticks++;
      return;
    }
    this.states.set(sessionId, {
      completion: notice,
      continues: 0,
      ticks: 1,
      lastStopTicks: 0,
      recapBlocked: false,
      pendingReason: null,
      capFlashed: false,
    });
  }

  /**
   * THE Stop decision: continuation first, then verification, exactly one
   * block. Returns the block reason (the next turn's prompt) or null to
   * allow the stop.
   */
  stopBlock(session: SessionInfo): string | null {
    const state = this.states.get(session.id);
    if (!state) return null;

    const config = this.deps.getLoopConfig();
    const optedIn = session.loopDriving === true && config.enabled;
    const next = this.pickFollowUp(state);

    // Snapshot progress for the NEXT Stop before any branch returns.
    const progressed = state.ticks > state.lastStopTicks;
    state.lastStopTicks = state.ticks;

    if (optedIn && next) {
      if (!progressed) {
        // No edit, no commit, no plan movement since the last Stop: the loop
        // is spinning. Stopping early is not the failure; spinning is.
        logger.info(`[LoopDriver] Allowing stop for ${session.id}: no progress since the last Stop`);
        this.clearRowCounter(session.id, state);
        return null;
      }
      if (state.continues >= config.maxAutoContinues) {
        // Work is still outstanding, but the consent budget is spent. Allow
        // the stop and make sure the user SEES that the cap ended it.
        if (!state.capFlashed) {
          state.capFlashed = true;
          this.deps.flashAttention(session.id);
          logger.info(
            `[LoopDriver] Allowing stop for ${session.id}: auto-continue cap ` +
              `${config.maxAutoContinues} reached with ${next.humanId ?? next.id} still outstanding`,
          );
        }
        this.clearRowCounter(session.id, state);
        return null;
      }
      state.continues++;
      state.pendingReason = this.continuationReason(next, state.continues, config.maxAutoContinues);
      this.safeUpdate(session.id, { loopContinues: state.continues });
      logger.info(
        `[LoopDriver] Continuing ${session.id} (${session.name}) into ${next.humanId ?? next.id} ` +
          `— auto-continue ${state.continues}/${config.maxAutoContinues}`,
      );
      return state.pendingReason;
    }

    // No continuation this Stop (off, killed, nothing eligible, or the loop's
    // hard stops above already returned). The LAST plan in a chain marked for
    // recap gets its one-shot verification block — a quality gate, not a
    // continuation: it must fire with loop driving off, and never after the
    // cap ended the loop (that stop is a hard stop; a recap turn would undo it).
    if (
      state.completion.completionRecap === true &&
      !state.recapBlocked &&
      !(optedIn && next)
    ) {
      state.recapBlocked = true;
      const completion = state.completion;
      const reason =
        `Plan ${completion.humanId ?? completion.planId} "${completion.title}" is complete but you have not ` +
        'completed your recap — state what you verified to call it done (tests run and their results, criteria ' +
        'checked, anything left unverified), then stop again. This reminder appears once.';
      logger.info(
        `[LoopDriver] Recap verification block for ${session.id} (${session.name}): ` +
          `${completion.humanId ?? completion.planId}`,
      );
      return reason;
    }

    this.clearRowCounter(session.id, state);
    return null;
  }

  /**
   * The eligible follow-up, read LIVE: still existing, ready (precursors
   * done — recomputeStartable keeps unfinished ones 'planning'), marked
   * auto-implement, and not claimed by anyone (this session included — it
   * would be mid-work, not at a completion boundary).
   */
  private pickFollowUp(state: LoopState): LoopPlanView | null {
    for (const followUp of state.completion.followUps) {
      const plan = this.deps.getPlan(followUp.id);
      if (!plan) continue;
      if (plan.status !== 'ready') continue;
      if (!plan.autoImplement) continue;
      if (plan.sessionId) continue;
      return plan;
    }
    return null;
  }

  private continuationReason(plan: LoopPlanView, continues: number, cap: number): string {
    const ref = plan.humanId ?? plan.id;
    return (
      `Continue the plan chain: ${ref} "${plan.title}" is ready and marked auto-implement. ` +
      `Claim it with session_plan_claim (your sessionId, ${ref}) and implement it to completion, ` +
      `then call plan_complete. (Auto-continue ${continues}/${cap}; a real user message or the ` +
      'kill switch ends the chain.)'
    );
  }

  /**
   * A prompt arrived. Ours (the block reason fed back as the next prompt)
   * is consumed without touching the loop. A genuine user turn ENDS the
   * chain: the user typing is the strongest possible signal that they have
   * taken the wheel, and continuing past it is surprising in the one
   * direction this feature must never surprise. The DAG is still the
   * consent, so the next plan_complete re-arms the chain naturally — the
   * user just has to finish a turn first.
   */
  private notePrompt(sessionId: string, prompt: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    if (state.pendingReason && prompt === state.pendingReason) {
      state.pendingReason = null;
      return;
    }
    this.reset(sessionId, 'user turn');
  }

  /** An edit-shaped tool or a shell commit is measurable progress. */
  private noteToolUse(event: HookEvent): void {
    const sessionId = event.helmSessionId!;
    const state = this.states.get(sessionId);
    if (!state) return;
    if (event.toolName && EDIT_TOOL_PATTERN.test(event.toolName)) {
      state.ticks++;
      return;
    }
    const command = event.toolInput?.command;
    if (typeof command === 'string' && /\bgit\s+commit\b/.test(command)) {
      state.ticks++;
    }
  }

  private reset(sessionId: string, why: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    this.states.delete(sessionId);
    this.safeUpdate(sessionId, { loopContinues: undefined });
    logger.info(`[LoopDriver] Loop state reset for ${sessionId}: ${why}`);
  }

  /** Take the counter off the session row once the loop is no longer running. */
  private clearRowCounter(sessionId: string, state: LoopState): void {
    if (state.continues === 0) return;
    state.continues = 0;
    state.capFlashed = false;
    this.safeUpdate(sessionId, { loopContinues: undefined });
  }

  private safeUpdate(sessionId: string, updates: Partial<SessionInfo>): void {
    try {
      this.deps.updateSession(sessionId, updates);
    } catch (error) {
      logger.warn(`[LoopDriver] Session row update failed for ${sessionId}: ${String(error)}`);
    }
  }
}
