package com.potatomotato.helm.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The permitted surface, and the three states the control sheet must tell apart:
 * not asked, asked-and-allowed, asked-and-not.
 */
class CapabilityCacheTest {
    private val cache = CapabilityCache()

    @Test
    fun `an unasked surface allows nothing and is not an empty answer`() {
        assertFalse(cache.allows("session_compact"))

        // The distinction matters on screen: Unknown renders an action as not yet
        // offered, while Known-without-it renders "not permitted". Claiming a
        // permission verdict the phone has not been given is a lie the user
        // cannot check.
        assertEquals(Capabilities.Unknown, cache.state.value)
    }

    @Test
    fun `the gate's answer becomes the surface`() {
        assertTrue(cache.apply(toolsResult("session_list", "session_compact")))

        assertTrue(cache.allows("session_compact"))
        assertFalse(cache.allows("session_create"))
        assertEquals(Capabilities.Known(setOf("session_list", "session_compact")), cache.state.value)
    }

    @Test
    fun `an empty tool list is a real answer, not an absent one`() {
        assertTrue(cache.apply(toolsResult()))

        // A device with an empty allow-list genuinely may do nothing, and the
        // sheet should say so rather than look like it is still loading.
        assertEquals(Capabilities.Known(emptySet()), cache.state.value)
    }

    @Test
    fun `a payload that is not a tool list leaves the last good answer standing`() {
        cache.apply(toolsResult("session_list"))

        assertFalse(cache.apply(JSONObject("""{"unexpected":true}""")))
        assertFalse(cache.apply(null))

        assertTrue(cache.allows("session_list"))
    }

    @Test
    fun `forgetting returns to unknown so a reconnect re-asks`() {
        cache.apply(toolsResult("session_close"))

        cache.forget()

        // The allow-list can be edited on the desktop while the phone is away.
        // Keeping the old answer would go on offering a revoked action.
        assertEquals(Capabilities.Unknown, cache.state.value)
        assertFalse(cache.allows("session_close"))
    }

    @Test
    fun `a tool entry without a name is skipped rather than poisoning the set`() {
        assertTrue(cache.apply(JSONObject("""{"tools":[{"name":"session_list"},{"title":"nameless"},7]}""")))

        assertEquals(Capabilities.Known(setOf("session_list")), cache.state.value)
    }

    @Test
    fun `the sheet offers only the actions the gate named`() {
        cache.apply(toolsResult("session_read_terminal", "session_compact"))

        val state = cache.state.value
        assertTrue(state.permits(SessionAction.Snapshot))
        assertTrue(state.permits(SessionAction.Compact))

        // Absent from the gate's answer, so the row greys and tapping it sends
        // nothing — the sheet never offers an action from a list of its own.
        assertFalse(state.permits(SessionAction.Spawn))
        assertFalse(state.permits(SessionAction.Close))
        assertTrue(state.answered)
    }

    @Test
    fun `nothing is offered before the gate has answered, and no verdict is claimed`() {
        val state = cache.state.value

        for (action in SessionAction.entries) assertFalse(state.permits(action))

        // Unavailable, but NOT "not permitted": the row says "checking…" instead
        // of asserting a refusal the phone was never given.
        assertFalse(state.answered)
    }

    /** The `__mobile_tools__` answer, shaped as MobileGate builds it. */
    private fun toolsResult(vararg names: String): JSONObject =
        JSONObject("""{"tools":[${names.joinToString(",") { """{"name":"$it","title":"t"}""" }}]}""")
}
