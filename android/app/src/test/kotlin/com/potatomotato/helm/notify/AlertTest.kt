package com.potatomotato.helm.notify

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue

class AlertTest {

    @Test
    fun `the notification id is keyed on the session and row kind`() {
        val message = Alert.notificationId("s1", AlertKind.Message)
        val attention = Alert.notificationId("s1", AlertKind.Attention)

        assertEquals(message, Alert.notificationId("s1", AlertKind.Message))
        assertNotEquals(message, attention)
        assertNotEquals(message, Alert.notificationId("s2", AlertKind.Message))
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
    fun `a session row keeps its id when its body is updated`() {
        val before = Alert.of("s1", "work", "x", AlertKind.Idle)
        val after = Alert.of("s1", "work", "updated", AlertKind.Idle)

        assertEquals(before.notificationId, after.notificationId)
    }

    @Test
    fun `all alert ids stay above the fixed reserved range`() {
        val ids = AlertKind.entries.map { Alert.notificationId("s1", it) }

        assertTrue(ids.all { it > Alert.RESERVED_NOTIFICATION_ID_MAX })
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

}
