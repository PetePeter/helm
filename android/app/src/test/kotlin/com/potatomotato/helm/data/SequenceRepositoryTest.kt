package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The repository behind the plan board's lanes.
 *
 * `sequence_list` answers a JSON ARRAY of stored sequences PLUS the member ids
 * the desktop's service computes per answer (`memberPlanIds`, `memberHumanIds`),
 * and `sequence_get` answers one of the same shape. The member ids are additive,
 * so an answer without them is as valid as one with them.
 */
class SequenceRepositoryTest {

    private val repo = SequenceRepository()

    @Test
    fun `a lane list lands with the member ids the desktop computed`() {
        repo.listRequested("/work")

        assertTrue(repo.listArrived("/work", parse(listJson())))

        val ready = repo.list.value as SequenceList.Ready
        assertEquals(listOf("seq1", "seq2"), ready.sequences.map { it.id })
        val first = ready.sequences.first()
        assertEquals("Mobile transport", first.title)
        assertEquals("Get the phone talking", first.missionStatement)
        assertEquals("legacy notes", first.sharedMemory)
        assertEquals(2, first.order)
        assertEquals(listOf("c1"), first.contextIds)
        assertEquals(listOf("p1", "p2"), first.memberPlanIds)
        assertEquals(listOf("P-0007", "P-0008"), first.memberHumanIds)
    }

    @Test
    fun `a lane answered without member ids is still a lane`() {
        repo.listArrived("/work", parse("""[{"id":"seq1","dirPath":"/work","title":"Lane"}]"""))

        val lane = (repo.list.value as SequenceList.Ready).sequences.single()
        assertEquals(emptyList<String>(), lane.memberPlanIds)
        assertEquals(emptyList<String>(), lane.contextIds)
        // An absent order is 0, which is the desktop's own default.
        assertEquals(0, lane.order)
    }

    @Test
    fun `a re-visit shows the cached lanes and a failure never evicts them`() {
        repo.listArrived("/work", parse(listJson()))

        repo.listFailed("/work", "Tool not permitted")
        assertEquals("Tool not permitted", (repo.list.value as SequenceList.Failed).message)

        repo.listRequested("/work")
        assertEquals(listOf("seq1", "seq2"), (repo.list.value as SequenceList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `an answer for a superseded directory is dropped, not applied`() {
        repo.listRequested("/other")

        repo.listArrived("/work", parse(listJson()))

        assertEquals(SequenceList.Loading("/other"), repo.list.value)
    }

    @Test
    fun `two directories are cached independently`() {
        repo.listArrived("/work", parse(listJson()))
        repo.listRequested("/side")
        repo.listArrived("/side", parse("""[{"id":"seq9","dirPath":"/side","title":"Side lane"}]"""))

        assertEquals(listOf("seq1", "seq2"), repo.cachedSequences("/work").map { it.id })
        assertEquals(listOf("seq9"), repo.cachedSequences("/side").map { it.id })
    }

    @Test
    fun `a list answer that is not an array leaves the previous lanes standing`() {
        repo.listArrived("/work", parse(listJson()))

        assertFalse(repo.listArrived("/work", parse("""{"items":[]}""")))

        assertEquals(listOf("seq1", "seq2"), (repo.list.value as SequenceList.Ready).sequences.map { it.id })
    }

    @Test
    fun `a lane the fresh answer omits leaves the detail cache`() {
        repo.detailArrived("seq1", parse("""{"id":"seq1","dirPath":"/work","title":"Lane"}"""))

        repo.listArrived("/work", parse("""[{"id":"seq2","dirPath":"/work","title":"Other"}]"""))

        repo.detailRequested("seq1")
        assertEquals(SequenceDetail.Loading("seq1"), repo.detail.value)
    }

    @Test
    fun `a sequence_get answer lands as the lane it named`() {
        repo.detailRequested("seq1")

        assertTrue(
            repo.detailArrived(
                "seq1",
                parse(
                    """{"id":"seq1","projectId":"proj1","dirPath":"/work","title":"Mobile transport",""" +
                        """"missionStatement":"Get the phone talking","sharedMemory":"legacy notes","order":2,""" +
                        """"memberPlanIds":["p1"],"createdAt":10,"updatedAt":20}""",
                ),
            ),
        )

        val lane = (repo.detail.value as SequenceDetail.Ready).sequence
        assertEquals("proj1", lane.projectId)
        assertEquals(listOf("p1"), lane.memberPlanIds)
        assertEquals(20L, lane.updatedAtEpochMs)
    }

    @Test
    fun `a late answer for another lane never lands on this one`() {
        repo.detailRequested("seq2")

        repo.detailArrived("seq1", parse("""{"id":"seq1","dirPath":"/work","title":"Lane"}"""))

        assertEquals(SequenceDetail.Loading("seq2"), repo.detail.value)
    }

    @Test
    fun `a sequence_get answer that is not a lane says so instead of loading forever`() {
        repo.detailRequested("seq1")

        assertFalse(repo.detailArrived("seq1", parse("""{"items":[]}""")))
        assertEquals(SequenceDetail.Loading("seq1"), repo.detail.value)

        repo.detailFailed("seq1", "Sequence not found: seq1")
        assertEquals("Sequence not found: seq1", (repo.detail.value as SequenceDetail.Failed).message)
    }

    /**
     * REGRESSION — see [PlanRepositoryTest]. The guard read the ask off the
     * current state, and a settled Ready carries none, so the superseded
     * directory's late answer was applied and wedged the live surface.
     */
    @Test
    fun `a lane answer for a superseded directory never lands after the newer one settled`() {
        repo.listRequested("/a")
        repo.listRequested("/b")

        repo.listArrived("/b", parse("""[{"id":"sb","dirPath":"/b","title":"B lane"}]"""))
        repo.listArrived("/a", parse("""[{"id":"sa","dirPath":"/a","title":"A lane"}]"""))

        val ready = repo.list.value as SequenceList.Ready
        assertEquals("/b", ready.dirPath)
        assertEquals(listOf("sb"), ready.sequences.map { it.id })
    }

    @Test
    fun `a lane detail for a superseded lane never lands after the newer one settled`() {
        repo.detailRequested("seq1")
        repo.detailRequested("seq2")

        repo.detailArrived("seq2", parse("""{"id":"seq2","dirPath":"/work","title":"Second"}"""))
        repo.detailArrived("seq1", parse("""{"id":"seq1","dirPath":"/work","title":"First"}"""))

        assertEquals("seq2", (repo.detail.value as SequenceDetail.Ready).sequence.id)
    }

    /** The wire's answer as the envelope delivers it: PARSED, not text. */
    private fun parse(json: String): Any = org.json.JSONTokener(json).nextValue()

    private fun listJson(): String =
        """[{"id":"seq1","projectId":"proj1","dirPath":"/work","title":"Mobile transport",""" +
            """"missionStatement":"Get the phone talking","sharedMemory":"legacy notes","order":2,""" +
            """"contextIds":["c1"],"memberPlanIds":["p1","p2"],"memberHumanIds":["P-0007","P-0008"],""" +
            """"createdAt":10,"updatedAt":20},""" +
            """{"id":"seq2","dirPath":"/work","title":"Cleanup","missionStatement":"","sharedMemory":"",""" +
            """"order":3,"memberPlanIds":[],"memberHumanIds":[],"createdAt":11,"updatedAt":21}]"""
}
