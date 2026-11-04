import { logger } from '../../utils/logger.js';
import { normalizeProjectPath } from '../../session/project-identity.js';
import type { ConfigLoader } from '../../config/loader.js';
import type { PlanManager, PlanRefResolution } from '../../session/plan-manager.js';
import type { SessionManager } from '../../session/manager.js';
import type { PlanStatus } from '../../types/plan.js';
import type { SessionInfo } from '../../types/session.js';

/**
 * Assigns working plans to sessions with cross-directory and ownership validation.
 */
export class HelmSessionPlanService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly planManager: PlanManager,
    private readonly configLoader: ConfigLoader,
  ) {}

  claimPlan(sessionRef: string, planId: string): { ok: true } {
    logger.info(`[MCP:Service] claimPlan session=${sessionRef} plan=${planId}`);
    const session = this.findSession(sessionRef);
    if (!session) {
      throw new Error(`Session not found: ${sessionRef}`);
    }

    const plan = this.resolvePlanRef(planId, 'Plan')?.item;
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }
    if (session.workingDir && normalizeProjectPath(plan.dirPath) !== normalizeProjectPath(session.workingDir)) {
      throw new Error(`Plan ${planId} does not belong to session directory ${session.workingDir}`);
    }
    if (plan.status === 'done' || plan.status === 'planning' || plan.status === 'suggested') {
      throw new Error(`Plan ${planId} is not active or ready`);
    }

    if (plan.status === 'ready') {
      const result = this.planManager.setState(plan.id, 'coding');
      if (!result) throw new Error(`Plan ${planId} could not be set to coding`);
    }

    if (!this.planManager.claimPlan(plan.id, session.id)) {
      throw new Error(`Plan ${planId} is not claimable`);
    }
    this.sessionManager.updateSession(session.id, { currentPlanId: plan.id });
    return { ok: true };
  }

  private findSession(sessionRef: string): SessionInfo | null {
    const nameMatches = this.sessionManager.getAllSessions().filter((session) => session.name === sessionRef);
    if (nameMatches.length > 1) {
      throw new Error(`Multiple sessions found with name: ${sessionRef}. Use sessionId instead.`);
    }
    if (nameMatches.length === 1) return nameMatches[0];
    return this.sessionManager.getSession(sessionRef);
  }

  private resolvePlanRef(ref: string, label: string): Extract<PlanRefResolution, { status: 'found' }> | null {
    const resolution = this.planManager.resolveItemRef(ref);
    if (resolution.status === 'found') return resolution;
    if (resolution.status === 'ambiguous') {
      const matches = resolution.matches
        .map((item) => `${item.humanId ?? item.id} (${item.id}) in ${item.dirPath}`)
        .join(', ');
      throw new Error(`${label} reference is ambiguous: ${ref}. Matching plans: ${matches}`);
    }
    return null;
  }
}
