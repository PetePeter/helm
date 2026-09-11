package com.potatomotato.helm.link

import com.potatomotato.helm.data.Delivery
import com.potatomotato.helm.ui.components.SessionState
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Call correlation and the failure paths around it.
 *
 * The link is a real one in miniature: a lambda that either carries bytes or
 * does not, which is exactly what `HelmPairing.send` is. Nothing is mocked and
 * nothing is verified — every assertion is about state the app would render.
 */
class HelmClientTest {
    private val sent = mutableListOf<ByteArray>()
    private var linked = true
    private var clock = 1_700_000_000_000L
    private val client = HelmClient(
        send = { bytes -> if (linked) sent.add(bytes) else false },
        now = { clock },
    )

    @Test
    fun `a session list result lands in the repository`() {
        client.refreshSessions()

        client.onInbound(resultFor(lastCallId(), """[{"id":"s1","name":"work","activityLevel":"active"}]"""))

        val session = client.sessions.sessions.value.single()
        assertEquals("work", session.name)
        assertEquals(SessionState.Active, session.activity)
    }

    @Test
    fun `a refresh that fails leaves the previous list standing`() {
        client.refreshSessions()
        client.onInbound(resultFor(lastCallId(), """[{"id":"s1","name":"work"}]"""))

        client.refreshSessions()
        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals(listOf("s1"), client.sessions.sessions.value.map { it.id })
    }

    @Test
    fun `a result is delivered to the call that asked for it and nothing else`() {
        client.refreshSessions()
        val first = lastCallId()
        client.sendChat("s1", "carry on")
        val second = lastCallId()

        // Answer the chat call; the list call is still outstanding and untouched.
        client.onInbound(resultFor(second, "null"))

        assertEquals(Delivery.Sent, client.chats.thread("s1").single().delivery)
        assertTrue(client.sessions.sessions.value.isEmpty())

        client.onInbound(resultFor(first, """[{"id":"s1","name":"work"}]"""))
        assertEquals(1, client.sessions.sessions.value.size)
    }

    @Test
    fun `a result for an id nobody is waiting on is ignored`() {
        client.onInbound(resultFor("p999", """[{"id":"s1","name":"work"}]"""))
        client.onInbound(ByteArray(0))
        client.onInbound("not json at all".toByteArray())

        assertTrue(client.sessions.sessions.value.isEmpty())
    }

    @Test
    fun `a chat record from Helm joins the thread it names`() {
        client.onInbound(chatBytes(sessionId = "s1", text = "the build is green", at = 5))
        client.onInbound(chatBytes(sessionId = "s2", text = "elsewhere", at = 6))

        assertEquals("the build is green", client.chats.thread("s1").single().text)
        assertEquals(1, client.chats.thread("s2").size)
        assertFalse(client.chats.thread("s1").single().fromPhone)
    }

    @Test
    fun `a reply is sent as a gated session_send_text call, never a side channel`() {
        client.sendChat("s1", "carry on")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("call", record.getString("t"))
        assertEquals("session_send_text", record.getString("method"))
        assertEquals("s1", record.getJSONObject("params").getString("sessionId"))
        assertEquals("carry on", record.getJSONObject("params").getString("text"))
    }

    @Test
    fun `a reply shows immediately as sending and settles when Helm answers`() {
        client.sendChat("s1", "carry on")
        assertEquals(Delivery.Sending, client.chats.thread("s1").single().delivery)

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))
        assertEquals(Delivery.Failed, client.chats.thread("s1").single().delivery)
    }

    @Test
    fun `a reply with no link to carry it fails at once rather than hanging`() {
        linked = false

        assertFalse(client.sendChat("s1", "carry on"))
        assertEquals(Delivery.Failed, client.chats.thread("s1").single().delivery)
        assertFalse(client.refreshSessions())
    }

    @Test
    fun `everything outstanding fails when the link drops`() {
        client.sendChat("s1", "carry on")

        client.onLinkLost()

        assertEquals(Delivery.Failed, client.chats.thread("s1").single().delivery)
    }

    @Test
    fun `an answer that arrives after the link dropped is not applied twice`() {
        client.sendChat("s1", "carry on")
        val id = lastCallId()
        client.onLinkLost()

        client.onInbound(resultFor(id, "null"))

        // Still Failed: the link-lost verdict stands, and the late result found
        // no pending entry to settle.
        assertEquals(Delivery.Failed, client.chats.thread("s1").single().delivery)
    }

    @Test
    fun `a flood of unanswered calls cannot grow without bound`() {
        repeat(40) { client.sendChat("s1", "message $it") }

        // The oldest are abandoned to make room; the newest stay outstanding.
        val thread = client.chats.thread("s1")
        assertEquals(Delivery.Failed, thread.first().delivery)
        assertEquals(Delivery.Sending, thread.last().delivery)
    }

    /** Helm's side of the wire, built with the same codec the desktop is pinned to. */
    private fun resultFor(id: String, resultJson: String): ByteArray =
        """{"v":1,"t":"result","id":"$id","result":$resultJson}""".toByteArray(Charsets.UTF_8)

    private fun errorFor(id: String, message: String): ByteArray =
        """{"v":1,"t":"error","id":"$id","error":{"code":-32000,"message":"$message"}}""".toByteArray(Charsets.UTF_8)

    private fun chatBytes(sessionId: String, text: String, at: Long): ByteArray =
        """{"v":1,"t":"chat","sessionId":"$sessionId","sessionName":"work","text":"$text","at":$at}"""
            .toByteArray(Charsets.UTF_8)

    private fun lastCallId(): String = JSONObject(String(sent.last(), Charsets.UTF_8)).getString("id")
}
