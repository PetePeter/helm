package com.potatomotato.helm.notify

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue

class AlertTest {

    @Test
    fun `the notification id is keyed on the session and nothing else`() {
        // This is what makes ten buzzes collapse to one row. Key it on the kind
        // or the timestamp and the phone stacks instead of replacing.
        assertEquals(Alert.notificationId("s1"), Alert.notificationId("s1"))
        assertNotEquals(Alert.notificationId("s1"), Alert.notificationId("s2"))
    }

    @Test
    fun `an artifact alert is keyed on the artifact, not the session`() {
        // Distinct artifacts from ONE session must stack — two reports revised at
        // once are two things to read. Keyed on the session alone, the second
        // would silently overwrite the first.
        val one = Alert.of("s1", "work", "One", AlertKind.Artifact, artifactId = "a1")
        val two = Alert.of("s1", "work", "Two", AlertKind.Artifact, artifactId = "a2")

        assertNotEquals(one.notificationId, two.notificationId)
    }

    @Test
    fun `the same artifact keeps its row so a revision replaces rather than stacks`() {
        val before = Alert.of("s1", "work", "Report", AlertKind.Artifact, artifactId = "a1")
        val after = Alert.of("s1", "work", "Report (revised)", AlertKind.Artifact, artifactId = "a1")

        assertEquals(before.notificationId, after.notificationId)
    }

    @Test
    fun `a session alert without an artifact keeps the id it always had`() {
        // The session-only derivation is unchanged: notifications posted by the
        // previous build must still be reachable by this one.
        assertEquals(Alert.notificationId("s1"), Alert.of("s1", "work", "x", AlertKind.Idle).notificationId)
    }

    @Test
    fun `the notification id never collides with the foreground service`() {
        // HelmLinkService owns id 1 permanently; colliding would replace the
        // ongoing link notification with an alert and take the service's row away.
        val ids = listOf("s1", "s2", "a-much-longer-session-uuid", "").map(Alert::notificationId)
        assertTrue(ids.none { it == FOREGROUND_SERVICE_NOTIFICATION_ID })
    }

    @Test
    fun `a long body is shortened to what a lock screen shows`() {
        val alert = Alert.of("s1", "name", "x".repeat(400), AlertKind.Attention)

        assertTrue(alert.text.length <= Alert.MAX_BODY)
        assertTrue(alert.text.endsWith(Alert.ELLIPSIS))
    }

    @Test
    fun `a body that fits is left exactly as sent`() {
        val body = "Needs a decision: retransmit, or surface and retry?"

        assertEquals(body, Alert.of("s1", "name", body, AlertKind.Attention).text)
    }

    @Test
    fun `a body is flattened to one line`() {
        // A lock-screen row collapses newlines anyway; doing it here means the
        // truncation budget is spent on words rather than on invisible breaks.
        val alert = Alert.of("s1", "name", "first\n\nsecond\tthird", AlertKind.Attention)

        assertEquals("first second third", alert.text)
    }

    @Test
    fun `only attention wears the flash colour`() {
        assertEquals(listOf(AlertKind.Attention), AlertKind.entries.filter { it.isFlash })
    }

    @Test
    fun `each kind owns its own channel so they can be silenced apart`() {
        assertEquals(AlertKind.entries.size, AlertKind.entries.map { it.channelId }.toSet().size)
    }

    @Test
    fun `an artifact kind routes to its own channel, not the attention fallback`() {
        // 'artifact' is a fourth wire value the desktop sends; it is classified,
        // not unknown. The fallback is for kinds this build has never met.
        assertEquals(AlertKind.Artifact, AlertKind.fromWire("artifact"))
    }

    private companion object {
        /** Mirrors HelmLinkService's NOTIFICATION_ID; see the collision test. */
        const val FOREGROUND_SERVICE_NOTIFICATION_ID = 1
    }
}
