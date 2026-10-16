package com.potatomotato.helm.notify

/**
 * The notification surface, recorded rather than drawn.
 *
 * A fake and not a mock for the usual reason in this codebase: what is worth
 * asserting is the SEQUENCE the router produces — same-row updates, nothing at
 * all while the user is already reading the session —
 * and a verify() call per interaction would assert the calls happened without
 * ever saying what the user ends up looking at. [shade] is that: the notifications
 * a real phone would currently be showing.
 */
class FakeNotificationPort : NotificationPort {

    /** Every call in order, so updates, clears and added rows are distinguishable. */
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

    override fun replyFailed(alert: Alert) {
        calls += "replyFailed:${rowKey(alert)}"
        shade[alert.notificationId] = alert
    }

    /** The latest alert row for a session, or null when nothing is showing. */
    fun showing(sessionId: String): Alert? =
        shade.values.lastOrNull { it.sessionId == sessionId && it.artifactId == null }

    /** The row for one session and kind. */
    fun showing(sessionId: String, kind: AlertKind): Alert? =
        shade.values.firstOrNull { it.sessionId == sessionId && it.kind == kind }

    /** The alert currently shown for one of the session's artifact rows. */
    fun showing(sessionId: String, artifactId: String): Alert? =
        shade.values.firstOrNull { it.sessionId == sessionId && it.artifactId == artifactId }

    /** What the call log names a row: the session, or the session plus its artifact. */
    private fun rowKey(alert: Alert): String =
        alert.artifactId?.let { "${alert.sessionId}#$it" } ?: alert.sessionId
}
