package com.potatomotato.helm.notify

/**
 * The notification surface, recorded rather than drawn.
 *
 * A fake and not a mock for the usual reason in this codebase: what is worth
 * asserting is the SEQUENCE the router produces — a cancel before a post when the
 * channel moves, nothing at all while the user is already reading the session —
 * and a verify() call per interaction would assert the calls happened without
 * ever saying what the user ends up looking at. [shade] is that: the notifications
 * a real phone would currently be showing.
 */
class FakeNotificationPort : NotificationPort {

    /** Every call in order, so a cancel-then-post is distinguishable from a post. */
    val calls = mutableListOf<String>()

    /** What is on the phone right now, keyed by notification id. */
    val shade = linkedMapOf<Int, Alert>()

    override fun post(alert: Alert) {
        calls += "post:${rowKey(alert)}:${alert.kind}"
        shade[alert.notificationId] = alert
    }

    override fun cancel(alert: Alert) {
        calls += "cancel:${rowKey(alert)}"
        shade.remove(alert.notificationId)
    }

    /** The alert currently shown for a session's own row, or null when nothing is. */
    fun showing(sessionId: String): Alert? = shade[Alert.notificationId(sessionId)]

    /** The alert currently shown for one of the session's artifact rows. */
    fun showing(sessionId: String, artifactId: String): Alert? =
        shade[Alert.notificationId(sessionId, artifactId)]

    /** What the call log names a row: the session, or the session plus its artifact. */
    private fun rowKey(alert: Alert): String =
        alert.artifactId?.let { "${alert.sessionId}#$it" } ?: alert.sessionId
}
