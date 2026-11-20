package com.potatomotato.helm.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as tests/session/quota-burn.test.ts, so the phone and desktop agree. */
class QuotaBurnTest {
    private val now = 1_800_000_000_000L
    private val min = 60_000L
    private val hour = 60 * min

    private fun usage(fiveHour: Float, history: List<QuotaHistoryPoint>, fiveReset: Long = now + 4 * hour) = SessionQuotaUsage(
        fiveHour = SessionQuotaWindow(fiveHour, fiveReset),
        weekly = SessionQuotaWindow(10f, now + 72 * hour),
        measuredAtEpochMs = now,
        history = history,
    )

    private fun fiveHour(usage: SessionQuotaUsage) = QuotaBurns.burn(usage, QuotaWindowKey.FiveHour, now)

    @Test
    fun `20 used turning into 30 an hour later is 10 per hour`() {
        assertEquals(10f, fiveHour(usage(30f, listOf(QuotaHistoryPoint(now - hour, 20f, 10f))))!!.perHour, 0.01f)
    }

    @Test
    fun `projects when the quota runs out and flags it before the reset`() {
        val burn = fiveHour(usage(70f, listOf(QuotaHistoryPoint(now - hour, 60f, 10f)), fiveReset = now + 5 * hour))!!
        assertEquals(3 * hour, burn.outInMs)
        assertTrue(burn.beforeReset)
        assertEquals("10%/h · out in 3h 0m", QuotaBurns.label(burn))
    }

    @Test
    fun `a burn that lasts until the reset is not flagged`() {
        val burn = fiveHour(usage(70f, listOf(QuotaHistoryPoint(now - hour, 60f, 10f)), fiveReset = now + hour))!!
        assertFalse(burn.beforeReset)
        assertEquals("10%/h · lasts to reset", QuotaBurns.label(burn))
    }

    @Test
    fun `flat usage has no burn`() {
        assertEquals(QuotaBurn(0f, null, false), fiveHour(usage(40f, listOf(QuotaHistoryPoint(now - hour, 40f, 10f)))))
    }

    @Test
    fun `readings from before a window reset are ignored`() {
        val history = listOf(QuotaHistoryPoint(now - hour, 90f, 10f), QuotaHistoryPoint(now - 30 * min, 5f, 10f))
        assertEquals(20f, fiveHour(usage(15f, history))!!.perHour, 0.01f)
    }

    @Test
    fun `under ten minutes of readings gives no rate`() {
        assertNull(fiveHour(usage(30f, listOf(QuotaHistoryPoint(now - 5 * min, 20f, 10f)))))
        assertNull(fiveHour(usage(30f, emptyList())))
    }

    @Test
    fun `the history arrives with the session quota`() {
        val quota = JSONObject()
            .put("fiveHour", JSONObject().put("usedPercent", 30).put("resetsAtEpochMs", now + hour))
            .put("weekly", JSONObject().put("usedPercent", 10).put("resetsAtEpochMs", now + 72 * hour))
            .put("measuredAtEpochMs", now)
            .put("history", JSONArray().put(JSONObject().put("at", now - hour).put("fiveHour", 20).put("weekly", 9)))
        assertEquals(listOf(QuotaHistoryPoint(now - hour, 20f, 9f)), SessionWire.parseQuotaUsage(quota)!!.history)
    }
}
