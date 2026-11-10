package com.potatomotato.helm.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionQuotaUsageTest {
    @Test
    fun parsesOnlyCompleteQuotaSnapshots() {
        val measuredAt = System.currentTimeMillis()
        val quota = JSONObject()
            .put("fiveHour", window(72, measuredAt + 4 * 60 * 60_000L))
            .put("weekly", window(41, measuredAt + 6 * 24 * 60 * 60_000L))
            .put("measuredAtEpochMs", measuredAt)
        val parsed = SessionWire.parseList(JSONArray().put(sessionRow(quota)))!!.single()

        assertEquals(SessionQuotaUsage(
            fiveHour = SessionQuotaWindow(72f, measuredAt + 4 * 60 * 60_000L),
            weekly = SessionQuotaWindow(41f, measuredAt + 6 * 24 * 60 * 60_000L),
            measuredAtEpochMs = measuredAt,
        ), parsed.quotaUsage)

        val partial = JSONObject()
            .put("fiveHour", window(72, measuredAt + 4 * 60 * 60_000L))
            .put("measuredAtEpochMs", measuredAt)
        assertNull(SessionWire.parseList(JSONArray().put(sessionRow(partial)))!!.single().quotaUsage)
    }

    @Test
    fun rejectsInvalidPercentagesAndResetsBeforeMeasurement() {
        val measuredAt = System.currentTimeMillis()
        val malformed = JSONObject()
            .put("fiveHour", window(101, measuredAt + 4 * 60 * 60_000L))
            .put("weekly", window(41, measuredAt + 6 * 24 * 60 * 60_000L))
            .put("measuredAtEpochMs", measuredAt)
        val expired = JSONObject()
            .put("fiveHour", window(72, measuredAt - 1))
            .put("weekly", window(41, measuredAt + 6 * 24 * 60 * 60_000L))
            .put("measuredAtEpochMs", measuredAt)

        assertNull(SessionWire.parseList(JSONArray().put(sessionRow(malformed)))!!.single().quotaUsage)
        assertNull(SessionWire.parseList(JSONArray().put(sessionRow(expired)))!!.single().quotaUsage)
    }

    private fun sessionRow(quota: JSONObject) = JSONObject()
        .put("id", "session")
        .put("quotaUsage", quota)

    private fun window(percent: Int, resetAt: Long) = JSONObject()
        .put("usedPercent", percent)
        .put("resetsAtEpochMs", resetAt)
}
