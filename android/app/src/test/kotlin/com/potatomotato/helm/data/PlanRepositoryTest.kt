package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The repository behind the plan board and the plan detail screen.
 *
 * The shapes asserted here are the desktop's own tool results delivered raw over
 * the phone's `dispatchForPeer` path: `plan_summary` answers a JSON ARRAY of
 * compact board rows (no descriptions — that is the whole point of it),
 * `plan_get` answers ONE plan in full, and `plan_context_list` answers an array
 * of `{id, type, source}` refs.
 *
 * The scope keying is the point of most of these: two plan surfaces can be live
 * at once — a top-level board and an in-session view of one directory — and an
 * answer for the wrong one must never land under the other's name.
 */
class PlanRepositoryTest {

    private val repo = PlanRepository()

    @Test
    fun `a first ask waits and the answer lands as rows`() {
        repo.listRequested("/work")
        assertEquals(PlanList.Loading("/work"), repo.list.value)

        assertTrue(repo.listArrived("/work", parse(listJson())))

        val ready = repo.list.value as PlanList.Ready
        assertEquals(listOf("p1", "p2"), ready.plans.map { it.id })
        assertEquals("P-0007", ready.plans.first().humanId)
        assertEquals(PlanStatus.Coding, ready.plans.first().status)
        // The edges name their far end in P-00xx form, resolved by the desktop
        // against the FULL item set — so an edge to a plan the filter excluded
        // is still readable.
        assertEquals(listOf("P-0006"), ready.plans.first().blockedBy)
        assertEquals(listOf("P-0008"), ready.plans.first().blocks)
        // The lane rides the summary because the board has no other source for
        // it — the full records are the very thing it must not ask for.
        assertEquals("seq1", ready.plans.first().sequenceId)
        // The claim: who is working it, by name, so the row can say so.
        assertEquals("s3", ready.plans.first().sessionId)
        assertEquals("helm-claude", ready.plans.first().sessionName)
        assertEquals(null, ready.plans[1].sessionId)
    }

    @Test
    fun `a status this build has never met is carried as unknown, not refused`() {
        repo.listArrived("/work", parse("""[{"id":"p1","title":"X","status":"triaging"},{"id":"p2","title":"Y"}]"""))

        val plans = (repo.list.value as PlanList.Ready).plans
        // Both the unrecognised string and an absent one read as Unknown — and
        // neither costs the reader the other plan.
        assertEquals(listOf(PlanStatus.Unknown, PlanStatus.Unknown), plans.map { it.status })
    }

    @Test
    fun `an optional field the desktop omitted stays absent rather than invented`() {
        repo.listArrived("/work", parse("""[{"id":"p1","title":"X","status":"ready"}]"""))

        val plan = (repo.list.value as PlanList.Ready).plans.single()
        assertEquals(null, plan.humanId)
        assertEquals(null, plan.sequenceId)
        assertEquals(null, plan.type)
        assertEquals(null, plan.stateUpdatedAtEpochMs)
        // An absent edge list is no edges, not an unreadable row.
        assertEquals(emptyList<String>(), plan.blockedBy)
        assertEquals(emptyList<String>(), plan.blocks)
    }

    @Test
    fun `a row without an id is dropped, not invented`() {
        repo.listArrived("/work", parse("""[{"id":"p1","title":"X"},{"title":"no id"}]"""))

        assertEquals(listOf("p1"), (repo.list.value as PlanList.Ready).plans.map { it.id })
    }

    @Test
    fun `a re-visit shows the cached rows while they refresh`() {
        repo.listArrived("/work", parse(listJson()))

        repo.listRequested("/work")

        val refreshing = repo.list.value as PlanList.Refreshing
        assertEquals(listOf("p1", "p2"), refreshing.cached.map { it.id })
    }

    @Test
    fun `a failure is state the screen can read and never evicts the cache`() {
        repo.listArrived("/work", parse(listJson()))

        repo.listFailed("/work", "Tool not permitted")
        assertEquals("Tool not permitted", (repo.list.value as PlanList.Failed).message)

        repo.listRequested("/work")
        assertEquals(listOf("p1", "p2"), (repo.list.value as PlanList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `a list answer that is not an array leaves the previous rows standing`() {
        repo.listArrived("/work", parse(listJson()))

        assertFalse(repo.listArrived("/work", parse("""{"items":[]}""")))

        assertEquals(listOf("p1", "p2"), (repo.list.value as PlanList.Ready).plans.map { it.id })
    }

    @Test
    fun `an answer for a superseded directory is dropped, not applied`() {
        repo.listRequested("/other")

        repo.listArrived("/work", parse(listJson()))

        // The user moved to /other; a late /work answer must not be shown under
        // /other's name. The screen keeps waiting for the scope it asked for.
        assertEquals(PlanList.Loading("/other"), repo.list.value)
    }

    @Test
    fun `two directories are cached independently`() {
        repo.listArrived("/work", parse(listJson()))
        repo.listRequested("/side")
        repo.listArrived("/side", parse("""[{"id":"p9","title":"Side"}]"""))

        assertEquals(listOf("p1", "p2"), repo.cachedPlans("/work").map { it.id })
        assertEquals(listOf("p9"), repo.cachedPlans("/side").map { it.id })

        // And one scope's answer never purges the other's.
        repo.listRequested("/work")
        assertEquals(listOf("p1", "p2"), (repo.list.value as PlanList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `a plan the fresh answer omits leaves the detail cache`() {
        // The board listed p1, the reader opened it, and its refs came with it —
        // which is the only way a detail cache entry comes to exist.
        repo.listArrived("/work", parse("""[{"id":"p1","title":"X"},{"id":"p2","title":"Y"}]"""))
        repo.detailArrived("p1", parse("""{"id":"p1","title":"X","dirPath":"/work"}"""))
        repo.contextRefsArrived("p1", parse("""[{"id":"c1","type":"Coding","source":"plan"}]"""))

        // The desktop no longer lists p1 for /work: it is gone.
        repo.listArrived("/work", parse("""[{"id":"p2","title":"Y"}]"""))

        repo.detailRequested("p1")
        assertEquals(PlanDetail.Loading("p1"), repo.detail.value)
        repo.contextRefsRequested("p1")
        assertEquals(PlanContextRefs.Loading("p1"), repo.contextRefs.value)
    }

    // ------------------------------------------------------------------- detail

    @Test
    fun `a plan_get answer lands as the plan it named`() {
        repo.detailRequested("p1")

        assertTrue(repo.detailArrived("p1", parse(detailJson())))

        val plan = (repo.detail.value as PlanDetail.Ready).plan
        assertEquals("P-0007", plan.humanId)
        assertEquals("Wire the board", plan.title)
        assertEquals("Do the thing.", plan.description)
        assertEquals(PlanStatus.Review, plan.status)
        assertEquals("waiting on review", plan.stateInfo)
        assertEquals(true, plan.autoImplement)
        assertEquals("s3", plan.sessionId)
        assertEquals(1_700L, plan.stateUpdatedAtEpochMs)
    }

    @Test
    fun `a re-open of a plan already read shows the cache while it refreshes`() {
        repo.detailArrived("p1", parse(detailJson()))

        repo.detailRequested("p1")

        assertEquals("Wire the board", (repo.detail.value as PlanDetail.Refreshing).cached.title)
    }

    @Test
    fun `a late answer for another plan never lands on this one`() {
        repo.detailRequested("p2")

        repo.detailArrived("p1", parse(detailJson()))

        assertEquals(PlanDetail.Loading("p2"), repo.detail.value)
    }

    @Test
    fun `a plan_get answer that is not a plan says so instead of loading forever`() {
        repo.detailRequested("p1")

        assertFalse(repo.detailArrived("p1", parse("""{"items":[]}""")))
        assertEquals(PlanDetail.Loading("p1"), repo.detail.value)

        repo.detailFailed("p1", "Plan not found: p1")
        assertEquals("Plan not found: p1", (repo.detail.value as PlanDetail.Failed).message)
    }

    // ------------------------------------------------------------ context refs

    @Test
    fun `plan context refs land with the source that explains where each came from`() {
        repo.contextRefsRequested("p1")

        assertTrue(
            repo.contextRefsArrived(
                "p1",
                parse("""[{"id":"c1","type":"Coding","source":"plan"},{"id":"c2","type":"Testing","source":"both"}]"""),
            ),
        )

        val refs = (repo.contextRefs.value as PlanContextRefs.Ready).refs
        assertEquals(
            listOf(
                HelmPlanContextRef("c1", "Coding", "plan"),
                HelmPlanContextRef("c2", "Testing", "both"),
            ),
            refs,
        )
    }

    @Test
    fun `a refs answer for a superseded plan is dropped`() {
        repo.contextRefsRequested("p2")

        repo.contextRefsArrived("p1", parse("""[{"id":"c1","type":"Coding","source":"plan"}]"""))

        assertEquals(PlanContextRefs.Loading("p2"), repo.contextRefs.value)
    }

    @Test
    fun `a refs failure is state the screen can read`() {
        repo.contextRefsRequested("p1")
        repo.contextRefsFailed("p1", "Tool not permitted")

        assertEquals("Tool not permitted", (repo.contextRefs.value as PlanContextRefs.Failed).message)
    }

    /**
     * REGRESSION — the stale-answer guard used to read the ask off the CURRENT
     * STATE, and a settled state carries no ask. So the slow first directory's
     * answer, arriving after the second had already gone Ready, saw "nothing
     * asked" and was applied: the state then described directory A while the
     * screen showed directory B, `LoadViews` correctly refused to draw A's rows
     * under B's heading, and B sat on a spinner with nothing in flight.
     */
    @Test
    fun `an answer for a superseded directory never lands after the newer one settled`() {
        repo.listRequested("/a")
        repo.listRequested("/b")

        assertTrue(repo.listArrived("/b", parse("""[{"id":"pb","title":"B work"}]""")))
        assertTrue(repo.listArrived("/a", parse("""[{"id":"pa","title":"A work"}]""")))

        val ready = repo.list.value as PlanList.Ready
        assertEquals("/b", ready.dirPath)
        assertEquals(listOf("pb"), ready.plans.map { it.id })
    }

    /** The same hole, on the detail machine: a settled Ready carried no ask. */
    @Test
    fun `a plan answer for a superseded plan never lands after the newer one settled`() {
        repo.detailRequested("p1")
        repo.detailRequested("p2")

        repo.detailArrived("p2", parse("""{"id":"p2","dirPath":"/work","title":"Second"}"""))
        repo.detailArrived("p1", parse("""{"id":"p1","dirPath":"/work","title":"First"}"""))

        assertEquals("p2", (repo.detail.value as PlanDetail.Ready).plan.id)
    }

    /** And on the refs machine, whose Ready carried the plan id but not the ask. */
    @Test
    fun `a refs answer for a superseded plan never lands after the newer one settled`() {
        repo.contextRefsRequested("p1")
        repo.contextRefsRequested("p2")

        repo.contextRefsArrived("p2", parse("""[{"id":"c2","type":"Testing","source":"plan"}]"""))
        repo.contextRefsArrived("p1", parse("""[{"id":"c1","type":"Coding","source":"plan"}]"""))

        val ready = repo.contextRefs.value as PlanContextRefs.Ready
        assertEquals("p2", ready.planId)
        assertEquals(listOf("c2"), ready.refs.map { it.id })
    }

    /** The wire's answer as the envelope delivers it: PARSED, not text. */
    private fun parse(json: String): Any = org.json.JSONTokener(json).nextValue()

    /** A `plan_summary` answer: ids, title, status, edges — and no description. */
    private fun listJson(): String =
        """[{"id":"p1","humanId":"P-0007","title":"Wire the board","type":"feature",""" +
            """"status":"coding","stateUpdatedAt":1700,"sequenceId":"seq1",""" +
            """"sessionId":"s3","sessionName":"helm-claude",""" +
            """"blockedBy":["P-0006"],"blocks":["P-0008"]},""" +
            """{"id":"p2","humanId":"P-0008","title":"Ship it","status":"planning",""" +
            """"blockedBy":["P-0007"],"blocks":[]}]"""

    private fun detailJson(): String =
        """{"id":"p1","humanId":"P-0007","projectId":"proj1","dirPath":"/work","title":"Wire the board",""" +
            """"description":"Do the thing.","status":"review","stateInfo":"waiting on review",""" +
            """"autoImplement":true,"sessionId":"s3","createdAt":100,"stateUpdatedAt":1700,"updatedAt":200}"""
}
