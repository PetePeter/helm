package com.potatomotato.helm.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Freeze and prompt-cache staleness, read off the desktop's session list. */
class CacheStageTest {

    private val min = 60_000L

    private fun parse(vararg fields: Pair<String, Any>): HelmSession {
        val summary = JSONObject().put("id", "s1").put("name", "A")
        for ((k, v) in fields) summary.put(k, v)
        return SessionWire.parseList(JSONArray().put(summary))!!.single()
    }

    @Test
    fun `reads freeze, last prompt and the CLI's cache windows`() {
        val s = parse("frozen" to true, "lastPromptAtEpochMs" to 1000L, "cacheWarnMinutes" to 3, "cacheExpireMinutes" to 30)
        assertTrue(s.frozen)
        assertEquals(1000L, s.lastPromptAtEpochMs)
        assertEquals(3, s.cacheWarnMinutes)
        assertEquals(30, s.cacheExpireMinutes)
    }

    @Test
    fun `an older desktop that sends none of it reads as fresh and live with 5 and 60 minute windows`() {
        val s = parse()
        assertFalse(s.frozen)
        assertEquals(5, s.cacheWarnMinutes)
        assertEquals(60, s.cacheExpireMinutes)
        assertEquals(CacheStage.Fresh, s.cacheStage(nowMs = 10_000 * min))
    }

    @Test
    fun `stage moves fresh to warn to expired, and frozen outranks all`() {
        val s = parse("lastPromptAtEpochMs" to 0L)
        assertEquals(CacheStage.Fresh, s.cacheStage(5 * min))
        assertEquals(CacheStage.Warn, s.cacheStage(5 * min + 1))
        assertEquals(CacheStage.Expired, s.cacheStage(60 * min + 1))
        assertEquals(CacheStage.Frozen, s.copy(frozen = true).cacheStage(0))
    }

    @Test
    fun `the operator never goes stale - it is never frozen and its cost does not matter`() {
        val op = parse("lastPromptAtEpochMs" to 0L, "role" to "operator")
        assertEquals(CacheStage.Fresh, op.cacheStage(10_000 * min))
    }

    @Test
    fun `a CLI type with no prompt cache never goes stale`() {
        val s = parse("lastPromptAtEpochMs" to 0L, "noPromptCache" to true)
        assertEquals(CacheStage.Fresh, s.cacheStage(10_000 * min))
    }

    @Test
    fun `status icons mirror the desktop row - every one that applies, in order`() {
        val now = 10_000 * min
        assertEquals("", parse().statusIcons(now))
        assertEquals("🔒", parse("locked" to true).statusIcons(now))
        assertEquals(
            "🔒 ❄️ ⏰",
            parse("locked" to true, "frozen" to true, "keepWarmUntilEpochMs" to now + min).statusIcons(now),
        )
        assertEquals("", parse("keepWarmUntilEpochMs" to now - 1).statusIcons(now))
    }

}

class FrozenRefusalTest {
    @Test
    fun `the desktop's frozen refusal settles the bubble as Frozen, anything else as Failed`() {
        assertTrue(isFrozenRefusal("Session \"worker\" is frozen — it accepts no input until the user unfreezes it"))
        assertFalse(isFrozenRefusal("Session PTY is not running: s1"))

        val chats = ChatRepository()
        val key = chats.sending("s1", "hi", at = 1)
        chats.settle("s1", key, delivered = false, frozen = true)
        assertEquals(Delivery.Frozen, chats.threads.value["s1"]!!.single().delivery)
    }
}
