package com.potatomotato.helm.notify

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue

class AlertRouterTest {

    private val port = FakeNotificationPort()
    private val router = AlertRouter().also { it.port = port }

    private fun alert(
        sessionId: String = "s1",
        sessionName: String = "ble-transport",
        text: String = "Needs a decision",
        kind: String? = "attention",
        artifactId: String? = null,
    ) = MobileRecord.Chat(
        sessionId = sessionId,
        sessionName = sessionName,
        text = text,
        at = 1_700_000_000_000L,
        kind = kind,
        artifactId = artifactId,
    )

    @Test
    fun `posts an alert with the session name as its title`() {
        router.onAlert(alert())

        val shown = port.showing("s1")
        assertEquals("ble-transport", shown?.sessionName)
        assertEquals("Needs a decision", shown?.text)
        assertEquals(AlertKind.Attention, shown?.kind)
    }

    @Test
    fun `ten alerts from one session leave exactly one notification`() {
        repeat(10) { router.onAlert(alert(text = "attempt $it")) }

        assertEquals(1, port.shade.size)
        // The LAST one wins: a stale body under a fresh buzz is a lie about why
        // the phone vibrated.
        assertEquals("attempt 9", port.showing("s1")?.text)
    }

    @Test
    fun `two sessions keep their own notifications`() {
        router.onAlert(alert(sessionId = "s1", sessionName = "one"))
        router.onAlert(alert(sessionId = "s2", sessionName = "two"))

        assertEquals(2, port.shade.size)
        assertEquals("one", port.showing("s1")?.sessionName)
        assertEquals("two", port.showing("s2")?.sessionName)
    }

    @Test
    fun `a status alert is dropped beside existing attention content`() {
        router.onAlert(alert(kind = "attention"))
        port.calls.clear()

        router.onAlert(alert(kind = "completion"))

        assertTrue(port.calls.isEmpty())
        assertEquals(1, port.shade.size)
        assertEquals(AlertKind.Attention, port.showing("s1", AlertKind.Attention)?.kind)
    }

    @Test
    fun `message and attention rows coexist but status adds no noise`() {
        router.onMessage(message())
        router.onAlert(alert(kind = "attention"))
        port.calls.clear()

        router.onAlert(alert(kind = "idle"))
        router.onAlert(alert(kind = "completion"))

        assertTrue(port.calls.isEmpty())
        assertEquals(2, port.shade.size)
        assertEquals(AlertKind.Message, port.showing("s1", AlertKind.Message)?.kind)
        assertEquals(AlertKind.Attention, port.showing("s1", AlertKind.Attention)?.kind)
    }

    @Test
    fun `a repeat on the same channel replaces in place without a cancel`() {
        router.onAlert(alert(kind = "idle"))
        port.calls.clear()

        router.onAlert(alert(kind = "idle"))

        assertEquals(listOf("post:s1:Idle"), port.calls)
    }

    @Test
    fun `an alert with no session id is dropped rather than posted blank`() {
        router.onAlert(alert(sessionId = ""))
        router.onAlert(alert(sessionName = ""))
        router.onAlert(alert(text = "   "))

        assertTrue(port.shade.isEmpty())
        assertTrue(port.calls.isEmpty())
    }

    @Test
    fun `an unknown kind still buzzes, on the attention channel`() {
        // A newer desktop must never go silent on this phone: a kind we cannot
        // classify is still an event somebody chose to send.
        router.onAlert(alert(kind = "something-new"))

        assertEquals(AlertKind.Attention, port.showing("s1")?.kind)
    }

    @Test
    fun `nothing is posted for the session the user is already reading`() {
        router.viewed("s1")

        router.onAlert(alert())

        assertTrue(port.shade.isEmpty())
        assertTrue(port.calls.isEmpty())
    }

    @Test
    fun `a chat alerts again after its thread is no longer viewed`() {
        router.viewed("s1")
        router.viewed(null)

        router.onAlert(alert())

        assertEquals("ble-transport", port.showing("s1")?.sessionName)
    }

    @Test
    fun `another session alerts while one is open`() {
        router.viewed("s1")

        router.onAlert(alert(sessionId = "s2", sessionName = "two"))

        assertEquals("two", port.showing("s2")?.sessionName)
    }

    @Test
    fun `viewing a chat clears only that session's notification`() {
        router.onMessage(message(sessionId = "s1", sessionName = "one"))
        router.onMessage(message(sessionId = "s2", sessionName = "two"))

        router.viewed("s1")

        assertNull(port.showing("s1"))
        assertEquals("I have pushed the fix", port.showing("s2")?.text)
    }

    @Test
    fun `viewing a chat clears its notification`() {
        router.onAlert(alert())

        router.viewed("s1")

        assertNull(port.showing("s1"))
    }

    @Test
    fun `viewing no chat clears nothing`() {
        router.onAlert(alert())

        router.viewed(null)

        assertEquals("ble-transport", port.showing("s1")?.sessionName)
    }

    @Test
    fun `clearing content allows a later status row`() {
        router.onAlert(alert(kind = "attention"))
        router.viewed("s1")
        router.viewed(null)
        port.calls.clear()

        router.onAlert(alert(kind = "completion"))

        // The status row may appear once no content row remains.
        assertEquals(listOf("post:s1:Completion"), port.calls)
    }

    @Test
    fun `alerts received before port attachment are replayed once`() {
        val detached = AlertRouter()
        val attached = FakeNotificationPort()

        detached.onAlert(alert())
        detached.port = attached
        detached.port = attached

        assertEquals(1, attached.shade.size)
        assertEquals("Needs a decision", attached.showing("s1")?.text)
    }

    @Test
    fun `queued status is dropped when content arrives before the port attaches`() {
        val detached = AlertRouter()
        val attached = FakeNotificationPort()
        detached.onAlert(alert(kind = "completion"))
        detached.onMessage(message())

        detached.port = attached

        assertEquals(1, attached.shade.size)
        assertEquals(AlertKind.Message, attached.showing("s1", AlertKind.Message)?.kind)
    }

    @Test
    fun `an artifact notice routes to the artifact channel and carries its id`() {
        router.onAlert(alert(kind = "artifact", text = "Perf report", artifactId = "a1"))

        val shown = port.showing("s1", artifactId = "a1")
        assertEquals(AlertKind.Artifact, shown?.kind)
        assertEquals("Perf report", shown?.text)
    }

    @Test
    fun `distinct artifacts from one session stack rather than overwrite`() {
        router.onAlert(alert(kind = "artifact", text = "One", artifactId = "a1"))
        router.onAlert(alert(kind = "artifact", text = "Two", artifactId = "a2"))

        assertEquals(2, port.shade.size)
        assertEquals("One", port.showing("s1", artifactId = "a1")?.text)
        assertEquals("Two", port.showing("s1", artifactId = "a2")?.text)
    }

    @Test
    fun `the same artifact twice replaces its own row`() {
        router.onAlert(alert(kind = "artifact", text = "Report", artifactId = "a1"))
        router.onAlert(alert(kind = "artifact", text = "Report (revised)", artifactId = "a1"))

        assertEquals(1, port.shade.size)
        assertEquals("Report (revised)", port.showing("s1", artifactId = "a1")?.text)
    }

    @Test
    fun `an artifact row does not evict the session's own row`() {
        router.onAlert(alert(kind = "completion"))
        router.onAlert(alert(kind = "artifact", text = "Report", artifactId = "a1"))

        assertEquals(2, port.shade.size)
        assertEquals(AlertKind.Completion, port.showing("s1")?.kind)
    }

    @Test
    fun `viewing a chat clears its artifact rows for that session`() {
        router.onAlert(alert(kind = "artifact", text = "Report", artifactId = "a1"))

        router.viewed("s1")

        assertNull(port.showing("s1", artifactId = "a1"))
    }

    @Test
    fun `an artifact for the viewed session is not posted`() {
        router.viewed("s1")

        router.onAlert(alert(kind = "artifact", text = "Report", artifactId = "a1"))

        assertTrue(port.shade.isEmpty())
    }

    @Test
    fun `another session's artifact still posts while one session is open`() {
        router.viewed("s1")

        router.onAlert(alert(sessionId = "s2", kind = "artifact", text = "Report", artifactId = "a1"))

        assertEquals("Report", port.showing("s2", artifactId = "a1")?.text)
    }

    @Test
    fun `an artifact record without an id is dropped rather than posted unfindable`() {
        // A row nobody can cancel later is a permanent resident of the shade.
        router.onAlert(alert(kind = "artifact", text = "Report", artifactId = null))

        assertTrue(port.shade.isEmpty())
    }

    // ---- plain messages ----------------------------------------------------
    //
    // A kind-BEARING record is an event Helm is reporting; a kind-less one is
    // something an agent actually said. Until now the second buzzed nothing at
    // all, which meant the phone stayed silent for the only record type the user
    // can answer.

    private fun message(
        sessionId: String = "s1",
        sessionName: String = "ble-transport",
        text: String = "I have pushed the fix",
        replay: Boolean = false,
    ) = alert(sessionId = sessionId, sessionName = sessionName, text = text, kind = null)
        .copy(replay = replay)

    @Test
    fun `a message posts a row on the message channel`() {
        router.onMessage(message())

        val shown = port.showing("s1")
        assertEquals("ble-transport", shown?.sessionName)
        assertEquals("I have pushed the fix", shown?.text)
        assertEquals(AlertKind.Message, shown?.kind)
    }

    @Test
    fun `a session's messages replace one another rather than stacking`() {
        repeat(5) { router.onMessage(message(text = "line $it")) }

        assertEquals(1, port.shade.size)
        assertEquals("line 4", port.showing("s1")?.text)
    }

    @Test
    fun `nothing is posted for a message in the session being read`() {
        router.viewed("s1")

        router.onMessage(message())

        assertTrue(port.shade.isEmpty())
    }

    @Test
    fun `a message with nothing to show is dropped rather than posted blank`() {
        router.onMessage(message(sessionId = ""))
        router.onMessage(message(sessionName = ""))
        router.onMessage(message(text = "  "))

        assertTrue(port.shade.isEmpty())
    }

    /**
     * A record streamed from the desktop's journal during catch-up is old news
     * the PHONE asked to be given — buzzing for a backlog misrepresents when it
     * happened. It must still reach the thread and the unread count, which is
     * [com.potatomotato.helm.link.HelmClient]'s job before the router is consulted.
     */
    @Test
    fun `a replayed catch-up message files without a buzz`() {
        router.onMessage(message(text = "from this morning", replay = true))

        assertTrue(port.shade.isEmpty())
    }

    @Test
    fun `a live message after a replay still buzzes`() {
        router.onMessage(message(text = "old", replay = true))
        router.onMessage(message(text = "fresh"))

        assertEquals("fresh", port.showing("s1")?.text)
    }

    // ---- replying from the shade -------------------------------------------

    @Test
    fun `a sent reply takes its row down`() {
        router.onMessage(message())

        router.replySent("s1")

        assertNull(port.showing("s1"))
    }

    @Test
    fun `a sent reply leaves other sessions alone`() {
        router.onMessage(message())
        router.onMessage(message(sessionId = "s2", sessionName = "two"))

        router.replySent("s1")

        assertEquals("two", port.showing("s2")?.sessionName)
    }

    @Test
    fun `a failed reply rewrites the row rather than leaving it unchanged`() {
        router.onMessage(message())
        port.calls.clear()

        router.replyFailed("s1", "ble-transport")

        // The user typed into a box and it vanished. Saying nothing here is the
        // silent drop this whole path exists to avoid.
        assertEquals(listOf("replyFailed:s1"), port.calls)
        assertEquals("ble-transport", port.showing("s1")?.sessionName)
    }

    /**
     * The reason [AlertRouter.replySent] exists at all rather than the receiver
     * cancelling the row itself: a row taken down behind the router's back would
     * leave bookkeeping claiming it was still up, and the next alert would spend
     * a cancel on a row that had already gone.
     */
    @Test
    fun `a session that was replied to posts cleanly next time`() {
        router.onMessage(message())
        router.replySent("s1")
        port.calls.clear()

        router.onAlert(alert(kind = "completion"))

        assertEquals(listOf("post:s1:Completion"), port.calls)
    }

    @Test
    fun `a row left by a failed reply is cleared by viewing the chat`() {
        router.replyFailed("s1", "ble-transport")

        router.viewed("s1")

        assertNull(port.showing("s1"))
    }

    // ---- the master toggle -------------------------------------------------

    @Test
    fun `notifications are on for a phone that has never been told otherwise`() {
        assertTrue(router.enabled.value)
    }

    @Test
    fun `nothing is posted at all while notifications are off`() {
        router.setEnabled(false)

        router.onMessage(message())
        router.onAlert(alert(kind = "attention"))
        router.onAlert(alert(kind = "artifact", text = "Report", artifactId = "a1"))

        assertTrue(port.shade.isEmpty())
    }

    @Test
    fun `turning notifications off takes down the rows already showing`() {
        router.onAlert(alert(kind = "attention"))
        router.onAlert(alert(sessionId = "s2", kind = "artifact", text = "Report", artifactId = "a1"))

        router.setEnabled(false)

        // Leaving them up would be the setting visibly not working: the user
        // turned the buzzing off and the evidence of it is still on the screen.
        assertTrue(port.shade.isEmpty())
    }

    @Test
    fun `turning notifications back on posts the next one`() {
        router.setEnabled(false)
        router.onMessage(message())

        router.setEnabled(true)
        router.onMessage(message(text = "the next one"))

        // The suppressed message is NOT replayed: it is stale by now, and a
        // buzz for something said ten minutes ago is a lie about when.
        assertEquals(1, port.shade.size)
        assertEquals("the next one", port.showing("s1")?.text)
    }

    @Test
    fun `the choice is written through to the store`() {
        val store = MemoryNotificationSettings()
        val persisting = AlertRouter().also { it.port = port; it.useSettings(store) }

        persisting.setEnabled(false)

        assertFalse(store.enabled)
    }

    @Test
    fun `a router adopts what the store already remembers`() {
        val store = MemoryNotificationSettings().also { it.enabled = false }

        val restored = AlertRouter().also { it.port = port; it.useSettings(store) }

        assertFalse(restored.enabled.value)
        restored.onMessage(message())
        assertTrue("a remembered OFF must survive a restart", port.shade.isEmpty())
    }
}
