package com.potatomotato.helm.link

import com.potatomotato.helm.data.ActionNotice
import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.ArtifactList
import com.potatomotato.helm.data.ArtifactRead
import com.potatomotato.helm.data.ArtifactLanding
import com.potatomotato.helm.data.ArtifactSave
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.ContextDetail
import com.potatomotato.helm.data.ContextList
import com.potatomotato.helm.data.ContextPermission
import com.potatomotato.helm.data.Delivery
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.ATTACHMENT_SLICE_BYTES_BLE
import com.potatomotato.helm.data.HelmArtifactAttachment
import com.potatomotato.helm.data.HelmDirectory
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.data.artifactAttachmentKey
import com.potatomotato.helm.save.SavedFile
import com.potatomotato.helm.data.HelmProject
import com.potatomotato.helm.data.PlanContextRefs
import com.potatomotato.helm.data.PlanDetail
import com.potatomotato.helm.data.PlanList
import com.potatomotato.helm.data.PlanStatus
import com.potatomotato.helm.data.ProjectList
import com.potatomotato.helm.data.Reach
import com.potatomotato.helm.data.SequenceDetail
import com.potatomotato.helm.data.SequenceList
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.Snapshot
import com.potatomotato.helm.crypto.Cancellable
import com.potatomotato.helm.crypto.ChannelScheduler
import com.potatomotato.helm.notify.AlertKind
import com.potatomotato.helm.notify.FakeNotificationPort
import com.potatomotato.helm.data.ArtifactRules
import com.potatomotato.helm.ui.components.SessionState
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    private val scheduler = TestScheduler()
    private val client = HelmClient(
        send = { bytes -> if (linked) sent.add(bytes) else false },
        now = { clock },
        scheduler = scheduler,
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
    fun `session refreshes coalesce while a previous refresh is waiting`() {
        client.refreshSessions()
        val first = lastCallId()
        client.refreshSessions()
        client.refreshSessions()

        // Two records: the chat cursor this link had not heard, then the list.
        assertEquals(2, sent.size)

        client.onInbound(resultFor(first, "[]"))

        assertEquals(3, sent.size)
        assertEquals("session_list", JSONObject(String(sent.last(), Charsets.UTF_8)).getString("method"))
    }

    @Test
    fun `a queued refresh still runs after the first refresh fails`() {
        client.refreshSessions()
        val first = lastCallId()
        client.refreshSessions()

        client.onInbound(errorFor(first, "desktop busy"))

        // Third record: the reconciled list, after the cursor and the first try.
        assertEquals(3, sent.size)
    }

    @Test
    fun `a call deadline settles it and a late answer cannot apply it`() {
        client.refreshSessions()
        // Answer the cursor the refresh carried; its deadline stub still sits in
        // the queue, so drain BOTH deadlines — the list call's settle is the one
        // under test, and the late answer must find nothing to apply to.
        client.onInbound(resultFor(firstCallId(), "null"))
        val id = lastCallId()

        scheduler.runNext()
        scheduler.runNext()
        client.onInbound(resultFor(id, """[{"id":"late","name":"late"}]"""))

        assertTrue(client.sessions.sessions.value.isEmpty())
        assertTrue(scheduler.cancelled > 0)
    }

    @Test
    fun `a successful close requests one immediate reconciled session list`() {
        client.closeSession("s1")
        client.onInbound(resultFor(lastCallId(), "null"))

        // Close, then the reconcile's cursor + list.
        assertEquals(3, sent.size)
        client.onInbound(resultFor(lastCallId(), "[]"))
        assertTrue(client.sessions.sessions.value.isEmpty())
    }

    @Test
    fun `a rename sends the arguments session_rename needs and reconciles the list`() {
        client.renameSession("s1", "kitchen")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("session_rename", record.getString("method"))
        // newName, not name: the desktop's dispatcher reads the new name from
        // `newName` and would refuse a call that carried it under any other key.
        assertEquals("s1", record.getJSONObject("params").getString("sessionId"))
        assertEquals("kitchen", record.getJSONObject("params").getString("newName"))

        client.onInbound(resultFor(lastCallId(), "null"))
        assertNotice(SessionAction.Rename, ActionOutcome.Done)

        // The list is the only place the new name shows, so success pulls it —
        // the reconcile's cursor record rides with that pull.
        assertEquals(3, sent.size)
        assertEquals("session_list", JSONObject(String(sent.last(), Charsets.UTF_8)).getString("method"))
    }

    @Test
    fun `a rename refusal is a rule, not a dropped link`() {
        client.renameSession("s1", "kitchen")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertNotice(SessionAction.Rename, ActionOutcome.Refused)
    }

    @Test
    fun `a successful spawn requests one immediate reconciled session list`() {
        client.spawn(dirPath = "/work", cliType = "claudecode", name = "")
        client.onInbound(resultFor(lastCallId(), """{"id":"s2"}"""))

        // The reconcile rides the refresh path, so it carries the cursor too.
        assertEquals(3, sent.size)
        assertEquals("session_list", JSONObject(String(sent.last(), Charsets.UTF_8)).getString("method"))
    }

    @Test
    fun `a spawn is in flight from the tap until an answer comes back`() {
        client.spawn(dirPath = "/work", cliType = "claudecode", name = "")

        assertTrue(client.control.spawnInFlight.value)

        client.onInbound(resultFor(lastCallId(), """{"id":"s2"}"""))

        assertFalse(client.control.spawnInFlight.value)
    }

    @Test
    fun `a refused spawn is still settled`() {
        client.spawn(dirPath = "/work", cliType = "claudecode", name = "")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertFalse(client.control.spawnInFlight.value)
    }

    @Test
    fun `a spawn with no link never raises the flag at all`() {
        linked = false

        client.spawn(dirPath = "/work", cliType = "claudecode", name = "")

        // The call never crossed, so no answer is coming; the flag that greys the
        // button must not outlive a tap that already failed.
        assertFalse(client.control.spawnInFlight.value)
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

    /**
     * A plain chat record goes to BOTH surfaces. The thread is where the message
     * lives; the notification is how the user learns it arrived while they were
     * somewhere else — which, for the one record type they can answer, was the
     * gap that made the phone feel dead between glances.
     */
    @Test
    fun `a plain chat record lands in the thread and notifies`() {
        val port = FakeNotificationPort()
        client.alerts.port = port

        client.onInbound(chatBytes(sessionId = "s1", text = "the build is green", at = 8))

        assertEquals("the build is green", client.chats.thread("s1").single().text)
        // It must appear ONCE in the thread — the notification is a second
        // surface, not a second message.
        assertEquals(1, client.chats.thread("s1").size)
        assertEquals("the build is green", port.showing("s1")?.text)
        assertEquals(AlertKind.Message, port.showing("s1")?.kind)
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

    /**
     * The desktop journals an ACCEPTED reply and this phone's own catch-up hands
     * it back. The copy the user typed must win: the echoed one is dropped by
     * the originId this client registered from its own call id.
     */
    @Test
    fun `an echoed copy of this phone's own reply is dropped by its call id`() {
        client.machineId = "phone-machine"
        client.sendChat("s1", "carry on")
        val callId = lastCallId()
        client.onInbound(resultFor(callId, "null"))
        assertEquals(Delivery.Sent, client.chats.thread("s1").single().delivery)

        client.onInbound(
            chatBytes(sessionId = "s1", text = "carry on", at = 6, seq = 1, originId = "phone-machine:$callId"),
        )

        assertEquals(1, client.chats.thread("s1").size)
        assertEquals(Delivery.Sent, client.chats.thread("s1").single().delivery)
    }

    @Test
    fun `a call the link refused never claims its echo`() {
        client.machineId = "phone-machine"
        linked = false
        client.sendChat("s1", "carry on")
        linked = true

        // p0 was never carried, so nothing was registered for it — an echo named
        // "phone-machine:p0" is somebody else's history and must still land.
        client.onInbound(chatBytes(sessionId = "s1", text = "carry on", at = 6, seq = 1, originId = "phone-machine:p0"))

        assertEquals(2, client.chats.thread("s1").size)
    }

    @Test
    fun `another phone's echoed reply joins the thread as a phone message`() {
        client.machineId = "phone-machine"

        client.onInbound(
            chatBytes(sessionId = "s1", text = "from tablet", at = 6, seq = 2, originId = "tablet-machine:p1"),
        )

        assertTrue(client.chats.thread("s1").single().fromPhone)
    }

    @Test
    fun `a cursor report whose answer died with the link is said again`() {
        client.refreshSessions()
        // The list answers; the cursor's answer never arrives (the link that
        // carried it dropped before the desktop acted on it).
        client.onInbound(resultFor(lastCallId(), "[]"))
        scheduler.runNext() // the cursor's deadline settles it as failed

        client.refreshSessions()

        val methods = sent.map { JSONObject(String(it, Charsets.UTF_8)).getString("method") }
        assertEquals(listOf("__chat_cursor__", "session_list", "__chat_cursor__", "session_list"), methods)
    }

    @Test
    fun `a handshake re-made over a live transport re-reports the cursor`() {
        // The reconnect with permanently empty threads: the desktop re-made the
        // SecureChannel without the TRANSPORT ever going down, so the loss hook
        // — the only other place the flag is cleared — never fired.
        client.onLinkUp()
        client.onInbound(resultFor(firstCallId(), "null"))

        client.onLinkUp()

        val methods = sent.map { JSONObject(String(it, Charsets.UTF_8)).getString("method") }
        assertEquals(listOf("__chat_cursor__", "__chat_cursor__"), methods)
    }

    @Test
    fun `everything outstanding fails when the link drops`() {
        client.sendChat("s1", "carry on")

        client.onLinkLost()

        assertEquals(Delivery.Failed, client.chats.thread("s1").single().delivery)
    }

    @Test
    fun `a session poll re-reports the cursor a link never heard`() {
        // Observed on real hardware: after a failed handshake attempt, a relink
        // can come up usable without the link-up hook firing — `__mobile_tools__`
        // crosses, `__chat_cursor__` never does, and the threads stay empty for
        // the whole process. The poll is the backstop.
        client.onLinkUp()
        assertEquals("__chat_cursor__", JSONObject(String(sent.single(), Charsets.UTF_8)).getString("method"))

        // The report is per-link: a poll on the same link sends only the list.
        client.onInbound(resultFor(firstCallId(), "null"))
        client.refreshSessions()
        assertEquals(2, sent.size)
        assertEquals("session_list", JSONObject(String(sent.last(), Charsets.UTF_8)).getString("method"))

        // The link goes and comes back without the hook firing at all.
        client.onLinkLost()
        client.refreshSessions()

        val cursor = JSONObject(String(sent[2], Charsets.UTF_8))
        assertEquals("__chat_cursor__", cursor.getString("method"))
        assertEquals(0, cursor.getJSONObject("params").getLong("seq"))
        assertEquals("session_list", JSONObject(String(sent.last(), Charsets.UTF_8)).getString("method"))
    }

    @Test
    fun `a cursor report gone stale is said again without a reconnect`() {
        // The report went out and the desktop heard it — but a journal replay
        // streaming over BLE can outrun a link that drops mid-stream, leaving
        // the phone holding a hole and the desktop believing it is done. The
        // poll must re-say the cursor once the report is old enough to doubt.
        client.refreshSessions()
        client.onInbound(resultFor(firstCallId(), "null"))
        client.onInbound(resultFor(lastCallId(), "[]"))
        clock += 6 * 60 * 1000L

        client.refreshSessions()

        val methods = sent.map { JSONObject(String(it, Charsets.UTF_8)).getString("method") }
        assertEquals(listOf("__chat_cursor__", "session_list", "__chat_cursor__", "session_list"), methods)
    }

    @Test
    fun `a fresh cursor report is not repeated by the poll`() {
        client.refreshSessions()
        client.onInbound(resultFor(firstCallId(), "null"))
        client.onInbound(resultFor(lastCallId(), "[]"))
        clock += 60_000L

        client.refreshSessions()

        // Inside the freshness window the cursor is believed; only the list goes.
        val methods = sent.map { JSONObject(String(it, Charsets.UTF_8)).getString("method") }
        assertEquals(listOf("__chat_cursor__", "session_list", "session_list"), methods)
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

        assertNotice(SessionAction.Close, ActionOutcome.Refused)
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
    fun `spawn sends the arguments session_create needs and carries the created id back`() {
        client.spawn(dirPath = "x:\\coding\\gamepad-cli-hub", cliType = "claudecode", name = "kitchen")

        val params = JSONObject(String(sent.single(), Charsets.UTF_8)).getJSONObject("params")
        assertEquals("x:\\coding\\gamepad-cli-hub", params.getString("dirPath"))
        assertEquals("claudecode", params.getString("cliType"))
        assertEquals("kitchen", params.getString("name"))

        // The real wire shape: spawnCli answers {id: ...}, and that id is what
        // opens the new thread.
        client.onInbound(resultFor(lastCallId(), """{"id":"s9"}"""))
        assertNotice(SessionAction.Spawn, ActionOutcome.Done)
        assertEquals("s9", client.control.createdSessionId.value)
    }

    @Test
    fun `a blank name is omitted from the wire so the desktop names the session`() {
        client.spawn(dirPath = "/work", cliType = "claudecode", name = "  ")

        val params = JSONObject(String(sent.single(), Charsets.UTF_8)).getJSONObject("params")
        assertEquals("/work", params.getString("dirPath"))
        assertEquals("claudecode", params.getString("cliType"))
        assertFalse(params.has("name"))
    }

    @Test
    fun `a spawn answer that names no session does not pretend it did`() {
        client.spawn(dirPath = "/work", cliType = "claudecode", name = "")

        client.onInbound(resultFor(lastCallId(), """"not an object""""))

        // Done is still Done — the session exists — but navigation must not
        // guess at an id that never arrived.
        assertNotice(SessionAction.Spawn, ActionOutcome.Done)
        assertNull(client.control.createdSessionId.value)
    }

    @Test
    fun `the CLI catalogue is asked for as a bare tool_list call`() {
        client.refreshClis()

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("tool_list", record.getString("method"))
        assertFalse(record.has("params"))

        client.onInbound(
            resultFor(
                lastCallId(),
                """[{"cliType":"claudecode","name":"Claude Code","supportedDirPaths":["x:\\c"]},
                    {"cliType":"codex"}]""",
            ),
        )

        assertEquals(
            listOf(
                HelmCli("claudecode", "Claude Code", listOf("x:\\c")),
                HelmCli("codex", "codex", emptyList()),
            ),
            client.control.clis.value,
        )
    }

    @Test
    fun `a directory fetch that fails is state on the screen, not silence`() {
        client.refreshDirectories()

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals("Tool not permitted", client.control.directoriesError.value)

        // A retry supersedes the failure, and a good answer keeps it cleared.
        client.refreshDirectories()
        assertNull(client.control.directoriesError.value)
        client.onInbound(resultFor(lastCallId(), """[{"dirPath":"/work","name":"Work"}]"""))
        assertNull(client.control.directoriesError.value)
        assertEquals(listOf(HelmDirectory("/work", "Work")), client.control.directories.value)
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

    @Test
    fun `the artifact list is asked for per session and lands in the repository`() {
        client.refreshArtifacts("s1")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("session_artifact_list", record.getString("method"))
        assertEquals("s1", record.getJSONObject("params").getString("sessionId"))

        client.onInbound(
            resultFor(
                lastCallId(),
                """[{"id":"a1","title":"Report","kind":"markdown","versionCount":2,"createdAt":1,"updatedAt":2}]""",
            ),
        )

        val ready = client.artifacts.list.value as ArtifactList.Ready
        assertEquals("Report", ready.artifacts.single().title)
    }

    @Test
    fun `a failed artifact list is state on the screen, not silence`() {
        client.refreshArtifacts("s1")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        val failed = client.artifacts.list.value as ArtifactList.Failed
        assertEquals("Tool not permitted", failed.message)
    }

    @Test
    fun `an artifact read asks for the session, the id and the version together`() {
        client.readArtifact("s1", "a1", version = 3)

        val params = JSONObject(String(sent.single(), Charsets.UTF_8)).getJSONObject("params")
        assertEquals("s1", params.getString("sessionId"))
        assertEquals("a1", params.getString("artifactId"))
        // A NUMBER, like every other count on this link: the desktop reads the
        // version with a type check and ignores a quoted one.
        assertEquals(3, params.get("version"))
    }

    @Test
    fun `the version is omitted from the wire when the latest is wanted`() {
        client.readArtifact("s1", "a1", version = null)

        val params = JSONObject(String(sent.single(), Charsets.UTF_8)).getJSONObject("params")
        assertFalse(params.has("version"))
    }

    @Test
    fun `an artifact read result lands as metadata plus the one body`() {
        client.readArtifact("s1", "a1", version = null)
        client.onInbound(
            resultFor(
                lastCallId(),
                """{"id":"a1","title":"Report","kind":"markdown","versionCount":2,"createdAt":1,"updatedAt":2,""" +
                    """"requestedVersion":2,"requestedVersionContent":"# Report"}""",
            ),
        )

        val done = client.artifacts.read.value as ArtifactRead.Done
        assertEquals("Report", done.read.artifact.title)
        assertEquals("# Report", done.read.content)
    }

    @Test
    fun `an unreadable artifact read says so instead of loading forever`() {
        client.readArtifact("s1", "a1", version = null)

        client.onInbound(resultFor(lastCallId(), """{"items":[]}"""))

        assertTrue(client.artifacts.read.value is ArtifactRead.Failed)
    }

    // ---------------------------------------------------------- artifact writes

    @Test
    fun `a create asks for the markdown-only kind and names the session and body`() {
        client.createArtifact("s1", "  Note  ", "# body")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("session_artifact_create", record.getString("method"))
        val params = record.getJSONObject("params")
        assertEquals("s1", params.getString("sessionId"))
        assertEquals("Note", params.getString("title"))
        // 'md' — the desktop's session-addressed create refuses any other kind,
        // so a phone-authored artifact is markdown by construction.
        assertEquals("md", params.getString("kind"))
        assertEquals("# body", params.getString("content"))

        // The real wire shape: createArtifact answers the full Artifact, and the
        // id inside it is what opens the new artifact's detail screen.
        client.onInbound(resultFor(lastCallId(), """{"id":"a9","title":"Note","kind":"markdown","versions":[]}"""))
        assertNotice(SessionAction.CreateArtifact, ActionOutcome.Done)
        // The minted id is parked as a LANDING — the one-shot the artifacts
        // screens navigate on — because two identical notices must both count.
        assertEquals(
            ArtifactLanding(SessionAction.CreateArtifact, "a9"),
            client.control.artifactLanding.value,
        )
    }

    @Test
    fun `a create answer that names no artifact does not pretend it did`() {
        client.createArtifact("s1", "Note", "# body")

        client.onInbound(resultFor(lastCallId(), """"not an object""""))

        // Done is still Done — the artifact exists — but navigation must not
        // guess at an id that never arrived.
        assertNotice(SessionAction.CreateArtifact, ActionOutcome.Done)
        // A landing is parked even when the answer named no id, so the editor
        // still closes for the list, where the new row is one pull away.
        assertEquals(
            ArtifactLanding(SessionAction.CreateArtifact, null),
            client.control.artifactLanding.value,
        )
    }

    @Test
    fun `a body too big for the link is refused before the radio sees it`() {
        val big = "x".repeat(ArtifactRules.MAX_EDIT_ESCAPED_BYTES + 1)

        assertFalse(client.createArtifact("s1", "Note", big))
        assertEquals(SessionAction.CreateArtifact, client.control.notice.value!!.action)
        assertTrue(client.control.notice.value!!.outcome is ActionOutcome.Failed)

        assertFalse(client.reviseArtifact("s1", "a1", body(big)))
        assertEquals(SessionAction.ReviseArtifact, client.control.notice.value!!.action)
        assertTrue(client.control.notice.value!!.outcome is ActionOutcome.Failed)

        // An oversized frame tears the link — the one failure this app is worst
        // at — so an authored body that cannot fit never leaves the phone.
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `a revise sends the session, the artifact and the new body, and adds no second ask`() {
        client.reviseArtifact("s1", "a1", body("# v2"))

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("session_artifact_update", record.getString("method"))
        val params = record.getJSONObject("params")
        assertEquals("s1", params.getString("sessionId"))
        assertEquals("a1", params.getString("artifactId"))
        assertEquals("# v2", params.getString("content"))
        assertFalse("an unchanged title stays off the wire", params.has("title"))

        client.onInbound(resultFor(lastCallId(), """{"id":"a1","versions":[]}"""))
        assertNotice(SessionAction.ReviseArtifact, ActionOutcome.Done)
        // The artifacts screens re-pull on every visit, so a write adds no
        // refresh of its own — the next visit reconciles the list for free.
        assertEquals(1, sent.size)
    }

    /** A revise of artifact "Report" whose body was "# v1". */
    private fun body(content: String, title: String = "Report") =
        ArtifactRules.Revision("Report", "# v1", title, content)

    @Test
    fun `a rename sends the trimmed title, and an unchanged body stays off the wire`() {
        client.reviseArtifact("s1", "a1", body("# v1", title = "  Renamed "))

        val params = JSONObject(String(sent.single(), Charsets.UTF_8)).getJSONObject("params")
        assertEquals("Renamed", params.getString("title"))
        assertFalse("an unchanged body would append a duplicate version", params.has("content"))
    }

    @Test
    fun `a revise with nothing changed and nothing staged sends nothing`() {
        assertFalse(client.reviseArtifact("s1", "a1", body("# v1")))
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `a revise refusal is a rule, not a dropped link`() {
        client.reviseArtifact("s1", "a1", body("# v2"))

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertNotice(SessionAction.ReviseArtifact, ActionOutcome.Refused)
    }

    @Test
    fun `a delete is aimed at exactly one artifact and adds no second ask`() {
        client.deleteArtifact("s1", "a1")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("session_artifact_delete", record.getString("method"))
        val params = record.getJSONObject("params")
        assertEquals("s1", params.getString("sessionId"))
        assertEquals("a1", params.getString("artifactId"))
        // Targeted, and nothing else: there is no bulk delete on the wire and
        // this app must not grow one.
        assertEquals(setOf("sessionId", "artifactId"), params.keySet().toSet())

        client.onInbound(resultFor(lastCallId(), """{"id":"a1","deleted":true}"""))
        assertNotice(SessionAction.DeleteArtifact, ActionOutcome.Done)
        assertEquals(1, sent.size)
    }

    @Test
    fun `a delete refusal is a rule, not a dropped link`() {
        client.deleteArtifact("s1", "a1")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertNotice(SessionAction.DeleteArtifact, ActionOutcome.Refused)
    }

    @Test
    fun `a download fetches the file and stays quiet until it lands`() {
        client.downloadArtifact("s1", "a1", version = null)

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("session_artifact_download", record.getString("method"))
        val params = record.getJSONObject("params")
        assertEquals("s1", params.getString("sessionId"))
        assertEquals("a1", params.getString("artifactId"))
        assertFalse(params.has("version"))

        client.onInbound(
            blobFor(
                lastCallId(),
                filename = "Perf-report.md",
                mimeType = "text/markdown",
                body = "hello".toByteArray(Charsets.UTF_8),
                version = 2,
            ),
        )

        val ready = client.artifacts.save.value as ArtifactSave.Ready
        assertEquals("Perf-report.md", ready.file.filename)
        assertEquals("text/markdown", ready.file.mimeType)
        assertEquals("hello", String(ready.file.bytes, Charsets.UTF_8))
        // The bytes are on the phone, not on disk yet: a Done notice now would
        // claim a save that has not happened.
        assertNull(client.control.notice.value)
    }

    @Test
    fun `a download of one version asks for it as a number`() {
        client.downloadArtifact("s1", "a1", version = 3)

        assertEquals(3, JSONObject(String(sent.single(), Charsets.UTF_8)).getJSONObject("params").get("version"))
    }

    @Test
    fun `a refused download is a rule and leaves no file`() {
        client.downloadArtifact("s1", "a1")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertNotice(SessionAction.SaveArtifact, ActionOutcome.Refused)
        assertTrue(client.artifacts.save.value is ArtifactSave.Failed)
    }

    @Test
    fun `a download answer that is not a file says so`() {
        client.downloadArtifact("s1", "a1")

        client.onInbound(resultFor(lastCallId(), """{"items":[]}"""))

        assertTrue(client.artifacts.save.value is ArtifactSave.Failed)
    }

    @Test
    fun `a download with no link to carry it fails the ask`() {
        linked = false

        assertFalse(client.downloadArtifact("s1", "a1"))

        assertTrue(client.artifacts.save.value is ArtifactSave.Failed)
    }

    // -------------------------------------------------------- artifact attachments

    private fun attachment(sizeBytes: Long) =
        HelmArtifactAttachment(
            id = "att7",
            filename = "chart.png",
            contentType = "image/png",
            sizeBytes = sizeBytes,
            createdAtEpochMs = 1L,
        )

    private val attachmentKey = artifactAttachmentKey("a1", "att7")

    /**
     * THE REGRESSION. The desktop ALWAYS slices an attachment download and
     * defaults the length to one slice budget, so an ask with no offset answers
     * the FIRST slice only. This screen used to make exactly that ask and save
     * the answer as the whole file — which is why large images arrived corrupt.
     */
    @Test
    fun `an attachment download asks for a slice, with an offset and a length`() {
        client.downloadArtifactAttachment("s1", "a1", attachment(sizeBytes = 5))

        val record = JSONObject(String(sent.first(), Charsets.UTF_8))
        assertEquals("session_artifact_download", record.getString("method"))
        val params = record.getJSONObject("params")
        // attachmentId REPLACES version on the wire — the desktop refuses the two
        // together — and offset/length are what make the answer a known quantity.
        assertEquals(
            setOf("sessionId", "artifactId", "attachmentId", "offset", "length"),
            params.keySet().toSet(),
        )
        assertEquals("s1", params.getString("sessionId"))
        assertEquals("a1", params.getString("artifactId"))
        assertEquals("att7", params.getString("attachmentId"))
        assertEquals(0L, params.getLong("offset"))
        assertTrue(params.getInt("length") > 0)
    }

    @Test
    fun `an attachment bigger than one slice is fetched in more than one ask`() {
        // Three slices' worth over Bluetooth, which is the transport a test link
        // reports: one ask could only ever answer a third of it.
        val slice = ATTACHMENT_SLICE_BYTES_BLE
        client.downloadArtifactAttachment("s1", "a1", attachment(sizeBytes = slice * 3L))

        val offsets = sent.map { JSONObject(String(it, Charsets.UTF_8)).getJSONObject("params").getLong("offset") }
        assertTrue("a multi-slice file must take more than one ask", offsets.size > 1)
        assertEquals(listOf(0L, slice.toLong()), offsets.take(2))
    }

    @Test
    fun `an attachment's slices assemble into the file the sink is handed`() {
        val slice = ATTACHMENT_SLICE_BYTES_BLE
        val source = ByteArray(slice + 10) { (it % 251).toByte() }
        var saved: ByteArray? = null
        var savedName: String? = null
        client.saveAttachment = { name, _, bytes ->
            savedName = name
            saved = bytes
            SavedFile("Downloads/Helm/chart.png", "content://downloads/7")
        }

        client.downloadArtifactAttachment("s1", "a1", attachment(sizeBytes = source.size.toLong()))
        answerSlice(offsetOf(sent[0]), source, slice)
        answerSlice(offsetOf(sent[1]), source, slice)

        // Byte for byte, not merely the right length: a truncation that lands on
        // a slice boundary has the right prefix and the wrong file.
        assertTrue(source.contentEquals(saved))
        assertEquals("chart.png", savedName)
        assertEquals(
            PullState.Ready("Downloads/Helm/chart.png", "content://downloads/7"),
            client.artifacts.attachmentPulls.pullState(attachmentKey),
        )
    }

    @Test
    fun `a refused attachment download says so on the row it belongs to`() {
        client.downloadArtifactAttachment("s1", "a1", attachment(sizeBytes = 5))

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals(
            PullState.Failed("Tool not permitted"),
            client.artifacts.attachmentPulls.pullState(attachmentKey),
        )
        // The body download's save state is a different machine and is untouched:
        // an attachment is not what the Save row is narrating.
        assertEquals(ArtifactSave.Idle, client.artifacts.save.value)
    }

    /** Answer the ask at [offset] with the slice of [source] it named. */
    private fun answerSlice(offset: Long, source: ByteArray, slice: Int) {
        val from = offset.toInt()
        val to = minOf(from + slice, source.size)
        client.onInbound(
            blobFor(
                callIdAt(offset),
                filename = "chart.png",
                mimeType = "image/png",
                body = source.copyOfRange(from, to),
                offset = offset,
                total = source.size.toLong(),
                eof = to >= source.size,
            ),
        )
    }

    private fun offsetOf(frame: ByteArray): Long =
        JSONObject(String(frame, Charsets.UTF_8)).getJSONObject("params").getLong("offset")

    /** The call id of the ask that named [offset] — the pipeline has several out. */
    private fun callIdAt(offset: Long): String =
        sent.map { JSONObject(String(it, Charsets.UTF_8)) }
            .first { it.optJSONObject("params")?.optLong("offset", -1L) == offset }
            .getString("id")

    @Test
    fun `the artifact list hands the repository each artifact's attachments`() {
        client.refreshArtifacts("s1")

        client.onInbound(
            resultFor(
                lastCallId(),
                """[{"id":"a1","title":"Report","kind":"markdown","versionCount":1,"createdAt":1,"updatedAt":2,""" +
                    """"attachments":[{"id":"att1","filename":"chart.png","contentType":"image/png","sizeBytes":9,"createdAt":3}]}]""",
            ),
        )

        val ready = client.artifacts.list.value as ArtifactList.Ready
        val attachments = ready.artifacts.single().attachments
        assertEquals(listOf("att1"), attachments.map { it.id })
        assertEquals("chart.png", attachments.single().filename)
        assertEquals("image/png", attachments.single().contentType)
        assertEquals(9L, attachments.single().sizeBytes)
    }

    @Test
    fun `a re-read of a body already read shows the cached body while it refreshes`() {
        client.readArtifact("s1", "a1", version = null)
        client.onInbound(
            resultFor(
                lastCallId(),
                """{"id":"a1","title":"Report","kind":"markdown","versionCount":2,"createdAt":1,"updatedAt":2,""" +
                    """"requestedVersion":2,"requestedVersionContent":"# Report"}""",
            ),
        )

        client.readArtifact("s1", "a1", version = null)

        // The repository cached the answer; the re-ask surfaces it instead of a
        // blank Loading, and the fresh answer will overwrite it on arrival.
        val refreshing = client.artifacts.read.value as ArtifactRead.Refreshing
        assertEquals("# Report", refreshing.cached.content)
    }

    // ------------------------------------------------- plans, sequences, contexts

    /**
     * THE REGRESSION. The board once asked `plan_list filter=all`, which answers
     * every plan's full description: 419 KB for Helm's own project, ~820 chunks
     * on a 512-byte-chunk link, and the link died mid-transfer so the phone only
     * ever saw a timeout. The tool NAME and the FILTER are the two things that
     * broke, so they are the two things pinned here.
     */
    @Test
    fun `the plan board asks for summaries, never the full-record list`() {
        client.refreshPlans("/work")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("plan_summary", record.getString("method"))
        val params = record.getJSONObject("params")
        assertEquals("/work", params.getString("dirPath"))
        // 'active' is FIXED, not a default something could override: a done plan
        // is noise on a phone, and its description is payload the link has to
        // survive.
        assertEquals("active", params.getString("filter"))
        assertEquals(setOf("dirPath", "filter"), params.keySet().toSet())

        client.onInbound(
            resultFor(
                lastCallId(),
                """[{"id":"p1","humanId":"P-0007","title":"Wire it","status":"coding","blockedBy":["P-0006"]}]""",
            ),
        )

        val ready = client.plans.list.value as PlanList.Ready
        assertEquals("Wire it", ready.plans.single().title)
        assertEquals(PlanStatus.Coding, ready.plans.single().status)
        assertEquals(listOf("P-0006"), ready.plans.single().blockedBy)
    }

    @Test
    fun `a failed plan list is state on the screen, not silence`() {
        client.refreshPlans("/work")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals("Tool not permitted", (client.plans.list.value as PlanList.Failed).message)
    }

    @Test
    fun `an unreadable plan list says so instead of showing an empty board`() {
        client.refreshPlans("/work")

        client.onInbound(resultFor(lastCallId(), """{"items":[]}"""))

        assertTrue(client.plans.list.value is PlanList.Failed)
    }

    @Test
    fun `one plan is asked for by uuid, the only form plan_get takes`() {
        client.readPlan("p1")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("plan_get", record.getString("method"))
        assertEquals(setOf("uuid"), record.getJSONObject("params").keySet().toSet())
        assertEquals("p1", record.getJSONObject("params").getString("uuid"))

        client.onInbound(
            resultFor(lastCallId(), """{"id":"p1","dirPath":"/work","title":"Wire it","status":"review"}"""),
        )
        assertEquals("Wire it", (client.plans.detail.value as PlanDetail.Ready).plan.title)
    }

    @Test
    fun `a refused plan read is state on the screen`() {
        client.readPlan("p1")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals("Tool not permitted", (client.plans.detail.value as PlanDetail.Failed).message)
    }

    @Test
    fun `a plan's effective context refs are asked for by planId`() {
        client.refreshPlanContexts("p1")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("plan_context_list", record.getString("method"))
        assertEquals(setOf("planId"), record.getJSONObject("params").keySet().toSet())
        assertEquals("p1", record.getJSONObject("params").getString("planId"))

        client.onInbound(resultFor(lastCallId(), """[{"id":"c1","type":"Coding","source":"both"}]"""))
        val ready = client.plans.contextRefs.value as PlanContextRefs.Ready
        assertEquals("both", ready.refs.single().source)
    }

    @Test
    fun `a refused plan context list is state on the screen`() {
        client.refreshPlanContexts("p1")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals("Tool not permitted", (client.plans.contextRefs.value as PlanContextRefs.Failed).message)
    }

    @Test
    fun `sequences are asked for by directory, never one call per plan`() {
        client.refreshSequences("/work")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("sequence_list", record.getString("method"))
        assertEquals(setOf("dirPath"), record.getJSONObject("params").keySet().toSet())

        client.onInbound(
            resultFor(
                lastCallId(),
                """[{"id":"seq1","dirPath":"/work","title":"Lane","order":1,"memberPlanIds":["p1"]}]""",
            ),
        )

        val ready = client.sequences.list.value as SequenceList.Ready
        assertEquals(listOf("p1"), ready.sequences.single().memberPlanIds)
    }

    @Test
    fun `a failed sequence list is state on the screen`() {
        client.refreshSequences("/work")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals("Tool not permitted", (client.sequences.list.value as SequenceList.Failed).message)
    }

    @Test
    fun `one sequence is asked for by id`() {
        client.readSequence("seq1")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("sequence_get", record.getString("method"))
        assertEquals(setOf("id"), record.getJSONObject("params").keySet().toSet())
        assertEquals("seq1", record.getJSONObject("params").getString("id"))

        client.onInbound(resultFor(lastCallId(), """{"id":"seq1","dirPath":"/work","title":"Lane"}"""))
        assertEquals("Lane", (client.sequences.detail.value as SequenceDetail.Ready).sequence.title)
    }

    @Test
    fun `an unreadable sequence read says so instead of loading forever`() {
        client.readSequence("seq1")

        client.onInbound(resultFor(lastCallId(), """{"items":[]}"""))

        assertTrue(client.sequences.detail.value is SequenceDetail.Failed)
    }

    @Test
    fun `the project list is asked for as a bare project_list call`() {
        client.refreshProjects()

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("project_list", record.getString("method"))
        assertFalse(record.has("params"))

        client.onInbound(resultFor(lastCallId(), """[{"id":"proj1","name":"Helm","canonicalPath":"/h"}]"""))

        assertEquals(
            listOf(HelmProject("proj1", "Helm", "/h")),
            (client.contexts.projects.value as ProjectList.Ready).projects,
        )
    }

    @Test
    fun `a failed project list is state on the screen`() {
        client.refreshProjects()

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals("Tool not permitted", (client.contexts.projects.value as ProjectList.Failed).message)
    }

    @Test
    fun `context nodes are asked for by projectId`() {
        client.refreshContexts("proj1")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("context_list", record.getString("method"))
        assertEquals(setOf("projectId"), record.getJSONObject("params").keySet().toSet())

        client.onInbound(
            resultFor(
                lastCallId(),
                """[{"id":"c1","projectId":"proj1","title":"Notes","permission":"writable","content":"body"}]""",
            ),
        )

        val ready = client.contexts.list.value as ContextList.Ready
        assertEquals(ContextPermission.Writable, ready.contexts.single().permission)
    }

    @Test
    fun `a failed context list is state on the screen`() {
        client.refreshContexts("proj1")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals("Tool not permitted", (client.contexts.list.value as ContextList.Failed).message)
    }

    @Test
    fun `one context node is asked for by id and lands with its body`() {
        client.readContext("c1")

        val record = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("context_get", record.getString("method"))
        assertEquals(setOf("id"), record.getJSONObject("params").keySet().toSet())

        client.onInbound(
            resultFor(lastCallId(), """{"id":"c1","projectId":"proj1","title":"Notes","content":"Run it."}"""),
        )
        assertEquals("Run it.", (client.contexts.detail.value as ContextDetail.Ready).context.content)
    }

    @Test
    fun `a refused context read is state on the screen`() {
        client.readContext("c1")

        client.onInbound(errorFor(lastCallId(), "Tool not permitted"))

        assertEquals("Tool not permitted", (client.contexts.detail.value as ContextDetail.Failed).message)
    }

    /**
     * The correlation is what keeps three read surfaces apart. A plan answer and
     * a context answer are the same `result` record shape; only the pending id
     * says which repository is waiting for it.
     */
    @Test
    fun `an error routes to the surface that asked, and leaves the others alone`() {
        client.refreshPlans("/work")
        val plansCall = lastCallId()
        client.refreshContexts("proj1")
        val contextsCall = lastCallId()

        client.onInbound(errorFor(contextsCall, "Tool not permitted"))

        assertTrue(client.contexts.list.value is ContextList.Failed)
        assertTrue(client.plans.list.value is PlanList.Loading)

        client.onInbound(resultFor(plansCall, """[{"id":"p1","title":"Wire it"}]"""))
        assertTrue(client.plans.list.value is PlanList.Ready)
    }

    /** Helm's side of the wire, built with the same codec the desktop is pinned to. */
    @Test
    fun `link up reports the chat cursor the phone holds, as a number param`() {
        client.chats.receive(
            com.potatomotato.helm.wire.MobileRecord.Chat(
                sessionId = "s1", sessionName = "work", text = "kept", at = 1, seq = 12,
            ),
        )
        sent.clear()

        assertTrue(client.onLinkUp())

        val frame = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals("__chat_cursor__", frame.getString("method"))
        assertEquals(12L, frame.getJSONObject("params").getLong("seq"))
    }

    @Test
    fun `link up with nothing held reports a cursor of zero, asking for the whole journal`() {
        sent.clear()

        assertTrue(client.onLinkUp())

        val frame = JSONObject(String(sent.single(), Charsets.UTF_8))
        assertEquals(0L, frame.getJSONObject("params").getLong("seq"))
    }

    @Test
    fun `link up without a usable link reports nothing rather than throwing`() {
        linked = false

        assertFalse(client.onLinkUp())
        assertTrue(sent.isEmpty())
    }

    private fun resultFor(id: String, resultJson: String): ByteArray =
        """{"v":1,"t":"result","id":"$id","result":$resultJson}""".toByteArray(Charsets.UTF_8)

    /**
     * A binary download reply, built to the documented layout rather than with
     * the production encoder — these are download tests, and the encoder is the
     * upload direction's (pinned by MobileEnvelopeVectorsTest); a download test
     * that round-tripped through it would be testing itself.
     *
     *   marker | record version | uint16be header length | header | raw body
     */
    private fun blobFor(
        id: String,
        filename: String,
        mimeType: String,
        body: ByteArray,
        version: Int? = null,
        offset: Long? = null,
        total: Long? = null,
        eof: Boolean? = null,
    ): ByteArray {
        val header = StringBuilder()
            .append("""{"v":1,"t":"blob","id":"$id","filename":"$filename"""")
            .append(""","mimeType":"$mimeType","size":${body.size}""")
            .apply {
                if (version != null) append(""","version":$version""")
                if (offset != null) append(""","offset":$offset""")
                if (total != null) append(""","total":$total""")
                if (eof != null) append(""","eof":$eof""")
            }
            .append('}')
            .toString()
            .toByteArray(Charsets.UTF_8)
        return byteArrayOf(
            0xb1.toByte(),
            1,
            ((header.size shr 8) and 0xff).toByte(),
            (header.size and 0xff).toByte(),
        ) + header + body
    }

    private fun errorFor(id: String, message: String): ByteArray =
        """{"v":1,"t":"error","id":"$id","error":{"code":-32000,"message":"$message"}}""".toByteArray(Charsets.UTF_8)

    private fun chatBytes(
        sessionId: String,
        text: String,
        at: Long,
        kind: String? = null,
        seq: Long? = null,
        originId: String? = null,
    ): ByteArray =
        (StringBuilder("""{"v":1,"t":"chat","sessionId":"$sessionId","sessionName":"work","text":"$text","at":$at""")
            .apply {
                if (kind != null) append(""","kind":"$kind"""")
                if (seq != null) append(""","seq":$seq""")
                if (originId != null) append(""","originId":"$originId"""")
            }
            .append('}'))
            .toString()
            .toByteArray(Charsets.UTF_8)

    private fun lastCallId(): String = JSONObject(String(sent.last(), Charsets.UTF_8)).getString("id")

    private fun firstCallId(): String = JSONObject(String(sent.first(), Charsets.UTF_8)).getString("id")

    /**
     * The last notice said THIS action ended THIS way. The notice carries a
     * sequence nonce so the bar can tell a repeated outcome from the one before
     * it — that nonce is the repository's business, not what these tests claim.
     */
    private fun assertNotice(action: SessionAction, outcome: ActionOutcome) {
        with(client.control.notice.value!!) {
            assertEquals(action, this.action)
            assertEquals(outcome, this.outcome)
        }
    }

    /** Timeout control stays deterministic: tests advance it, never wall time. */
    private class TestScheduler : ChannelScheduler {
        private val tasks = ArrayDeque<() -> Unit>()
        var cancelled = 0
            private set

        override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
            var active = true
            tasks.add {
                if (active) action()
            }
            return Cancellable {
                if (active) {
                    active = false
                    cancelled++
                }
            }
        }

        fun runNext() = tasks.removeFirst().invoke()
    }
}
