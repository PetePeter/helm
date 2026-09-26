/**
 * OperatorSessionManager — keeps exactly one router-only "Helm" session alive
 * (docs/voice-operator.md). Voice clients find it by `role: 'operator'`.
 *
 * ensure() is idempotent and runs on startup and on every operator-settings
 * change. It never kills anything: disabling the setting demotes the operator
 * (role cleared, so clients stop routing to it), as does a surplus duplicate —
 * the session stays open, so no user conversation is ever lost.
 */
import { EventEmitter } from 'node:events';
import type { OperatorConfig } from '../config/loader.js';
import type { SessionInfo } from '../types/session.js';
import type { SessionManager } from './manager.js';
import { buildOperatorGuide } from '../mcp/guides/operator-guide.js';
import { logger } from '../utils/logger.js';

export const OPERATOR_SESSION_NAME = 'Helm';

export interface OperatorSpawnParams {
  cliType: string;
  cwd?: string;
  sessionName: string;
  /** The operator guide, delivered as the initial prompt. */
  contextText: string;
}

export interface OperatorSessionManagerDeps {
  sessionManager: Pick<SessionManager, 'getAllSessions' | 'getSession' | 'updateSession'>;
  getConfig: () => OperatorConfig;
  /** Fresh spawn through the shared configured-session path. */
  spawn: (params: OperatorSpawnParams) => { sessionId: string };
}

export class OperatorSessionManager extends EventEmitter {
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
    if (!config.enabled) {
      for (const op of operators) this.demote(op, 'operator disabled');
      return null;
    }
    if (!config.cliType) return null;

    const [keep, ...surplus] = operators;
    for (const extra of surplus) this.demote(extra, `duplicate; keeping ${keep.id}`);

    const sessionId = keep?.id ?? this.spawn(config);
    this.claim(sessionId);
    this.emit('operator:ensured', sessionId);
    return sessionId;
  }

  private demote(session: SessionInfo, reason: string): void {
    logger.warn(`[Operator] Demoted operator ${session.id} (${reason})`);
    this.deps.sessionManager.updateSession(session.id, { role: undefined });
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
      ...(config.workingDir ? { cwd: config.workingDir } : {}),
      sessionName: OPERATOR_SESSION_NAME,
      contextText: buildOperatorGuide(),
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
