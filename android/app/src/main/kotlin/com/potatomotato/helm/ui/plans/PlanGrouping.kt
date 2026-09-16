package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.PlanStatus

/**
 * One display bucket of the plan board: a sequence lane, or the ungrouped tail.
 *
 * [sequence] is null for exactly one bucket — the last — which holds the plans
 * that belong to no lane. A null sequence rather than a sentinel lane because
 * the ungrouped bucket is not a lane the desktop has: it has no id, no mission
 * and no order, and pretending otherwise would let a caller try to open it.
 */
data class PlanBucket(
    val sequence: HelmPlanSequence?,
    val plans: List<HelmPlanSummary>,
)

/**
 * PlanGrouping — how a flat plan list becomes the ordered buckets a board draws.
 *
 * PURE KOTLIN, no Compose and no Android: the ordering is the part with rules in
 * it, and rules belong somewhere a JVM test can pin them. The composable that
 * eventually draws this calls [group] and renders what it gets back.
 *
 * STARTABILITY IS AN INPUT, never a computation here: `PlanStartability` reads
 * it off the rows' edges and this function only ORDERS by the ids it produces.
 * Two jobs, two files, one test each.
 *
 * COLLAPSE IS NOT HERE EITHER. Which lanes are folded shut is a fact about this
 * phone's screen right now; grouping is a fact about the data. The board folds
 * what it draws, from state it owns.
 *
 * EVERY comparison ends in the plan or sequence id. Two plans a lane lists
 * together, or two lanes the user gave the same order and title, must still land
 * in a stable order — a board that reshuffles between refreshes looks broken
 * even when nothing changed.
 */
object PlanGrouping {

    /** Within a lane, the lifecycle order a reader scans top-down. */
    private val STATUS_ORDER = listOf(
        PlanStatus.Planning,
        PlanStatus.Ready,
        PlanStatus.Coding,
        PlanStatus.Review,
        PlanStatus.Blocked,
        PlanStatus.Done,
        // A status this build has never met sorts last rather than first: an
        // unknown thing belongs at the bottom of a list, not the top of it.
        PlanStatus.Unknown,
    )

    /**
     * Bucket [plans] by their sequence.
     *
     * One bucket per entry of [sequences] THAT HAS PLANS, ordered by `order` then
     * title then id, followed — on the same condition — by the ungrouped bucket.
     *
     * AN EMPTY LANE IS NOISE, not information. The board asks for active plans, so
     * a project whose older lanes are finished answers with lanes that are all
     * empty; drawn, they were five headers reading "0" between the reader and the
     * work, on a screen that has room for about that many rows. A lane with
     * nothing in it says nothing the reader needs here, and the desktop remains
     * the place lanes are managed.
     *
     * A plan whose `sequenceId` names a lane that is not in [sequences] is
     * UNGROUPED, not dropped: a dangling id — or a lane answer that has not
     * landed yet — is a plan the reader still has to be able to see, and the
     * alternative is work that vanishes from the board.
     *
     * [startableIds] is the dependency frontier [PlanStartability] read off these
     * same rows. Plans in it sort first
     * within their bucket; an empty set simply means nothing is marked, which
     * leaves the status order in charge.
     */
    fun group(
        plans: List<HelmPlanSummary>,
        sequences: List<HelmPlanSequence>,
        startableIds: Set<String>,
    ): List<PlanBucket> {
        val lanes = sequences.sortedWith(laneOrder())
        val laneIds = lanes.map { it.id }.toSet()
        val byLane = plans.groupBy { plan ->
            plan.sequenceId?.takeIf { it in laneIds }
        }
        val laneBuckets = lanes.mapNotNull { lane ->
            val members = byLane[lane.id].orEmpty()
            if (members.isEmpty()) null
            else PlanBucket(lane, members.sortedWith(planOrder(startableIds)))
        }
        val ungrouped = byLane[null].orEmpty()
        if (ungrouped.isEmpty()) return laneBuckets
        return laneBuckets + PlanBucket(null, ungrouped.sortedWith(planOrder(startableIds)))
    }

    /**
     * The lane order, shared rather than restated.
     *
     * Internal because the standalone lane list needs the SAME order the board's
     * buckets are in. Two surfaces disagreeing about which lane comes first is
     * the same data read two ways, and a comparator copied into a second file is
     * a promise kept in prose instead of in code.
     */
    internal fun laneOrder(): Comparator<HelmPlanSequence> =
        compareBy({ it.order }, { it.title }, { it.id })

    /**
     * Within a bucket: the frontier, then lifecycle status, then age, then id.
     *
     * AGE IS A SUBSTITUTE, documented because it is one. The summary rows carry
     * no `createdAt` — the board reads `plan_summary`, which leaves it out — so
     * age is `stateUpdatedAt` when the plan has one, and the HUMAN ID when it
     * does not: P-00xx ids are minted in creation order and zero-padded to four
     * digits, so comparing them as strings is oldest-first (past P-9999 it
     * degrades to stable-but-arbitrary, which is still deterministic, the
     * property that actually matters). A row with neither falls back to its
     * UUID, and the trailing id keeps even that from being a tie.
     *
     * A plan that has never changed state sorts BEFORE one that has, because an
     * absent timestamp reads as the beginning of time rather than the end of it.
     */
    private fun planOrder(startableIds: Set<String>): Comparator<HelmPlanSummary> =
        compareBy(
            // false sorts before true, so negate: startable work goes to the top.
            { it.id !in startableIds },
            { STATUS_ORDER.indexOf(it.status) },
            { it.stateUpdatedAtEpochMs ?: 0L },
            { it.humanId ?: it.id },
            { it.id },
        )
}
