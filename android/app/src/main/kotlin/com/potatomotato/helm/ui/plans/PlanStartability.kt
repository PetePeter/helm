package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.PlanStatus

/**
 * PlanStartability — which of the board's plans can be started right now.
 *
 * READ OFF THE ROWS the board already has, not asked for. A plan is startable
 * when it is not done and every plan it waits on is finished; the summary rows
 * carry both halves of that — their own status and their `blockedBy` edges — so
 * the answer is already in the reply and a second `filter=startable` round trip
 * would only be asking the desktop to say it again.
 *
 * A BLOCKER THE ANSWER DOES NOT CONTAIN COUNTS AS DONE, and that is the one rule
 * worth stating twice. The board asks for `active` plans, so the finished ones
 * are absent by construction: a plan whose every precursor is missing from the
 * reply is a plan whose every precursor is complete. The alternative reading —
 * absent means unknown means blocked — would mark the entire frontier blocked on
 * every board, which is exactly the failure a reader would notice.
 *
 * EDGES NAME HUMAN IDS (P-00xx), so the lookup is keyed on those, with the UUID
 * accepted too for a row the desktop never minted a P-id for.
 *
 * Pure Kotlin, no Compose and no Android: this is a rule, and rules belong
 * somewhere a JVM test can pin them.
 */
object PlanStartability {

    /** The ids of the plans in [plans] that are on the dependency frontier. */
    fun of(plans: List<HelmPlanSummary>): Set<String> {
        val statusOf = HashMap<String, PlanStatus>(plans.size * 2)
        for (plan in plans) {
            statusOf[plan.id] = plan.status
            plan.humanId?.let { statusOf[it] = plan.status }
        }
        return plans
            .filter { it.status != PlanStatus.Done && it.blockedBy.all { blocker -> isSettled(statusOf, blocker) } }
            .map { it.id }
            .toSet()
    }

    /** A blocker is settled when it is done, or absent from the answer entirely. */
    private fun isSettled(statusOf: Map<String, PlanStatus>, blocker: String): Boolean {
        val status = statusOf[blocker] ?: return true
        return status == PlanStatus.Done
    }
}
