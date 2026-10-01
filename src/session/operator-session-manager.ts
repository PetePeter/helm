/**
 * OperatorSessionManager — keeps exactly one router-only "Helm" session alive
 * (docs/voice-operator.md). Voice clients find it by `role: 'operator'`.
 *
 * ensure() is idempotent and runs on startup and on every operator-settings
 * change. It never kills anything: disabling the setting demotes the operator
 * (role cleared, so clients stop routing to it), as does a surplus duplicate —
 * the session stays open, so no user conversation is ever lost. Changing the
 * operator's CLI type demotes the old operator and spawns one on the new type.
 *
 * It also self-clears the operator every `compactEveryMinutes`, but only when
 * something happened since the last clear AND the operator is idle now;
 * busy → retry every 30 min. A clear, not a compaction: a summary would carry
 * finished goals forward forever, so the operator restarts from its guide alone
 * (rule updates apply after every clear). Handover summaries are for sessions
 * whose context fills up, never for this idle tick.
 */
import { normalizeProjectPath } from './project-identity.js';
import { EventEmitter } from 'node:events';
import type { OperatorConfig } from '../config/loader.js';
import type { SessionInfo } from '../types/session.js';
import type { SessionManager } from './manager.js';
import type { SessionMessageFlight } from './message-flight.js';
import { buildOperatorGuide } from '../mcp/guides/operator-guide.js';
import { logger } from '../utils/logger.js';

export const OPERATOR_SESSION_NAME = 'Helm';

const MINUTE_MS = 60_000;
/** Busy-retry cadence (user-specified). Also the settle delay after a clear. */
export const OPERATOR_COMPACT_RETRY_MS = 30 * MINUTE_MS;
/** A relay whose reply never came stops blocking the self-clear after this long. */
const OPEN_RELAY_MAX_AGE_MS = 2 * 60 * MINUTE_MS;

export function buildOperatorClearContext(rules = ''): string {
  return 'Your context was just cleared. You are Helm, the operator. Any earlier relays are closed; treat late replies as new requests. '
    + 'Re-read your rules below and follow them from now on.\n\n' + buildOperatorGuide(rules);
}

export interface OperatorSpawnParams {
  cliType: string;
  cwd?: string;
  sessionName: string;
  /** The operator guide, delivered as the initial prompt. */
  contextText: string;
  /** Always 'operator': the session is born with its role so no list ever shows it as a plain row. */
  role: 'operator';
  locked: true;
}

export interface OperatorSessionManagerDeps {
  sessionManager: Pick<SessionManager, 'getAllSessions' | 'getSession' | 'updateSession'>;
  getConfig: () => OperatorConfig;
  /** Fresh spawn through the shared configured-session path. */
  spawn: (params: OperatorSpawnParams) => { sessionId: string };
  /** The shared session_clear path (arms the context delivery, writes the clear sequence). */
  clear: (sessionId: string, context: string) => Promise<unknown>;
  isHandoverPending: (sessionId: string) => boolean;
  /**
   * The operator's own home (ensureOperatorHome). It ALWAYS lives there: its
   * memories and task plans belong to its own project, never to a repo's.
   */
  homeDir: () => string;
}

export class OperatorSessionManager extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerIntervalMs = 0;
  /** Bumped on every timer reset, so a tick whose self-clear outlived a dispose/disable/interval change does not reschedule. */
  private timerGeneration = 0;
  /** lastOutputAt already accounted for; in memory, so a restart counts old activity once. */
  private activityBaseline = 0;
  /** Set by a self-clear: the next idle observation rebaselines past its own echo. */
  private settling = false;
  /** recipientSessionId → sentAt, for operator sends that expect a reply. */
  private readonly openRelays = new Map<string, number>();

  constructor(private readonly deps: OperatorSessionManagerDeps) {
    super();
  }

  /**
   * Make sure one operator exists. Returns its session id, or null when the
   * feature is off or no CLI type is chosen. An existing operator is reused —
   * a restored one is resumed by the normal cliSessionName chain.
   */
  ensure(): string | null {
    const config = this.deps.getConfig();
    const operators = this.findOperators();
    this.syncClearTimer(config);
    if (!config.enabled) {
      for (const op of operators) this.demote(op, 'operator disabled');
      return null;
    }
    if (!config.cliType) return null;

    // An operator on a CLI type other than the chosen one is replaced: the
    // setting changed, and resuming the old CLI would silently ignore it.
    // Likewise one living outside its home (an older build let a setting move
    // it): its tasks and memories would land in that directory's project.
    const home = normalizeProjectPath(this.deps.homeDir());
    // No recorded dir counts as outside too: it would resume in the CLI's default.
    const outsideHome = (op: SessionInfo) => !op.workingDir || normalizeProjectPath(op.workingDir) !== home;
    const current = operators.filter(op => op.cliType === config.cliType && !outsideHome(op));
    for (const stale of operators) {
      if (stale.cliType !== config.cliType) this.demote(stale, `CLI type changed to ${config.cliType}`);
      else if (outsideHome(stale)) this.demote(stale, `outside its home ${home}`);
    }
    const [keep, ...surplus] = current;
    for (const extra of surplus) this.demote(extra, `duplicate; keeping ${keep.id}`);

    const sessionId = keep?.id ?? this.spawn(config);
    this.claim(sessionId);
    this.emit('operator:ensured', sessionId);
    return sessionId;
  }

  /** The live operator's session id, or null. Read-only: never spawns or claims. */
  getOperatorId(): string | null {
    return this.findOperators()[0]?.id ?? null;
  }

  /** Track operator relays: a send expecting a reply opens one, the recipient's next message closes it. */
  noteFlight(flight: SessionMessageFlight): void {
    const operatorId = this.getOperatorId();
    if (!operatorId) return;
    if (flight.senderSessionId === operatorId && flight.expectsResponse) {
      this.openRelays.set(flight.recipientSessionId, Date.now());
    } else if (flight.recipientSessionId === operatorId) {
      this.openRelays.delete(flight.senderSessionId);
    }
  }

  dispose(): void {
    this.clearTimer();
  }

  private syncClearTimer(config: OperatorConfig): void {
    const intervalMs = config.enabled ? config.compactEveryMinutes * MINUTE_MS : 0;
    if (intervalMs === this.timerIntervalMs && (this.timer !== null) === (intervalMs > 0)) return;
    this.clearTimer();
    this.timerIntervalMs = intervalMs;
    if (intervalMs > 0) this.schedule(intervalMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerIntervalMs = 0;
    this.timerGeneration++;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => { void this.tick(); }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const generation = this.timerGeneration;
    const delayMs = await this.checkSelfClear();
    if (generation !== this.timerGeneration || this.timerIntervalMs <= 0 || delayMs <= 0) return;
    this.schedule(delayMs);
  }

  /** One self-clear check; returns the delay until the next. */
  private async checkSelfClear(): Promise<number> {
    const id = this.getOperatorId();
    const session = id ? this.deps.sessionManager.getSession(id) : undefined;
    if (!id || !session) return this.timerIntervalMs;
    if (this.isBusy(session)) return OPERATOR_COMPACT_RETRY_MS;
    const lastOutputAt = session.lastOutputAt ?? 0;
    if (this.settling) {
      this.settling = false;
      this.activityBaseline = lastOutputAt;
      return this.timerIntervalMs;
    }
    if (lastOutputAt <= this.activityBaseline) return this.timerIntervalMs;
    try {
      await this.deps.clear(id, buildOperatorClearContext(this.deps.getConfig().rules));
      this.settling = true;
      logger.info(`[Operator] Cleared operator ${id}`);
    } catch (error) {
      logger.warn(`[Operator] Self-clear of ${id} failed: ${error}`);
    }
    return OPERATOR_COMPACT_RETRY_MS;
  }

  private isBusy(session: SessionInfo): boolean {
    const now = Date.now();
    for (const [recipient, sentAt] of this.openRelays) {
      if (now - sentAt > OPEN_RELAY_MAX_AGE_MS) this.openRelays.delete(recipient);
    }
    return session.activityLevel === 'active'
      || session.aiagentState === 'implementing'
      || this.deps.isHandoverPending(session.id)
      || this.openRelays.size > 0;
  }

  private demote(session: SessionInfo, reason: string): void {
    logger.warn(`[Operator] Demoted operator ${session.id} (${reason})`);
    // Unlocked too, so the user can close the old conversation when done with it.
    this.deps.sessionManager.updateSession(session.id, { role: undefined, locked: false });
  }

  /** Oldest first, so the longest-lived conversation wins a duplicate. */
  private findOperators(): SessionInfo[] {
    return this.deps.sessionManager.getAllSessions()
      .filter(s => s.role === 'operator')
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  private spawn(config: OperatorConfig): string {
    const { sessionId } = this.deps.spawn({
      cliType: config.cliType,
      cwd: this.deps.homeDir(),
      sessionName: OPERATOR_SESSION_NAME,
      contextText: buildOperatorGuide(config.rules),
      role: 'operator',
      locked: true,
    });
    logger.info(`[Operator] Spawned operator session ${sessionId}`);
    return sessionId;
  }

  /** Role, lock and name are re-asserted every time — a rename or unlock does not stick. */
  private claim(sessionId: string): void {
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) return;
    if (session.role === 'operator' && session.locked && session.name === OPERATOR_SESSION_NAME) return;
    this.deps.sessionManager.updateSession(sessionId, { role: 'operator', locked: true, name: OPERATOR_SESSION_NAME });
  }
}
