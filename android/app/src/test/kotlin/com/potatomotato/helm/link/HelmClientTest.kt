package com.potatomotato.helm.link

import com.potatomotato.helm.data.ActionNotice
import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.Delivery
import com.potatomotato.helm.data.Reach
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.Snapshot
import com.potatomotato.helm.notify.FakeNotificationPort
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
    fun `a kind-bearing record notifies and never enters the thread`() {
        val port = FakeNotificationPort()
        client.alerts.port = port

        client.onInbound(chatBytes(sessionId = "s1", text = "is idle", at = 7, kind = "idle"))

        // A fabricated agent line is the failure this split exists to prevent:
        // "is idle" as a chat bubble reads as something the CLI said.
        assertTrue(client.chats.thread("s1").isEmpty())
        assertEquals("is idle", port.showing("s1")?.text)
    }

    @Test
    fun `a plain chat record still lands in the thread and never notifies`() {
        val port = FakeNotificationPort()
        client.alerts.port = port

        client.onInbound(chatBytes(sessionId = "s1", text = "the build is green", at = 8))

        assertEquals("the build is green", client.chats.thread("s1").single().text)
        assertTrue(port.shade.isEmpty())
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

    @Test
    fun `the permitted surface is asked for, never assumed`() {
        client.refreshCapabilities()

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("__mobile_tools__", record.getString("method"))

        client.onInbound(resultFor(lastCallId(), """{"tools":[{"name":"session_compact"}]}"""))
        assertTrue(client.capabilities.allows("session_compact"))
        assertFalse(client.capabilities.allows("session_create"))
    }

    @Test
    fun `a discovery that is refused leaves the surface unknown, not empty`() {
        client.refreshCapabilities()

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        // "We could not ask" must not render as "you may not": the sheet greys
        // either way, but only one of them may claim a permission verdict.
        assertEquals(Capabilities.Unknown, client.capabilities.state.value)
    }

    @Test
    fun `the surface is forgotten with the link so a reconnect re-asks`() {
        client.refreshCapabilities()
        client.onInbound(resultFor(lastCallId(), """{"tools":[{"name":"session_close"}]}"""))

        client.onLinkLost()

        assertEquals(Capabilities.Unknown, client.capabilities.state.value)
    }

    @Test
    fun `a snapshot asks for a numeric line count and the desktop's own cleaning`() {
        assertTrue(client.readTerminal("s1", 200))

        val params = JSONObject(String(sent.single(), Charsets.UTF_8)).getJSONObject("params")
        // A NUMBER, not "200": the desktop reads lines with a typeof check and
        // silently answers the default tail for a quoted one.
        assertEquals(200, params.get("lines"))
        assertEquals("stripped", params.getString("mode"))
        assertTrue(params.getBoolean("stripBlankLines"))
    }

    @Test
    fun `a snapshot past the buffer never reaches the radio`() {
        assertFalse(client.readTerminal("s1", HelmClient.MAX_SNAPSHOT_LINES + 1))
        assertFalse(client.readTerminal("s1", 0))

        assertTrue(sent.isEmpty())
        assertTrue(client.control.snapshot.value is Snapshot.Failed)
    }

    @Test
    fun `a snapshot result lands as lines and a refusal lands as a failure`() {
        client.readTerminal("s1", 50)
        client.onInbound(resultFor(lastCallId(), """{"stripped":["$ ls","a.txt"]}"""))
        assertEquals(Snapshot.Lines(listOf("$ ls", "a.txt"), 50), client.control.snapshot.value)

        client.readTerminal("s1", 50)
        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))
        assertTrue(client.control.snapshot.value is Snapshot.Failed)
    }

    @Test
    fun `a refusal for a permitted-looking action is a rule, not a dropped link`() {
        // The capability cache says yes — the gate is still the authority, and it
        // can refuse for a reason the cache cannot see (an allow-list edited since,
        // a disabled device). That outcome must be READABLE, not a crash and not
        // silence, and it must not be confused with the link going.
        client.capabilities.apply(JSONObject("""{"tools":[{"name":"session_close"}]}"""))

        client.closeSession("s1")
        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals(
            ActionNotice(SessionAction.Close, ActionOutcome.Refused),
            client.control.notice.value,
        )
    }

    @Test
    fun `a control action with no link to carry it reports the link, not a refusal`() {
        linked = false

        assertFalse(client.compact("s1"))

        val notice = client.control.notice.value!!
        assertEquals(SessionAction.Compact, notice.action)
        assertTrue(notice.outcome is ActionOutcome.Failed)
    }

    @Test
    fun `spawn sends the three arguments session_create needs and reports success`() {
        client.spawn(dirPath = "x:\\coding\\gamepad-cli-hub", cliType = "claudecode", name = "kitchen")

        val params = JSONObject(String(sent.single(), Charsets.UTF_8)).getJSONObject("params")
        assertEquals("x:\\coding\\gamepad-cli-hub", params.getString("dirPath"))
        assertEquals("claudecode", params.getString("cliType"))
        assertEquals("kitchen", params.getString("name"))

        client.onInbound(resultFor(lastCallId(), """{"sessionId":"s9"}"""))
        assertEquals(ActionNotice(SessionAction.Spawn, ActionOutcome.Done), client.control.notice.value)
    }

    @Test
    fun `a denied session list is remembered as denied`() {
        client.refreshSessions()

        client.onInbound(errorFor(lastCallId(), HelmClient.MOBILE_DENY_MESSAGE))

        // The screen may now say the phone has no permissions granted yet.
        assertEquals(Reach.Denied, client.sessions.reach.value)
    }

    @Test
    fun `a call that never reached the radio is not a denial`() {
        // THE distinction this plan turns on. The user's phone refused 40+ polls
        // locally because the link was down. Calling that "denied" would send
        // them hunting a permissions setting that was never the problem.
        linked = false

        assertFalse(client.refreshSessions())

        assertEquals(Reach.Never, client.sessions.reach.value)
    }

    @Test
    fun `an answer that arrived and could not be read says so instead of showing nothing`() {
        client.refreshSessions()
        client.onInbound(resultFor(lastCallId(), """[{"id":"s1","name":"work"}]"""))

        client.refreshSessions()
        // `ok` on the wire carrying a shape parseList cannot read — the failure
        // this app is worst at, because it used to render as "no sessions".
        client.onInbound(resultFor(lastCallId(), """{"items":[]}"""))

        assertEquals(Reach.Undecodable, client.sessions.reach.value)
        assertEquals(listOf("s1"), client.sessions.sessions.value.map { it.id })
    }

    /** Helm's side of the wire, built with the same codec the desktop is pinned to. */
    private fun resultFor(id: String, resultJson: String): ByteArray =
        """{"v":1,"t":"result","id":"$id","result":$resultJson}""".toByteArray(Charsets.UTF_8)

    private fun errorFor(id: String, message: String): ByteArray =
        """{"v":1,"t":"error","id":"$id","error":{"code":-32000,"message":"$message"}}""".toByteArray(Charsets.UTF_8)

    private fun chatBytes(sessionId: String, text: String, at: Long, kind: String? = null): ByteArray =
        (StringBuilder("""{"v":1,"t":"chat","sessionId":"$sessionId","sessionName":"work","text":"$text","at":$at""")
            .apply { if (kind != null) append(""","kind":"$kind"""") }
            .append('}'))
            .toString()
            .toByteArray(Charsets.UTF_8)

    private fun lastCallId(): String = JSONObject(String(sent.last(), Charsets.UTF_8)).getString("id")
}
