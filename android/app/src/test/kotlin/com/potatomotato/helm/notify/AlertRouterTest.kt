package com.potatomotato.helm.notify

import com.potatomotato.helm.wire.MobileRecord
import org.junit.Test
import org.junit.Assert.assertEquals
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
}
