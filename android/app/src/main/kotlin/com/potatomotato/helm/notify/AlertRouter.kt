package com.potatomotato.helm.notify

import com.potatomotato.helm.wire.MobileRecord
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

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
 *     HC -->|kind absent| AM[onMessage]
 *     HC -->|kind present| AR[onAlert]
 *     AM & AR --> EN{enabled?}
 *     EN -->|yes| NP[NotificationPort]
 *     UI[HelmHome] -->|opened / visible / setEnabled| AR
 * ```
 *
 * Five decisions live here and nowhere else:
 *
 * A MESSAGE IS ALSO AN ALERT. A kind-LESS record is something an agent said, and
 * it goes to the thread AND the shade — one message told once on each surface,
 * the same shape as the ratified Telegram/app duplication. It is the only kind
 * the user can answer, which is why it alone carries a reply box.
 *
 * ONE MASTER SWITCH, NOT ONE PER KIND. Android already gives per-channel control
 * in system settings, which is why the channels exist at all; what it does not
 * give is a switch one tap from the screen the user is on. Turning it off takes
 * down what is already showing — see [setEnabled].
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

    private var settings: NotificationSettings = MemoryNotificationSettings()

    private val _enabled = MutableStateFlow(settings.enabled)

    /** What the main screen's toggle renders. */
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    /**
     * Attach the persistent store and adopt what it remembers.
     *
     * Assigned after construction for the same reason [port] is: the store needs
     * a Context and the client is built before there is one. Until it is called
     * the setting is in memory and defaults to on.
     */
    fun useSettings(store: NotificationSettings) {
        settings = store
        _enabled.value = store.enabled
    }

    /**
     * The master switch. Turning it OFF clears what is already on the shade —
     * rows left standing after the user silenced them read as the setting not
     * working, and there is no way to tell that apart from a bug.
     *
     * Turning it back ON replays nothing. A suppressed message is stale by then,
     * and buzzing for something said ten minutes ago misrepresents when it
     * happened; the thread has it either way.
     */
    fun setEnabled(value: Boolean) {
        _enabled.value = value
        settings.enabled = value
        if (!value) clearAll()
    }

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
        post(record, AlertKind.fromWire(record.kind ?: return))
    }

    /**
     * One kind-LESS chat record: something an agent said.
     *
     * Separate from [onAlert] rather than a branch inside it because the caller
     * already knows which it has — `HelmClient` splits on exactly this — and
     * because a message is the one alert the user can answer, which is a
     * difference the shade will show.
     *
     * The record still goes to the thread as well. This is an addition to the
     * conversation, not a diversion of it.
     */
    fun onMessage(record: MobileRecord.Chat) {
        post(record, AlertKind.Message)
    }

    private fun post(record: MobileRecord.Chat, kind: AlertKind) {
        val surface = port ?: return
        if (!_enabled.value) return
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

    /**
     * A reply went out from the shade. The row has done its job.
     *
     * It goes through the router rather than straight to the port so [showing]
     * stays truthful: a row cancelled behind the router's back would leave an
     * entry claiming to be on a shade it had already left, and the next alert
     * for that session would cancel a row that was not there.
     */
    fun replySent(sessionId: String) {
        val surface = port ?: return
        clearSession(surface, sessionId)
    }

    /**
     * A reply could not go out. The row says so, and keeps its box for a retry.
     *
     * The user is looking at a notification, not the thread — and the thread is
     * where `sendChat` already recorded the failure. Without this they would have
     * watched their reply disappear into a row that never changed.
     */
    fun replyFailed(sessionId: String, sessionName: String) {
        val surface = port ?: return
        if (sessionId.isBlank()) return
        val row = Alert(sessionId = sessionId, sessionName = sessionName, text = "", kind = AlertKind.Message)
        surface.replyFailed(row)
        showing[row.notificationId] = Row(sessionId, AlertKind.Message, null)
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
    private fun clearSession(surface: NotificationPort, sessionId: String) =
        clear(surface, showing.filterValues { it.sessionId == sessionId })

    /** Everything on the shade, for the master switch going off. */
    private fun clearAll() {
        val surface = port ?: return
        clear(surface, showing.toMap())
    }

    private fun clear(surface: NotificationPort, rows: Map<Int, Row>) {
        for ((id, row) in rows) {
            val sessionId = row.sessionId
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
