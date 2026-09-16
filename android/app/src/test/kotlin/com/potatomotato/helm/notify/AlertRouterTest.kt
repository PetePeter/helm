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
    fun `a change of channel cancels before posting so the notification does not strand`() {
        router.onAlert(alert(kind = "attention"))
        port.calls.clear()

        router.onAlert(alert(kind = "completion"))

        // Android will not move a live notification to another channel; without
        // the cancel the old row survives under the old channel forever.
        assertEquals(listOf("cancel:s1", "post:s1:Completion"), port.calls)
        assertEquals(1, port.shade.size)
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
        router.visible(true)
        router.opened("s1")

        router.onAlert(alert())

        assertTrue(port.shade.isEmpty())
    }

    @Test
    fun `an open session still alerts once the app is backgrounded`() {
        router.visible(true)
        router.opened("s1")
        router.visible(false)

        router.onAlert(alert())

        assertEquals("ble-transport", port.showing("s1")?.sessionName)
    }

    @Test
    fun `another session alerts while one is open`() {
        router.visible(true)
        router.opened("s1")

        router.onAlert(alert(sessionId = "s2", sessionName = "two"))

        assertEquals("two", port.showing("s2")?.sessionName)
    }

    @Test
    fun `opening a session clears its notification`() {
        router.onAlert(alert())
        router.visible(true)

        router.opened("s1")

        assertNull(port.showing("s1"))
    }

    @Test
    fun `returning to the list clears nothing that was never opened`() {
        router.onAlert(alert())
        router.visible(true)

        router.opened(null)

        assertEquals("ble-transport", port.showing("s1")?.sessionName)
    }

    @Test
    fun `a channel change is forgotten when the notification is cleared`() {
        router.onAlert(alert(kind = "attention"))
        router.visible(true)
        router.opened("s1")
        router.opened(null)
        port.calls.clear()

        router.onAlert(alert(kind = "completion"))

        // No stale cancel for a row the user already dismissed by reading it.
        assertEquals(listOf("post:s1:Completion"), port.calls)
    }

    @Test
    fun `alerts are dropped, not queued, while no port is attached`() {
        val detached = AlertRouter()

        detached.onAlert(alert())
        detached.port = port

        // A notification for something that happened before the app had a
        // notification surface is stale by the time it could be shown.
        assertTrue(port.shade.isEmpty())
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
    fun `opening the session clears its artifact rows with it`() {
        router.onAlert(alert(kind = "artifact", text = "Report", artifactId = "a1"))
        router.visible(true)

        router.opened("s1")

        assertNull(port.showing("s1", artifactId = "a1"))
    }

    @Test
    fun `an artifact for the session on screen is not posted`() {
        router.visible(true)
        router.opened("s1")

        router.onAlert(alert(kind = "artifact", text = "Report", artifactId = "a1"))

        assertTrue(port.shade.isEmpty())
    }

    @Test
    fun `another session's artifact still posts while one session is open`() {
        router.visible(true)
        router.opened("s1")

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
    ) = alert(sessionId = sessionId, sessionName = sessionName, text = text, kind = null)

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
        router.visible(true)
        router.opened("s1")

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
    fun `a row left by a failed reply is cleared by opening the session`() {
        router.replyFailed("s1", "ble-transport")
        router.visible(true)

        router.opened("s1")

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
