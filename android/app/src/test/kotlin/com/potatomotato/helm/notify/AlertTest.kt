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

    private companion object {
        /** Mirrors HelmLinkService's NOTIFICATION_ID; see the collision test. */
        const val FOREGROUND_SERVICE_NOTIFICATION_ID = 1
    }
}
