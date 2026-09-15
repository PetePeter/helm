package com.potatomotato.helm.notify

import com.potatomotato.helm.wire.MobileRecord

/**
 * AlertRouter — what the phone does when Helm says something happened.
 *
 * This is the payoff for choosing BLE: a GATT notify reaches the already-running
 * foreground service and becomes a lock-screen row, with no cloud, no APNs and no
 * Telegram in the path.
 *
 * ```mermaid
 * graph LR
 *     HC[HelmClient<br/>chat record] -->|kind absent| CR[ChatRepository<br/>the thread]
 *     HC -->|kind present| AR[AlertRouter]
 *     AR --> NP[NotificationPort]
 *     UI[HelmHome] -->|opened / visible| AR
 * ```
 *
 * Three decisions live here and nowhere else:
 *
 * ONE ROW PER SESSION — OR PER ARTIFACT WITHIN IT. The notification id is the
 * session's, so a session that buzzes ten times replaces its own row nine times.
 * An ARTIFACT notice instead keys on the artifact id: distinct artifacts from one
 * session stack (two reports revised at once are two things to read) while the
 * same artifact revised twice replaces its own row. This is deliberately NOT the
 * same thing as the ratified duplication between Telegram and the app — that one
 * is two surfaces telling you once each, which is the point; ten rows from one
 * session is one surface telling you the same thing ten times, which is noise.
 *
 * NOTHING FOR WHAT YOU ARE LOOKING AT. An alert for the session already open in
 * the foreground is dropped: the user is reading the thing it would tell them
 * about. Backgrounded, the same alert posts — being out of the room is exactly
 * when this feature is for. Opening the session clears its rows too, artifact
 * rows included.
 *
 * A CHANNEL CHANGE IS A CANCEL FIRST. Android will not move a live notification
 * between channels, so a row going Attention -> Completion must take the old
 * row down or it strands under a channel the user may have silenced.
 *
 * Deliberately free of Android types. [port] is assigned once the app has a
 * Context, the same way [com.potatomotato.helm.ble.HelmLink.sender] is.
 */
class AlertRouter {

    /** Null until the app is up. Alerts that arrive before then are DROPPED. */
    var port: NotificationPort? = null

    private var openSessionId: String? = null
    private var appVisible = false

    /** Which session each live row belongs to, what it is showing, and whose it is. */
    private data class Row(val sessionId: String, val kind: AlertKind, val artifactId: String?)

    /**
     * What is on the shade right now, keyed by notification id — the id IS the
     * row's identity, which is exactly what lets a session hold one row of its
     * own plus one per artifact without any second bookkeeping.
     */
    private val showing = mutableMapOf<Int, Row>()

    /**
     * One kind-bearing chat record.
     *
     * A record with no session id, no name or no body is dropped rather than
     * posted: a notification titled with an empty string tells the user something
     * happened and refuses to say what, which is worse than staying quiet. This is
     * the one place that judgement is made. An ARTIFACT record additionally
     * demands its artifact id: a row keyed without one could never be cancelled,
     * because nobody could derive its identity again.
     */
    fun onAlert(record: MobileRecord.Chat) {
        val surface = port ?: return
        val kind = AlertKind.fromWire(record.kind ?: return)
        if (record.sessionId.isBlank() || record.sessionName.isBlank() || record.text.isBlank()) return
        if (kind == AlertKind.Artifact && record.artifactId.isNullOrBlank()) return

        if (appVisible && openSessionId == record.sessionId) {
            // Already being read. Clear anything left over from before it was opened.
            clearSession(surface, record.sessionId)
            return
        }

        val alert = Alert.of(record.sessionId, record.sessionName, record.text, kind, record.artifactId)
        val shown = showing[alert.notificationId]
        if (shown != null && shown.kind != kind) surface.cancel(alert)
        surface.post(alert)
        showing[alert.notificationId] = Row(record.sessionId, kind, record.artifactId)
    }

    /** The session the user has on screen, or null for the list. */
    fun opened(sessionId: String?) {
        openSessionId = sessionId
        val surface = port ?: return
        if (sessionId != null && appVisible) clearSession(surface, sessionId)
    }

    /** Whether the app is in front of the user at all. */
    fun visible(visible: Boolean) {
        appVisible = visible
        val surface = port ?: return
        val open = openSessionId
        if (visible && open != null) clearSession(surface, open)
    }

    /** Every row this session currently holds — its own, and one per artifact. */
    private fun clearSession(surface: NotificationPort, sessionId: String) {
        val rows = showing.filterValues { it.sessionId == sessionId }
        for ((id, row) in rows) {
            showing.remove(id)
            // The port cancels BY ROW, so the identity rides in an Alert — the
            // artifact id included, because without it the id derivation would
            // produce the session's own row and clear the wrong one. The body
            // was the buzz's business, not the cancel's.
            surface.cancel(
                Alert(sessionId = sessionId, sessionName = "", text = "", kind = row.kind, artifactId = row.artifactId),
            )
        }
    }
}
