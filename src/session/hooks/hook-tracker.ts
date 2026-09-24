/**
 * HookTracker — the first subscriber of HookReceiver's `hook` stream (G3).
 *
 * Hooks report four things the timing fallback can only guess at, and each
 * lands through the producer that already owns it — nothing here invents a new
 * state channel:
 *
 *   working / turn ended  → StateDetector's existing `activity-change` events
 *                           (hooks are a second producer; the dot pipeline,
 *                           flash, Telegram flushing and every other consumer
 *                           are untouched)
 *   stall (StopFailure)   → SessionManager.updateSession, the single mutation
 *                           choke point; the record is durable (see
 *                           serializeSession's allow-list, invariant 6)
 *   plan progress         → PlanManager.setState on the session's claimed item
 *   PreCompact            → a Helm-composed snapshot artifact + immediate
 *                           handover delivery (replacing the lull heuristic,
 *                           which stays as the fallback for unhooked sessions)
 *
 * A session WITHOUT hooks simply never produces hook events, so none of this
 * runs and its behaviour is exactly what it was before — StateDetector's
 * timing remains the producer of record. Zero behaviour change is the
 * regression suite in tests/state-detector.test.ts.
 *
 * The snapshot is composed BY HELM (see the decided context note "the context
 * save must not depend on the agent"): at PreCompact the agent's context is
 * full and cannot be asked. Everything in the artifact comes from data Helm
 * already holds. The raw transcript is ATTACHED, never inlined; when it is
 * missing or over the attachment cap the summary stands alone — never a
 * truncated attachment.
 *
 * Handler failures are swallowed: a throwing tracker must not break the
 * /hooks endpoint (whose no-op 200 is what keeps every CLI session working).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { HookEvent } from './hook-normaliser.js';
import type { StateDetector } from '../state-detector.js';
import type { SessionManager } from '../manager.js';
import type { PlanManager } from '../plan-manager.js';
import type { HandoverDelivery } from '../handover-delivery.js';
import type { DraftManager } from '../draft-manager.js';
import type { ArtifactManager } from '../artifact-manager.js';
import type { ArtifactAttachmentManager } from '../artifact-attachment-manager.js';
import { MAX_ATTACHMENT_BYTES } from '../artifact-attachment-manager.js';
import { logger } from '../../utils/logger.js';

/** Tools whose use means files are actually being changed (not just read).
 *  Shared with loop-driver.ts: G8's no-progress Stop reads the same notion
 *  of "an edit happened" the plan tracker advances on. */
export const EDIT_TOOL_PATTERN = /(edit|write|apply.?patch|create_file|str_replace)/i;

/** toolInput keys whose string values are touched file paths. */
const FILE_INPUT_KEYS = ['file_path', 'notebook_path', 'filePath', 'notebookPath', 'path'];

/**
 * Where a StopFailure payload says why the turn died. Claude documents an
 * error-type matcher (rate_limit, overloaded, …); the exact payload field is
 * read defensively across the plausible spellings, with an honest fallback.
 */
const STALL_REASON_KEYS = ['error', 'error_type', 'errorType', 'reason', 'message'];

export const SNAPSHOT_TITLE = 'Compaction snapshot';

/** Ephemeral per-session facts accumulated from hook events. Never persisted —
 *  they only exist to compose the PreCompact snapshot. */
interface SessionFacts {
  /** UserPromptSubmit count since the last SessionStart. */
  turns: number;
  /** toolName → uses, since the last SessionStart. */
  toolCounts: Map<string, number>;
  /** Distinct file paths touched by tools, since the last SessionStart. */
  filesTouched: Set<string>;
}

/** The slice of NotificationManager the tracker needs — the grab-the-user flash. */
type FlashSink = (sessionId: string) => unknown;

export interface HookTrackerDeps {
  stateDetector: StateDetector;
  sessionManager: SessionManager;
  planManager: PlanManager;
  /** Normally `notificationManager.flashAttention.bind(notificationManager)`. */
  flashAttention: FlashSink;
  handoverDelivery: Pick<HandoverDelivery, 'deliverFromPreCompact' | 'peek'>;
  draftManager: Pick<DraftManager, 'getForSession'>;
  artifactManager: Pick<ArtifactManager, 'create'>;
  artifactAttachments: Pick<ArtifactAttachmentManager, 'add'>;
  now?: () => number;
}

export interface PreCompactSnapshotInput {
  sessionName: string;
  trigger?: string;
  turns: number;
  /** Wall-clock age of the session, when known. */
  ageMs?: number;
  plan: { title: string; status: string } | null;
  toolCounts: Array<[string, number]>;
  filesTouched: string[];
  drafts: Array<{ label: string; text: string }>;
  pendingHandover?: string;
  transcriptAttached: boolean;
}

/** The one line of the stall record a cleared stall leaves behind. */
export type StallRecord = { at: number; reason: string };

export class HookTracker {
  private readonly facts = new Map<string, SessionFacts>();
  private receiver: EventEmitter | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: HookTrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Subscribe to the receiver's hook stream and session teardown. */
  watch(receiver: EventEmitter): void {
    this.receiver = receiver;
    receiver.on('hook', this.handle);
    this.deps.sessionManager.on('session:removed', this.onSessionRemoved);
  }

  dispose(): void {
    this.receiver?.off('hook', this.handle);
    this.deps.sessionManager.off('session:removed', this.onSessionRemoved);
    this.facts.clear();
  }

  /**
   * One normalised hook event. Never throws: the /hooks reply is what the CLI
   * blocks on, and a tracker bug must not turn into a dead hook transport.
   */
  handle = (event: HookEvent): void => {
    try {
      this.dispatch(event);
    } catch (error) {
      logger.warn(`[HookTracker] Swallowed a handler failure for ${event.event}: ${String(error)}`);
    }
  };

  private dispatch(event: HookEvent): void {
    const sessionId = event.helmSessionId;
    // Uncorrelated (Helm did not spawn this CLI) or already closed — untouched.
    if (!sessionId || !this.deps.sessionManager.hasSession(sessionId)) return;

    this.recordThreadId(sessionId, event.cliSessionId);

    switch (event.event) {
      case 'SessionStart':
        // A fresh (or resumed) session: facts reset, stale stall irrelevant.
        this.facts.set(sessionId, { turns: 0, toolCounts: new Map(), filesTouched: new Set() });
        this.clearStall(sessionId);
        this.deps.stateDetector.markHookWorking(sessionId);
        break;

      case 'UserPromptSubmit':
        this.getOrCreateFacts(sessionId).turns++;
        this.clearStall(sessionId);
        this.deps.stateDetector.markHookWorking(sessionId);
        break;

      case 'PreToolUse':
        this.clearStall(sessionId);
        this.deps.stateDetector.markHookWorking(sessionId);
        break;

      case 'PostToolUse':
        this.recordToolUse(sessionId, event);
        this.clearStall(sessionId);
        this.advancePlanOnEdit(sessionId, event.toolName);
        break;

      case 'Stop':
        this.deps.stateDetector.markHookTurnEnded(sessionId);
        this.clearStall(sessionId);
        this.deps.flashAttention(sessionId);
        this.settlePlanOnStop(sessionId);
        break;

      case 'StopFailure':
        this.reportStall(sessionId, event);
        break;

      case 'PreCompact':
        // Snapshot BEFORE delivery: peek() must still see the pending note.
        this.composePreCompactSnapshot(event);
        this.deps.handoverDelivery.deliverFromPreCompact(sessionId);
        break;

      default:
        // SessionEnd-style noise and subagent events: observed, not acted on.
        break;
    }
  }

  /**
   * The CLI's own thread id, from any event that carries one. Newest wins —
   * codex /new and /clear start a new thread. Durable (resume depends on it),
   * so it only writes when the id actually changes.
   */
  private recordThreadId(sessionId: string, cliThreadId: string | undefined): void {
    if (!cliThreadId) return;
    if (this.deps.sessionManager.getSession(sessionId)?.cliThreadId === cliThreadId) return;
    this.deps.sessionManager.updateSession(sessionId, { cliThreadId });
  }

  private getOrCreateFacts(sessionId: string): SessionFacts {
    let facts = this.facts.get(sessionId);
    if (!facts) {
      facts = { turns: 0, toolCounts: new Map(), filesTouched: new Set() };
      this.facts.set(sessionId, facts);
    }
    return facts;
  }

  private recordToolUse(sessionId: string, event: HookEvent): void {
    const facts = this.getOrCreateFacts(sessionId);
    if (event.toolName) {
      facts.toolCounts.set(event.toolName, (facts.toolCounts.get(event.toolName) ?? 0) + 1);
    }
    for (const key of FILE_INPUT_KEYS) {
      const value = event.toolInput?.[key];
      if (typeof value === 'string' && value.length > 0) facts.filesTouched.add(value);
    }
  }

  private onSessionRemoved = (event: { sessionId: string }): void => {
    this.facts.delete(event.sessionId);
  };

  // ---------- stall lifecycle --------------------------------------------

  /** Life sign — any of these proves the stall is over. No-op when unset, so
   *  the per-tool-call firehose never causes persistence churn. */
  private clearStall(sessionId: string): void {
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session?.hookStall) return;
    this.deps.sessionManager.updateSession(sessionId, { hookStall: undefined });
    logger.info(`[HookTracker] Stall cleared for session ${sessionId}`);
  }

  /**
   * StopFailure: the turn died on an API error — the usage-limit stall,
   * reported as fact rather than guessed from silence. Deliberately NOT a turn
   * end: the dot must not pretend the agent finished. The record is durable so
   * a stall that happened while you were away survives a restart (invariant 6).
   */
  private reportStall(sessionId: string, event: HookEvent): void {
    const reason = stallReason(event);
    const session = this.deps.sessionManager.getSession(sessionId);
    if (session?.hookStall?.reason === reason) {
      // Same stall re-reported — neither re-persist nor re-flash.
      return;
    }
    const record: StallRecord = { at: this.now(), reason };
    this.deps.sessionManager.updateSession(sessionId, { hookStall: record });
    logger.info(`[HookTracker] Stall reported for session ${sessionId}: ${reason}`);
    this.deps.flashAttention(sessionId);
  }

  // ---------- plan progress ------------------------------------------------

  /** An edit under a claimed plan is work in progress: ready → coding. Uses
   *  the claim-aware lookup — a ready item is not yet "active", so the doing
   *  lookup cannot see the claim this transition exists to create. */
  private advancePlanOnEdit(sessionId: string, toolName?: string): void {
    if (!toolName || !EDIT_TOOL_PATTERN.test(toolName)) return;
    const claimed = this.deps.planManager.claimedItemFor(sessionId);
    if (!claimed || claimed.status === 'coding') return;
    if (this.deps.planManager.setState(claimed.id, 'coding')) {
      logger.info(`[HookTracker] Plan "${claimed.title}" (${claimed.humanId}) → coding (edit via ${toolName})`);
    }
  }

  /** A finished turn under a claimed coding plan is work awaiting review. */
  private settlePlanOnStop(sessionId: string): void {
    const claimed = this.deps.planManager.claimedPlanFor(sessionId);
    if (!claimed || claimed.status !== 'coding') return;
    if (this.deps.planManager.setState(claimed.id, 'review')) {
      logger.info(`[HookTracker] Plan "${claimed.title}" (${claimed.humanId}) → review (turn ended)`);
    }
  }

  // ---------- PreCompact snapshot ------------------------------------------

  private composePreCompactSnapshot(event: HookEvent): void {
    const sessionId = event.helmSessionId!;
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) return;

    const facts = this.getOrCreateFacts(sessionId);
    // The snapshot carries the claim whatever its status — a ready item the
    // session claimed is exactly what post-compaction context needs.
    const claimed = this.deps.planManager.claimedItemFor(sessionId);
    const pendingHandover = this.deps.handoverDelivery.peek(sessionId);

    // The attachment must exist BEFORE the artifact: the manager documents that
    // a pre-minted id lets version 1 be born holding real content.
    const artifactId = randomUUID();
    const transcriptAttached = event.transcriptPath
      ? this.attachTranscript(artifactId, event.transcriptPath, sessionId)
      : false;

    const content = composePreCompactSnapshot({
      sessionName: session.name,
      trigger: event.trigger,
      turns: facts.turns,
      ageMs: session.createdAt !== undefined ? Math.max(0, this.now() - session.createdAt) : undefined,
      plan: claimed ? { title: claimed.title, status: claimed.status } : null,
      toolCounts: [...facts.toolCounts.entries()],
      filesTouched: [...facts.filesTouched],
      drafts: this.deps.draftManager.getForSession(sessionId).map(d => ({ label: d.label, text: d.text })),
      pendingHandover,
      transcriptAttached,
    });

    this.deps.artifactManager.create(sessionId, SNAPSHOT_TITLE, 'markdown', content, undefined, artifactId);
    logger.info(
      `[HookTracker] PreCompact snapshot composed for ${session.name}` +
        ` (trigger: ${event.trigger ?? 'unknown'}, transcript ${transcriptAttached ? 'attached' : 'absent'})`,
    );
  }

  /**
   * Attach the CLI's raw transcript — ATTACHED, never inlined: transcripts are
   * megabytes of mostly tool noise, and inlining would make the one artifact
   * meant to be readable unreadable. Over the cap or unreadable, the summary
   * stands alone and the drop is said out loud (no silent truncation).
   */
  private attachTranscript(artifactId: string, transcriptPath: string, sessionId: string): boolean {
    try {
      if (!existsSync(transcriptPath)) {
        logger.warn(`[HookTracker] Transcript for ${sessionId} not found at ${transcriptPath} — snapshot keeps the summary alone`);
        return false;
      }
      const size = statSync(transcriptPath).size;
      if (size > MAX_ATTACHMENT_BYTES) {
        logger.warn(
          `[HookTracker] Transcript for ${sessionId} is ${size} bytes — over the ${MAX_ATTACHMENT_BYTES}` +
            ` attachment cap; snapshot keeps the summary alone`,
        );
        return false;
      }
      this.deps.artifactAttachments.add(artifactId, {
        filename: 'transcript.jsonl',
        content: readFileSync(transcriptPath),
        contentType: 'text/plain',
      });
      return true;
    } catch (error) {
      logger.warn(`[HookTracker] Could not attach transcript for ${sessionId}: ${String(error)}`);
      return false;
    }
  }
}

/** Read the failure reason defensively — see STALL_REASON_KEYS. */
function stallReason(event: HookEvent): string {
  for (const key of STALL_REASON_KEYS) {
    const value = event.raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'API error (reason not reported)';
}

/** Tools sorted by usage (then name) for the snapshot's "Tools run" line. */
function formatToolCounts(toolCounts: Array<[string, number]>): string {
  if (toolCounts.length === 0) return '`none recorded`';
  const sorted = [...toolCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return sorted.map(([name, count]) => `${name} ×${count}`).join(', ');
}

/** Compact wall-clock duration for the snapshot header. */
function formatAge(ageMs: number | undefined): string {
  if (ageMs === undefined) return '';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return `${Math.floor(ageMs / 1000)}s`;
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/**
 * Render the snapshot markdown. Pure — Helm-held facts in, one readable page
 * out. Empties are stated honestly rather than omitted: a reader must be able
 * to tell "no plan" from "the plan section failed to render".
 */
export function composePreCompactSnapshot(input: PreCompactSnapshotInput): string {
  const age = input.ageMs !== undefined ? `; session age ${formatAge(input.ageMs)}` : '';
  const lines: string[] = [
    `# Compaction snapshot — ${input.sessionName}`,
    '',
    `HELM composed this from its own state at the CLI's PreCompact hook — trigger: **${input.trigger ?? 'unknown'}**.`,
    `The agent's context was about to be discarded, so it could not be asked; nothing here needed agent capacity.`,
    input.transcriptAttached
      ? 'The raw CLI transcript is attached to this artifact as `transcript.jsonl`.'
      : 'No transcript was available to attach (this CLI sends none, or it was unreadable).',
    '',
    '## Claimed plan',
    input.plan
      ? `- **${input.plan.title}** — \`${input.plan.status}\``
      : '- none claimed',
    '',
    '## Work since session start',
    `- ${input.turns} turn(s)${age}`,
    `- Tools run: ${formatToolCounts(input.toolCounts)}`,
    `- Files touched: ${input.filesTouched.length > 0 ? input.filesTouched.sort().map(f => `\`${f}\``).join(', ') : '`none recorded`'}`,
  ];

  if (input.drafts.length > 0) {
    lines.push('', '## Draft memo(s)');
    for (const draft of input.drafts) {
      lines.push(`- **${draft.label}** — ${draft.text}`);
    }
  } else {
    lines.push('', '## Draft memo(s)', '- No draft memo');
  }

  lines.push('', '## Pending handover note', input.pendingHandover ?? '- No pending handover note');
  return lines.join('\n');
}
