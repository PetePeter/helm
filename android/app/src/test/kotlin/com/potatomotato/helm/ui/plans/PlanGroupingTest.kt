package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.data.PlanStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The plan board's ordering rules, which are the only rules in the grouping.
 *
 * Every assertion here is about what a reader SEES and in what order, because
 * the failure this code prevents is a board that reshuffles between refreshes
 * or quietly loses a plan whose lane went away.
 */
class PlanGroupingTest {

    @Test
    fun `lanes are ordered by the sequence order the desktop gave them`() {
        val buckets = PlanGrouping.group(
            plans = listOf(plan("pa", sequenceId = "a"), plan("pb", sequenceId = "b"), plan("pc", sequenceId = "c")),
            sequences = listOf(sequence("c", order = 2), sequence("a", order = 0), sequence("b", order = 1)),
            startableIds = emptySet(),
        )

        assertEquals(listOf("a", "b", "c"), buckets.map { it.sequence?.id })
    }

    @Test
    fun `lanes sharing an order fall back to title then id`() {
        val buckets = PlanGrouping.group(
            plans = listOf(plan("p1", sequenceId = "s1"), plan("p2", sequenceId = "s2"), plan("p3", sequenceId = "s3")),
            sequences = listOf(
                sequence("s2", order = 1, title = "Same"),
                sequence("s1", order = 1, title = "Same"),
                sequence("s3", order = 1, title = "Earlier"),
            ),
            startableIds = emptySet(),
        )

        // A board that reshuffles between refreshes looks broken even when
        // nothing changed, so ties resolve all the way down to the id.
        assertEquals(listOf("s3", "s1", "s2"), buckets.map { it.sequence?.id })
    }

    @Test
    fun `plans land in their own lane and the ungrouped bucket comes last`() {
        val buckets = PlanGrouping.group(
            plans = listOf(
                plan("p1", sequenceId = "b"),
                plan("p2", sequenceId = "a"),
                plan("p3", sequenceId = null),
            ),
            sequences = listOf(sequence("a", order = 0), sequence("b", order = 1)),
            startableIds = emptySet(),
        )

        assertEquals(listOf("a", "b", null), buckets.map { it.sequence?.id })
        assertEquals(listOf("p2"), buckets[0].plans.map { it.id })
        assertEquals(listOf("p1"), buckets[1].plans.map { it.id })
        assertEquals(listOf("p3"), buckets[2].plans.map { it.id })
    }

    @Test
    fun `a plan naming a lane that is not there is ungrouped, never dropped`() {
        val buckets = PlanGrouping.group(
            plans = listOf(plan("p1", sequenceId = "deleted-lane")),
            sequences = listOf(sequence("a", order = 0)),
            startableIds = emptySet(),
        )

        // Work that vanishes from the board is worse than work in the wrong
        // place: a dangling sequenceId still has to be readable.
        val ungrouped = buckets.last()
        assertNull(ungrouped.sequence)
        assertEquals(listOf("p1"), ungrouped.plans.map { it.id })
    }

    @Test
    fun `a lane with no plans is not drawn at all`() {
        val buckets = PlanGrouping.group(
            plans = listOf(plan("p1", sequenceId = "b")),
            sequences = listOf(sequence("a", order = 0), sequence("b", order = 1)),
            startableIds = emptySet(),
        )

        // The board asks for ACTIVE plans, so a finished lane answers empty. Drawn,
        // those headers are just noise between the reader and the real work.
        assertEquals(listOf("b"), buckets.map { it.sequence?.id })
        assertTrue(buckets.single().plans.isNotEmpty())
    }

    @Test
    fun `when every lane is empty only the ungrouped bucket survives`() {
        val buckets = PlanGrouping.group(
            plans = listOf(plan("p1", sequenceId = null)),
            sequences = listOf(sequence("a", order = 0), sequence("b", order = 1)),
            startableIds = emptySet(),
        )

        assertEquals(1, buckets.size)
        assertNull(buckets.single().sequence)
        assertEquals(listOf("p1"), buckets.single().plans.map { it.id })
    }

    @Test
    fun `lanes with no plans and no ungrouped work is no buckets at all`() {
        assertEquals(
            emptyList<PlanBucket>(),
            PlanGrouping.group(emptyList(), listOf(sequence("a", order = 0)), emptySet()),
        )
    }

    @Test
    fun `startable work sorts to the top of its bucket regardless of status`() {
        val buckets = PlanGrouping.group(
            plans = listOf(
                plan("p1", status = PlanStatus.Planning, stateUpdatedAt = 1),
                plan("p2", status = PlanStatus.Blocked, stateUpdatedAt = 2),
            ),
            sequences = emptyList(),
            startableIds = setOf("p2"),
        )

        // Blocked sorts after planning by status, but the frontier outranks the
        // status: what can be started now is what the reader is looking for.
        assertEquals(listOf("p2", "p1"), buckets.single().plans.map { it.id })
    }

    @Test
    fun `plans that are not startable are ordered by lifecycle status`() {
        val shuffled = listOf(
            plan("p-done", status = PlanStatus.Done),
            plan("p-blocked", status = PlanStatus.Blocked),
            plan("p-review", status = PlanStatus.Review),
            plan("p-coding", status = PlanStatus.Coding),
            plan("p-ready", status = PlanStatus.Ready),
            plan("p-planning", status = PlanStatus.Planning),
        )

        val buckets = PlanGrouping.group(shuffled, emptyList(), emptySet())

        assertEquals(
            listOf("p-planning", "p-ready", "p-coding", "p-review", "p-blocked", "p-done"),
            buckets.single().plans.map { it.id },
        )
    }

    @Test
    fun `a status this build has never met sorts last rather than first`() {
        val buckets = PlanGrouping.group(
            plans = listOf(plan("p-unknown", status = PlanStatus.Unknown), plan("p-done", status = PlanStatus.Done)),
            sequences = emptyList(),
            startableIds = emptySet(),
        )

        assertEquals(listOf("p-done", "p-unknown"), buckets.single().plans.map { it.id })
    }

    @Test
    fun `plans in the same status are ordered oldest first, then by id`() {
        val buckets = PlanGrouping.group(
            plans = listOf(
                plan("p3", stateUpdatedAt = 200),
                plan("p2", stateUpdatedAt = 100),
                plan("p1", stateUpdatedAt = 100),
            ),
            sequences = emptyList(),
            startableIds = emptySet(),
        )

        // Two plans whose state moved in the same millisecond must still land in
        // a stable order, which is what the trailing id comparison is for.
        assertEquals(listOf("p1", "p2", "p3"), buckets.single().plans.map { it.id })
    }

    @Test
    fun `a plan with no timestamp falls back to its human id for age`() {
        val buckets = PlanGrouping.group(
            plans = listOf(
                plan("late", humanId = "P-0009"),
                plan("early", humanId = "P-0002"),
            ),
            sequences = emptyList(),
            startableIds = emptySet(),
        )

        // The summary answer carries no createdAt, so age is stateUpdatedAt when
        // there is one and the minted-in-order P-00xx id when there is not.
        assertEquals(listOf("early", "late"), buckets.single().plans.map { it.id })
    }

    @Test
    fun `nothing to group is no buckets at all`() {
        assertEquals(emptyList<PlanBucket>(), PlanGrouping.group(emptyList(), emptyList(), emptySet()))
    }

    @Test
    fun `all-ungrouped plans with no lanes are one bucket`() {
        val buckets = PlanGrouping.group(
            plans = listOf(plan("p1"), plan("p2")),
            sequences = emptyList(),
            startableIds = emptySet(),
        )

        assertEquals(1, buckets.size)
        assertNull(buckets.single().sequence)
        assertEquals(listOf("p1", "p2"), buckets.single().plans.map { it.id })
    }

    private fun plan(
        id: String,
        sequenceId: String? = null,
        status: PlanStatus = PlanStatus.Planning,
        stateUpdatedAt: Long? = null,
        humanId: String? = null,
    ): HelmPlanSummary = HelmPlanSummary(
        id = id,
        humanId = humanId,
        title = id,
        type = null,
        status = status,
        stateUpdatedAtEpochMs = stateUpdatedAt,
        sequenceId = sequenceId,
        blockedBy = emptyList(),
        blocks = emptyList(),
    )

    private fun sequence(id: String, order: Int, title: String = id): HelmPlanSequence =
        HelmPlanSequence(
            id = id,
            projectId = null,
            dirPath = "/work",
            title = title,
            missionStatement = "",
            sharedMemory = "",
            order = order,
        )
}
