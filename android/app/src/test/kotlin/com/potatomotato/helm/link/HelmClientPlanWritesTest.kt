package com.potatomotato.helm.link

import com.potatomotato.helm.crypto.Cancellable
import com.potatomotato.helm.crypto.ChannelScheduler
import com.potatomotato.helm.data.CleanupState
import com.potatomotato.helm.data.PlanDetail
import com.potatomotato.helm.data.PlanList
import com.potatomotato.helm.data.PlanStatus
import com.potatomotato.helm.data.PlanWrite
import com.potatomotato.helm.data.PlanWriteKind
import com.potatomotato.helm.data.SequenceList
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P-0812: the phone's plan and sequence writes. Real client over a lambda link,
 * no mocks — every assertion is the wire record Helm would receive or the state
 * a screen would draw. The tool NAME and the ARGS are pinned because a wrong
 * one is refused by the desktop schema (additionalProperties: false).
 */
class HelmClientPlanWritesTest {
    private val sent = mutableListOf<ByteArray>()
    private val client = HelmClient(
        send = { bytes -> sent.add(bytes) },
        now = { 1_700_000_000_000L },
        scheduler = NeverScheduler,
    )

    @Test
    fun `each write names its desktop tool with exactly the args that tool takes`() {
        val cases = listOf(
            Triple({ client.createPlan("/w", " T ", "D", "bug", true) }, "plan_create",
                mapOf("dirPath" to "/w", "title" to "T", "description" to "D", "type" to "bug", "autoImplement" to true)),
            Triple({ client.updatePlan("/w", "p1", "T", "D") }, "plan_update",
                mapOf("uuid" to "p1", "title" to "T", "description" to "D")),
            Triple({ client.setPlanState("/w", "p1", PlanStatus.Ready) }, "plan_set_state",
                mapOf("uuid" to "p1", "status" to "ready")),
            Triple({ client.completePlan("/w", "p1", "Did the thing well") }, "plan_complete",
                mapOf("uuid" to "p1", "documentation" to "Did the thing well")),
            Triple({ client.reopenPlan("/w", "p1") }, "plan_reopen", mapOf("uuid" to "p1")),
            Triple({ client.deletePlan("/w", "p1") }, "plan_delete", mapOf("uuid" to "p1")),
            Triple({ client.assignSequence("/w", "p1", "s1") }, "sequence_assign",
                mapOf("planId" to "p1", "sequenceId" to "s1")),
            Triple({ client.createSequence("/w", "Lane", "Why") }, "sequence_create",
                mapOf("dirPath" to "/w", "title" to "Lane", "missionStatement" to "Why")),
            Triple({ client.updateSequence("/w", "s1", "Lane", "Why") }, "sequence_update",
                mapOf("id" to "s1", "title" to "Lane", "missionStatement" to "Why")),
            Triple({ client.deleteSequence("/w", "s1") }, "sequence_delete", mapOf("id" to "s1")),
            Triple({ client.refreshCleanupCounts("/w") }, "plan_cleanup_counts", mapOf("dirPath" to "/w")),
            Triple({ client.clearUnused("/w") }, "sequence_clear_empty", mapOf("dirPath" to "/w")),
        )
        for ((act, method, args) in cases) {
            sent.clear()
            act()
            val record = JSONObject(String(sent.single(), Charsets.UTF_8))
            assertEquals(method, record.getString("method"))
            assertEquals(method, args, record.getJSONObject("params").toMap())
        }
    }

    @Test
    fun `a plan with no type omits it rather than sending an empty string`() {
        client.createPlan("/w", "T", "", null, false)

        val params = lastRecord().getJSONObject("params")
        assertEquals(setOf("dirPath", "title", "description", "autoImplement"), params.keySet())
    }

    @Test
    fun `unlinking a plan from its lane sends an explicit null`() {
        client.assignSequence("/w", "p1", null)

        assertTrue(lastRecord().getJSONObject("params").isNull("sequenceId"))
    }

    @Test
    fun `a successful write refreshes the plan and the board`() {
        client.updatePlan("/w", "p1", "T", "D")
        val writeId = lastRecord().getString("id")
        sent.clear()

        client.onInbound(resultFor(writeId, """{"id":"p1"}"""))

        assertEquals(PlanWriteKind.UpdatePlan, (client.planWrites.state.value as PlanWrite.Done).kind)
        assertEquals(listOf("plan_get", "plan_summary", "sequence_list"), sent.map { methodOf(it) })
    }

    @Test
    fun `a failed write leaves the cached board untouched and says why`() {
        client.refreshPlans("/w")
        client.onInbound(resultFor(lastRecord().getString("id"), """[{"id":"p1","title":"Keep"}]"""))
        client.deletePlan("/w", "p1")
        val writeId = lastRecord().getString("id")
        sent.clear()

        client.onInbound(errorFor(writeId, "Tool not permitted"))

        val failed = client.planWrites.state.value as PlanWrite.Failed
        assertEquals("Tool not permitted", failed.message)
        assertEquals(listOf("p1"), (client.plans.list.value as PlanList.Ready).plans.map { it.id })
        assertEquals(listOf("p1"), client.plans.cachedPlans("/w").map { it.id })
        assertTrue("a failed write must not re-pull anything", sent.isEmpty())
    }

    @Test
    fun `a confirmed delete purges the row before the refresh lands`() {
        client.refreshPlans("/w")
        client.onInbound(resultFor(lastRecord().getString("id"), """[{"id":"p1"},{"id":"p2"}]"""))
        client.readPlan("p1")
        client.onInbound(resultFor(lastRecord().getString("id"), """{"id":"p1","title":"Gone"}"""))
        client.deletePlan("/w", "p1")

        client.onInbound(resultFor(lastRecord().getString("id"), """{"deleted":true}"""))

        assertEquals(listOf("p2"), client.plans.cachedPlans("/w").map { it.id })
        // The refresh the delete fired is now in flight over the purged cache.
        assertEquals(listOf("p2"), (client.plans.list.value as PlanList.Refreshing).cached.map { it.id })
    }

    @Test
    fun `a confirmed sequence delete purges the lane`() {
        client.refreshSequences("/w")
        client.onInbound(resultFor(lastRecord().getString("id"), """[{"id":"s1"},{"id":"s2"}]"""))
        client.deleteSequence("/w", "s1")

        client.onInbound(resultFor(lastRecord().getString("id"), """{"deleted":true}"""))

        assertEquals(listOf("s2"), client.sequences.cachedSequences("/w").map { it.id })
        assertTrue(client.sequences.list.value is SequenceList.Refreshing)
    }

    @Test
    fun `clear unused runs empty sequences first, then unreferenced contexts`() {
        client.clearUnused("/w")
        val first = lastRecord().getString("id")
        sent.clear()

        client.onInbound(resultFor(first, """{"deleted":1}"""))

        val second = sent.map { JSONObject(String(it, Charsets.UTF_8)) }.single { it.getString("method") == "context_clear_unreferenced" }
        assertEquals("/w", second.getJSONObject("params").getString("dirPath"))
        assertTrue(client.planWrites.state.value is PlanWrite.InFlight)

        client.onInbound(resultFor(second.getString("id"), """{"deleted":2}"""))

        assertEquals(PlanWriteKind.ClearUnused, (client.planWrites.state.value as PlanWrite.Done).kind)
    }

    @Test
    fun `clear unused stops at a failed first step and never clears contexts`() {
        client.clearUnused("/w")
        val first = lastRecord().getString("id")
        sent.clear()

        client.onInbound(errorFor(first, "desktop busy"))

        assertTrue(sent.none { methodOf(it) == "context_clear_unreferenced" })
        assertEquals("desktop busy", (client.planWrites.state.value as PlanWrite.Failed).message)
    }

    @Test
    fun `cleanup counts land as state the sequences tab can draw`() {
        client.refreshCleanupCounts("/w")

        client.onInbound(
            resultFor(
                lastRecord().getString("id"),
                """{"donePlans":3,"emptySequences":2,"unreferencedContexts":1,"unusedContexts":4}""",
            ),
        )

        val counts = (client.sequences.cleanup.value as CleanupState.Ready).counts
        assertEquals(2, counts.emptySequences)
        assertEquals(4, counts.unusedContexts)
    }

    @Test
    fun `an unreadable cleanup answer is a failure, not zero`() {
        client.refreshCleanupCounts("/w")

        client.onInbound(resultFor(lastRecord().getString("id"), "[]"))

        assertTrue(client.sequences.cleanup.value is CleanupState.Failed)
    }

    @Test
    fun `a completed plan re-reads its detail`() {
        client.completePlan("/w", "p1", "Did the thing well")
        client.onInbound(resultFor(lastRecord().getString("id"), """{"ok":true}"""))
        val read = sent.map { JSONObject(String(it, Charsets.UTF_8)) }.single { it.getString("method") == "plan_get" }

        client.onInbound(resultFor(read.getString("id"), """{"id":"p1","status":"done"}"""))

        assertEquals(PlanStatus.Done, (client.plans.detail.value as PlanDetail.Ready).plan.status)
    }

    private fun lastRecord() = JSONObject(String(sent.last(), Charsets.UTF_8))

    private fun methodOf(bytes: ByteArray) = JSONObject(String(bytes, Charsets.UTF_8)).getString("method")

    private fun JSONObject.toMap(): Map<String, Any> = keySet().associateWith { get(it) }

    private fun resultFor(id: String, resultJson: String): ByteArray =
        """{"v":1,"t":"result","id":"$id","result":$resultJson}""".toByteArray(Charsets.UTF_8)

    private fun errorFor(id: String, message: String): ByteArray =
        """{"v":1,"t":"error","id":"$id","error":{"code":-32000,"message":"$message"}}""".toByteArray(Charsets.UTF_8)

    /** Deadlines never fire here: these tests are about verdicts, not timeouts. */
    private object NeverScheduler : ChannelScheduler {
        override fun schedule(delayMs: Long, action: () -> Unit): Cancellable = Cancellable {}
    }
}
