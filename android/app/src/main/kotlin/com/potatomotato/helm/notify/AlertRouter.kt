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
 * ONE ROW PER SESSION AND KIND — OR PER ARTIFACT WITHIN IT. Repeats of one kind
 * update in place, while Message and Attention may coexist. Artifact rows also
 * key on artifact id so distinct artifacts stack and revisions replace their own.
 *
 * NOTHING FOR WHAT YOU ARE LOOKING AT. The UI reports a session as viewed only
 * while RESUMED and window-focused. An alert in that session is ignored without
 * cancelling rows; viewing the thread itself clears its existing rows.
 *
 * CONTENT BEFORE STATUS. Message and Attention rows may coexist. Idle and
 * Completion rows are dropped while either content row is showing. Row kinds
 * have separate ids, so posting one never evicts another or crosses channels.
 *
 * Deliberately free of Android types. [port] is assigned once the app has a
 * Context, the same way [com.potatomotato.helm.ble.HelmLink.sender] is.
 */
class AlertRouter {

    /** Alerts held until the app attaches the notification surface. */
    private val pending = linkedMapOf<Int, Alert>()

    /** Null until the app is up; queued rows are replayed once when it attaches. */
    var port: NotificationPort? = null
        set(value) {
            field = value
            if (value != null && pending.isNotEmpty()) {
                val queued = pending.values.toList()
                pending.clear()
                queued.filter { it.kind.isContent }.forEach(::post)
                queued.filterNot { it.kind.isContent }.forEach(::post)
            }
        }

    private var viewedSessionId: String? = null

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
        if (!value) {
            pending.clear()
            clearAll()
        }
    }

    /** Which session each live row belongs to, what it is showing, and whose it is. */
    private data class Row(val sessionId: String, val kind: AlertKind, val artifactId: String?)

    /**
     * What is on the shade right now, keyed by notification id — the id IS the
     * row's identity, so a session can hold content rows and artifact rows without
     * any second bookkeeping.
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
        // A replay is the backlog THIS PHONE asked the desktop to be given — old
        // news by construction, and buzzing for it would misrepresent when it
        // happened. The record has already reached the thread and the unread
        // count in HelmClient before this line; only the buzz is suppressed.
        if (record.replay) return
        post(record, AlertKind.Message)
    }

    private fun post(record: MobileRecord.Chat, kind: AlertKind) {
        if (!_enabled.value) return
        if (record.sessionId.isBlank() || record.sessionName.isBlank() || record.text.isBlank()) return
        if (kind == AlertKind.Artifact && record.artifactId.isNullOrBlank()) return

        post(Alert.of(record.sessionId, record.sessionName, record.text, kind, record.artifactId))
    }

    private fun post(alert: Alert) {
        if (!_enabled.value || viewedSessionId == alert.sessionId) return
        if (alert.kind.isStatus && hasContentRow(alert.sessionId)) return

        val surface = port
        if (surface == null) {
            pending[alert.notificationId] = alert
            return
        }
        surface.post(alert)
        showing[alert.notificationId] = Row(alert.sessionId, alert.kind, alert.artifactId)
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
        pending.entries.removeAll { it.value.sessionId == sessionId }
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

    /** The chat thread actually displayed to the user, or null when none is visible. */
    fun viewed(sessionId: String?) {
        viewedSessionId = sessionId
        if (sessionId == null) return
        pending.entries.removeAll { it.value.sessionId == sessionId }
        val surface = port ?: return
        clearSession(surface, sessionId)
    }

    private fun hasContentRow(sessionId: String): Boolean =
        showing.values.any { it.sessionId == sessionId && it.kind.isContent } ||
            pending.values.any { it.sessionId == sessionId && it.kind.isContent }

    /** Every row this session currently holds: each kind and each artifact. */
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

private val AlertKind.isContent: Boolean
    get() = this == AlertKind.Message || this == AlertKind.Attention

private val AlertKind.isStatus: Boolean
    get() = this == AlertKind.Idle || this == AlertKind.Completion
