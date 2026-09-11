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
 * ONE ROW PER SESSION. The notification id is the session's, so a session that
 * buzzes ten times replaces its own row nine times. This is deliberately NOT the
 * same thing as the ratified duplication between Telegram and the app — that one
 * is two surfaces telling you once each, which is the point; ten rows from one
 * session is one surface telling you the same thing ten times, which is noise.
 *
 * NOTHING FOR WHAT YOU ARE LOOKING AT. An alert for the session already open in
 * the foreground is dropped: the user is reading the thing it would tell them
 * about. Backgrounded, the same alert posts — being out of the room is exactly
 * when this feature is for.
 *
 * A CHANNEL CHANGE IS A CANCEL FIRST. Android will not move a live notification
 * between channels, so a session going Attention -> Completion must take the old
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

    /** What each session is currently showing, so a channel change can clear it. */
    private val showing = mutableMapOf<String, AlertKind>()

    /**
     * One kind-bearing chat record.
     *
     * A record with no session id, no name or no body is dropped rather than
     * posted: a notification titled with an empty string tells the user something
     * happened and refuses to say what, which is worse than staying quiet. This is
     * the one place that judgement is made.
     */
    fun onAlert(record: MobileRecord.Chat) {
        val surface = port ?: return
        val kind = AlertKind.fromWire(record.kind ?: return)
        if (record.sessionId.isBlank() || record.sessionName.isBlank() || record.text.isBlank()) return

        if (appVisible && openSessionId == record.sessionId) {
            // Already being read. Clear anything left over from before it was opened.
            clear(surface, record.sessionId)
            return
        }

        if (showing[record.sessionId].let { it != null && it != kind }) surface.cancel(record.sessionId)
        surface.post(Alert.of(record.sessionId, record.sessionName, record.text, kind))
        showing[record.sessionId] = kind
    }

    /** The session the user has on screen, or null for the list. */
    fun opened(sessionId: String?) {
        openSessionId = sessionId
        val surface = port ?: return
        if (sessionId != null && appVisible) clear(surface, sessionId)
    }

    /** Whether the app is in front of the user at all. */
    fun visible(visible: Boolean) {
        appVisible = visible
        val surface = port ?: return
        val open = openSessionId
        if (visible && open != null) clear(surface, open)
    }

    private fun clear(surface: NotificationPort, sessionId: String) {
        if (showing.remove(sessionId) != null) surface.cancel(sessionId)
    }
}
