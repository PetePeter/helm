package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.PlanStatus
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The frontier the board marks, read off the rows instead of asked for.
 *
 * This replaced a whole `filter=startable` round trip, so what is pinned here is
 * the reading that made that possible: a blocker missing from an `active` answer
 * is a blocker that is DONE. Get that backwards and every plan on every board
 * reads as blocked.
 */
class PlanStartabilityTest {

    @Test
    fun `a plan with no blockers is startable`() {
        assertEquals(setOf("p1"), PlanStartability.of(listOf(plan("p1"))))
    }

    @Test
    fun `a plan whose blocker is absent from the answer is startable`() {
        // The board asks for active plans, so a finished precursor is not in the
        // reply at all. Absent means done; reading it as "unknown, so blocked"
        // would mark the entire frontier blocked.
        val rows = listOf(plan("p2", humanId = "P-0002", blockedBy = listOf("P-0001")))

        assertEquals(setOf("p2"), PlanStartability.of(rows))
    }

    @Test
    fun `a plan blocked by a live plan in the answer is not startable`() {
        val rows = listOf(
            plan("p1", humanId = "P-0001", status = PlanStatus.Coding),
            plan("p2", humanId = "P-0002", blockedBy = listOf("P-0001")),
        )

        assertEquals(setOf("p1"), PlanStartability.of(rows))
    }

    @Test
    fun `a plan blocked only by done work is startable`() {
        // The 'all' filter keeps done rows, so the status is there to be read.
        val rows = listOf(
            plan("p1", humanId = "P-0001", status = PlanStatus.Done),
            plan("p2", humanId = "P-0002", blockedBy = listOf("P-0001")),
        )

        assertEquals(setOf("p2"), PlanStartability.of(rows))
    }

    @Test
    fun `one live blocker among done ones is enough to block`() {
        val rows = listOf(
            plan("p1", humanId = "P-0001", status = PlanStatus.Done),
            plan("p2", humanId = "P-0002", status = PlanStatus.Review),
            plan("p3", humanId = "P-0003", blockedBy = listOf("P-0001", "P-0002")),
        )

        assertEquals(setOf("p2"), PlanStartability.of(rows))
    }

    @Test
    fun `a done plan is never startable`() {
        assertEquals(emptySet<String>(), PlanStartability.of(listOf(plan("p1", status = PlanStatus.Done))))
    }

    @Test
    fun `an edge naming a uuid resolves too, for a plan with no P-id yet`() {
        // The desktop mints humanId for every summary row, but an edge that
        // could not be resolved falls back to the UUID — which must still match.
        val rows = listOf(
            plan("uuid-1", humanId = null, status = PlanStatus.Coding),
            plan("p2", humanId = "P-0002", blockedBy = listOf("uuid-1")),
        )

        assertEquals(setOf("uuid-1"), PlanStartability.of(rows))
    }

    private fun plan(
        id: String,
        humanId: String? = null,
        status: PlanStatus = PlanStatus.Planning,
        blockedBy: List<String> = emptyList(),
    ): HelmPlanSummary = HelmPlanSummary(
        id = id,
        humanId = humanId,
        title = id,
        type = null,
        status = status,
        stateUpdatedAtEpochMs = null,
        sequenceId = null,
        blockedBy = blockedBy,
        blocks = emptyList(),
    )
}
