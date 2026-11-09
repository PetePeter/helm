package com.potatomotato.helm.link

import com.potatomotato.helm.data.isFrozenRefusal
import com.potatomotato.helm.data.ChatRepository
import com.potatomotato.helm.data.ControlRepository
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.SessionRepository
import com.potatomotato.helm.data.SessionWire
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.notify.AlertRouter
import com.potatomotato.helm.wire.MobileCallInterruption
import com.potatomotato.helm.wire.MobileRecord


class SessionClient internal constructor(
    private val core: HelmClient,
    val state: SessionRepository,
    val chats: ChatRepository,
    val alerts: AlertRouter,
    private val control: ControlRepository,
) {

    internal fun onLinkLost() {
        sessionRefreshInFlight = false
        sessionRefreshQueued = false
        // Whatever Helm owed this phone by way of a change notice went with the
        // link, so the list is stale until the next link is asked.
        sessionsStale = true
        // The cursor belongs to the link: the next usable link must hear it
        // again, whether it arrives via the link-up hook or the session poll.
        // This is the TRANSPORT-loss half only; [onLinkUp] clears it per
        // handshake, which covers the channels this hook never sees.
        chatCursorReported = false
    }

    /**
     * The link just became usable. Report the seq of the last chat message this
     * phone holds, so the desktop can replay everything after it — the catch-up
     * that covers both a phone that was out of range and an app restart whose
     * threads are gone. The answer carries nothing this app acts on: the replay
     * arrives afterwards as ordinary `chat` records, deduped by seq in
     * [ChatRepository.receive].
     *
     * Sent FIRST on link up, ahead of the session refresh: the journal replay
     * and the session list are independent, and the cursor is the one request
     * whose answer cannot be re-derived later by a poll.
     *
     * THE FLAG IS CLEARED HERE, not only in [onLinkLost]. The cursor belongs to
     * the HANDSHAKE, not to the transport: this hook fires once per established
     * SecureChannel, whereas the loss hook fires only when the TRANSPORT changes
     * (HelmPairing wires it to `HelmLink.onLinkChanged`). A channel re-made over
     * a transport that never went down — a desktop restart, a re-handshake after
     * a stumble — therefore left the flag standing and the phone never re-asked,
     * which is the reconnect with permanently empty threads. Re-reporting is
     * free: the desktop replays from the same seq and [ChatRepository] dedupes.
     */
    internal fun onLinkUp(): Boolean {
        chatCursorReported = false
        val reported = reportChatCursorIfNeeded()
        // A new channel may be a restarted Helm that owes this phone no notice.
        sessionsStale = true
        refreshStaleSessions()
        return reported
    }

    private var sessionRefreshInFlight = false

    private var sessionRefreshQueued = false

    /** Whether a screen showing sessions is visible right now. See [watchSessions]. */
    private var sessionsWatched = false

    /**
     * Whether the held list may be behind Helm's. True until a fetch is issued,
     * and again whenever Helm says the list moved, a fetch fails, or the link
     * changes — a new link is a Helm that may have restarted.
     */
    private var sessionsStale = true

    /**
     * Whether the chat cursor has been reported on THIS link. The report rides
     * the link-up hook first, but the hook is not guaranteed: after a failed
     * handshake attempt the relink that follows can come up usable without
     * `onLinked` ever firing (observed on real hardware — `__mobile_tools__`
     * crosses, `__chat_cursor__` never does), and the threads stay empty for
     * the whole process. [refreshStaleSessions] is the one pass that
     * demonstrably runs whenever a screen is up, so an unreported cursor
     * re-sends there within one interval. A duplicate report is harmless: the
     * desktop replays from the same seq and [ChatRepository] dedupes by seq.
     *
     * The report also goes STALE after [HelmClient.CURSOR_REPORT_FRESH_MS]: a journal
     * replay streamed over BLE can outrun a link that drops mid-stream, and the
     * desktop — having answered the report — never sends the rest. Saying the
     * cursor again after five minutes heals that hole on the next pass instead
     * of at the next app restart, for the cost of a replay [ChatRepository]
     * dedupes to nothing.
     */
    private var chatCursorReported = false

    /** When [now] last stamped the report as issued — the freshness clock. */
    private var chatCursorReportedAt = 0L

    /**
     * Where an incoming RING goes (the operator calling). Set by the Android
     * shell; null — tests, or before wiring — degrades to an ordinary alert.
     * Returns false when it will not ring (a call is already live), and the
     * ring degrades to an ordinary alert the same way.
     */
    @Volatile
    var ringer: ((MobileRecord.Chat) -> Boolean)? = null

    /**
     * Where a TRANSFER goes (a session handing the live call to another). Set
     * by the Android shell. Never an alert: with no call to move there is
     * nothing to tell the user.
     */
    @Volatile
    var transferrer: ((MobileRecord.Chat) -> Unit)? = null

    /**
     * A screen showing sessions came into view, or left it.
     *
     * This is what replaced the two-second poll. The list is fetched when it is
     * [sessionsStale] AND someone is looking; Helm then says once when it moves
     * (a `changes` record), which makes it stale again. A phone in a pocket
     * therefore hears at most one notice and asks for nothing.
     */
    fun watchSessions(watching: Boolean) {
        sessionsWatched = watching
        refreshStaleSessions()
    }

    /**
     * Fetch the list if it is stale and on screen. Safe to call on a timer: it
     * puts nothing on the wire while the list is fresh, and nothing while there
     * is no usable link. That is how a fetch the link refused gets retried
     * without any hook having to fire.
     */
    fun refreshStaleSessions() {
        if (!sessionsWatched) return
        // The chat cursor used to ride the session poll, which is gone. This
        // pass is its heir: a no-op while the report is fresh, and the one
        // request that still runs whenever a screen is up and the link usable.
        reportChatCursorIfNeeded()
        if (sessionsStale) refreshSessions()
    }

    /**
     * Ask for the session list — everything on a first fetch, only what moved
     * after that. At most one request crosses the link at a time; callers that
     * arrive while it waits ask for one reconciliation afterward.
     */
    fun refreshSessions(): Boolean {
        reportChatCursorIfNeeded()
        if (sessionRefreshInFlight) {
            sessionRefreshQueued = true
            return true
        }
        sessionRefreshInFlight = true
        // Fresh from the moment the request is ISSUED, not answered: a notice
        // that lands while it is in flight must be able to mark it stale again.
        sessionsStale = false
        return core.call(HelmClient.METHOD_SESSION_LIST, sessionListParams()) { outcome ->
            sessionRefreshInFlight = false
            try {
                // A failed refresh leaves the previous list standing: stale data
                // is more useful than an empty lie.
                if (outcome !is HelmClient.Outcome.Ok) {
                    // A denial is an ANSWER, and asking again gets the same one;
                    // only a new link can change it. Everything else — no link,
                    // a timeout — is a fetch that still has to happen.
                    if ((outcome as HelmClient.Outcome.Failed).message == HelmClient.MOBILE_DENY_MESSAGE) state.denied()
                    else sessionsStale = true
                    return@call
                }
                val changes = SessionWire.parseChanges(outcome.result)
                if (changes == null) {
                    HelmLog.w(HelmLog.CLIENT, "session_list answered ok but did not decode; the list is unchanged")
                    state.undecodable()
                    return@call
                }
                HelmLog.i(
                    HelmLog.CLIENT,
                    "session_list decoded ${changes.sessions.size} sessions, ${changes.removed.size} removed, " +
                        "full=${changes.full}; the list held ${state.sessions.value.size} before the merge",
                )
                state.applyChanges(changes)
                chats.retainSessions(state.sessions.value.mapTo(HashSet()) { it.id })
                HelmLog.i(HelmLog.CLIENT, "the list holds ${state.sessions.value.size} after the merge")
            } finally {
                // A queued refresh is reconciliation, not a retry of only success.
                refreshQueuedSessions()
            }
        }
    }

    /**
     * `since` is ALWAYS sent: its presence is what selects the delta reply and
     * tells Helm this phone wants to be told when the list moves. With no
     * cursor it is 0 and no epoch, which Helm answers with the whole list.
     */
    private fun sessionListParams(): Map<String, Any> {
        val cursor = state.cursor ?: return linkedMapOf("since" to 0L)
        return linkedMapOf("since" to cursor.seq, "epoch" to cursor.epoch)
    }

    /**
     * Helm says a feed moved. Only the session list is mirrored this way so far.
     * A seq this phone already holds is its own fetch echoing back, not news.
     */
    internal fun onChanges(record: MobileRecord.Changes) {
        if (record.kind != HelmClient.SESSIONS_CHANGE_KIND) return
        if (record.seq <= (state.cursor?.seq ?: -1L)) return
        sessionsStale = true
        refreshStaleSessions()
    }

    /**
     * Reply into a session. The message appears immediately and is settled when
     * the call comes back, so the user can see the difference between "sent" and
     * "the desktop never answered".
     */
    fun sendChat(
        sessionId: String,
        text: String,
        comfyProfileId: String? = null,
        comfyImageSizeId: String? = null,
        comfyInputImagePath: String? = null,
        comfyInputAttachmentIds: List<String> = emptyList(),
        interruption: MobileCallInterruption? = null,
    ): Boolean {
        val key = chats.sending(sessionId, text, core.now(), comfyProfileId, comfyImageSizeId, comfyInputImagePath, comfyInputAttachmentIds)
        return issueText(
            sessionId, text, key, comfyProfileId, comfyImageSizeId,
            comfyInputImagePath, comfyInputAttachmentIds, interruption,
        )
    }

    /**
     * Send a FAILED message again — the ↻ under the bubble.
     *
     * The repository swaps the dead attempt for a fresh optimistic one (a retry
     * is a new arrival, not a resurrection of the old row), and the wire ask
     * settles THAT new message: the bubble the user pressed is already gone, so
     * there is never a moment with two rows both claiming to be in flight.
     * [text] comes from the bubble the retry was pressed on; the repository
     * remains the authority on whether the attempt really failed.
     */
    fun resendChat(sessionId: String, key: String, text: String): Boolean {
        val comfyProfileId = chats.comfyProfileId(sessionId, key)
        val comfyImageSizeId = chats.comfyImageSizeId(sessionId, key)
        val comfyInputImagePath = chats.comfyInputImagePath(sessionId, key)
        val comfyInputAttachmentIds = chats.comfyInputAttachmentIds(sessionId, key)
        val newKey = chats.retry(sessionId, key, core.now()) ?: return false
        return issueText(
            sessionId, text, key = newKey, comfyProfileId = comfyProfileId,
            comfyImageSizeId = comfyImageSizeId, comfyInputImagePath = comfyInputImagePath,
            comfyInputAttachmentIds = comfyInputAttachmentIds,
        )
    }

    /**
     * Thaw a frozen session, then (when [retry] names a refused bubble) send its
     * text again. The list is refreshed either way so the ❄ and banner clear.
     */
    fun unfreeze(sessionId: String, retry: Pair<String, String>? = null): Boolean =
        core.call(HelmClient.METHOD_SESSION_SET_FROZEN, linkedMapOf("sessionId" to sessionId, "frozen" to false)) { outcome ->
            if (outcome is HelmClient.Outcome.Ok) retry?.let { (key, text) -> resendChat(sessionId, key, text) }
            refreshSessions()
        }

    /** Change keep-warm on the desktop and reconcile the ⏰ row status. */
    fun keepWarm(sessionId: String, on: Boolean): Boolean =
        core.act(control, 
            if (on) SessionAction.KeepWarmOn else SessionAction.KeepWarmOff,
            HelmClient.METHOD_SESSION_SET_KEEP_WARM,
            linkedMapOf("sessionId" to sessionId, "on" to on),
        ) { outcome -> if (outcome is HelmClient.Outcome.Ok) refreshSessions() }

    /** Freeze or unfreeze a session from the session action sheet. */
    fun setFrozen(sessionId: String, frozen: Boolean): Boolean =
        core.act(control, 
            if (frozen) SessionAction.Freeze else SessionAction.Unfreeze,
            HelmClient.METHOD_SESSION_SET_FROZEN,
            linkedMapOf("sessionId" to sessionId, "frozen" to frozen),
        ) { outcome -> if (outcome is HelmClient.Outcome.Ok) refreshSessions() }

    /** One `session_send_text` ask, settling the optimistic row named by [key]. */
    private fun issueText(
        sessionId: String,
        text: String,
        key: String,
        comfyProfileId: String? = null,
        comfyImageSizeId: String? = null,
        comfyInputImagePath: String? = null,
        comfyInputAttachmentIds: List<String> = emptyList(),
        interruption: MobileCallInterruption? = null,
    ): Boolean {
        val params = linkedMapOf<String, Any>("sessionId" to sessionId, "text" to text)
        comfyProfileId?.let { params["comfyProfileId"] = it }
        comfyImageSizeId?.let { params["comfyImageSizeId"] = it }
        comfyInputImagePath?.let { params["comfyInputImagePath"] = it }
        if (text.trim() != "/cancel" && comfyInputAttachmentIds.isNotEmpty()) {
            params["comfyInputAttachmentIds"] = comfyInputAttachmentIds
        }
        // The call id is chosen HERE rather than inside [call] because the
        // desktop derives the echo's originId from it — this end must know it to
        // recognise its own words when the journal replays them back.
        val id = core.nextCallId()
        val issued = core.call(HelmClient.METHOD_SESSION_SEND_TEXT, params, id = id, interruption = interruption) { outcome ->
            chats.settle(
                sessionId, key, outcome is HelmClient.Outcome.Ok,
                frozen = outcome is HelmClient.Outcome.Failed && isFrozenRefusal(outcome.message),
            )
        }
        if (issued) {
            // Only a call the link actually carried is registered: the desktop
            // journals only what it accepted, so claiming an echo for an unsent
            // call would drop somebody else's history.
            chats.sent("${core.machineId}:$id", sessionId, key)
        } else {
            chats.settle(sessionId, key, delivered = false)
        }
        return issued
    }

    /**
     * Delete chat rows — one (the bubble's ✕) or a selection. They go from the
     * thread at once; the desktop is then told which of them it holds, so its
     * journal, the other phones and — for an API-tool session — the model's
     * history drop them too. Fire-and-forget: a failed call leaves the desktop's
     * copy, which is what an unsent delete has always meant.
     */
    fun deleteChats(sessionId: String, keys: Set<String>) {
        val items = chats.removeMany(sessionId, keys)
        if (items.isEmpty()) return
        val wire = items.map { item ->
            if (item.seq != null) linkedMapOf<String, Any>("seq" to item.seq)
            else linkedMapOf<String, Any>("originId" to item.originId!!)
        }
        core.call(HelmClient.METHOD_CHAT_DELETE, linkedMapOf<String, Any>("sessionId" to sessionId, "items" to wire)) { outcome ->
            if (outcome is HelmClient.Outcome.Failed) HelmLog.w(HelmLog.CLIENT, "chat delete not applied on the desktop: ${outcome.message}")
        }
    }

    /**
     * Pull the terminal tail on demand — never a stream. [lines] is bounded HERE,
     * before any bytes reach the radio: the desktop buffer holds at most
     * [HelmClient.MAX_SNAPSHOT_LINES], and asking for more would spend the link's budget on
     * text that does not exist.
     *
     * The desktop returns xterm's rendered screen, so this app never grows a
     * second escape-code parser or treats cursor updates as printed text.
     */
    fun readTerminal(sessionId: String, lines: Int): Boolean {
        if (lines !in 1..HelmClient.MAX_SNAPSHOT_LINES) {
            control.snapshotFailed("Ask for 1 to $HelmClient.MAX_SNAPSHOT_LINES lines")
            return false
        }
        control.snapshotRequested(lines)
        return readTerminal(sessionId, lines, HelmClient.SNAPSHOT_MODE)
    }

    /**
     * Prefer the rendered screen. Older desktops can reject `screen`, and
     * desktops whose xterm buffer API is not enabled cannot render it, so retry
     * those known compatibility failures with their cleaned text tail.
     */
    private fun readTerminal(sessionId: String, lines: Int, mode: String): Boolean {
        val params = linkedMapOf<String, Any>(
            "sessionId" to sessionId,
            // A NUMBER on the wire. The desktop reads it with a typeof check and
            // silently ignores a quoted one, which would answer the default tail
            // while this screen said otherwise.
            "lines" to lines,
            "mode" to mode,
            "stripBlankLines" to false,
        )
        val issued = core.call(HelmClient.METHOD_READ_TERMINAL, params) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> control.snapshotArrived(outcome.result, lines)
                is HelmClient.Outcome.Failed -> {
                    if (mode == HelmClient.SNAPSHOT_MODE && (
                            outcome.message.contains(HelmClient.LEGACY_SCREEN_MODE_ERROR) ||
                                outcome.message.contains(HelmClient.PROPOSED_SCREEN_API_ERROR)
                            )
                    ) {
                        readTerminal(sessionId, lines, HelmClient.LEGACY_SNAPSHOT_MODE)
                    } else {
                        control.snapshotFailed(outcome.message)
                    }
                }
            }
        }
        return issued
    }

    /** Compact a session. Nothing to show but the outcome. */
    fun compact(sessionId: String): Boolean =
        core.act(control, SessionAction.Compact, HelmClient.METHOD_SESSION_COMPACT, linkedMapOf("sessionId" to sessionId))

    fun clear(sessionId: String): Boolean =
        core.act(control, SessionAction.Clear, HelmClient.METHOD_SESSION_CLEAR, linkedMapOf("sessionId" to sessionId))

    fun quickCompact(sessionId: String): Boolean =
        core.act(control, SessionAction.HelmCompact, HelmClient.METHOD_SESSION_QUICK_COMPACT, linkedMapOf("sessionId" to sessionId))

    fun cloneSession(sessionId: String): Boolean =
        core.act(control, SessionAction.Clone, HelmClient.METHOD_SESSION_CLONE, linkedMapOf("sessionId" to sessionId))

    fun switchCli(sessionId: String, cliType: String): Boolean =
        core.act(control, SessionAction.SwitchCli, HelmClient.METHOD_SESSION_SWITCH_CLI, linkedMapOf("sessionId" to sessionId, "cliType" to cliType))

    fun stop(sessionId: String): Boolean =
        core.act(control, SessionAction.Stop, HelmClient.METHOD_SESSION_SEND_INPUT, linkedMapOf("sessionId" to sessionId, "sequence" to "{Esc}"))

    /**
     * Rename a session. The list is the only place the new name shows, so success
     * pulls it the way a close does; the notice bar says the rest.
     */
    fun renameSession(sessionId: String, newName: String): Boolean =
        core.act(control, SessionAction.Rename, HelmClient.METHOD_SESSION_RENAME, linkedMapOf("sessionId" to sessionId, "newName" to newName)) { outcome ->
            if (outcome is HelmClient.Outcome.Ok) refreshSessions()
        }

    /**
     * Close a session. Expect a refusal for anything this phone did not create:
     * the gate lets a device close only its own sessions, and the permitted-tools
     * cache cannot see that rule. The refusal is reported as a rule, not a fault.
     */
    fun closeSession(sessionId: String): Boolean =
        core.act(control, SessionAction.Close, HelmClient.METHOD_SESSION_CLOSE, linkedMapOf("sessionId" to sessionId)) { outcome ->
            if (outcome is HelmClient.Outcome.Ok) refreshSessions()
        }

    /**
     * Spawn a session. The one CREATING action, and the only one this phone
     * will then own.
     *
     * A blank name is OMITTED from the wire rather than sent empty:
     * `session_create` treats the name as optional and the desktop names the
     * session after the CLI type. The created session id is recorded on success
     * so the UI can open the thread; everything else about the outcome is the
     * notice bar's to say.
     *
     * [initialPrompt] is the plan spawner's first instruction; the desktop
     * delivers it once the CLI has started, so the phone never times it.
     */
    fun spawn(
        dirPath: String,
        cliType: String,
        name: String,
        initialPrompt: String? = null,
        machineId: String? = null,
    ): Boolean {
        // Two taps are two sessions: the flag rises on the first, so a repeat
        // that beat the button's recomposition is refused here.
        if (control.spawnInFlight.value) return false
        val params = linkedMapOf<String, Any>("dirPath" to dirPath, "cliType" to cliType)
        if (name.isNotBlank()) params["name"] = name.trim()
        if (!initialPrompt.isNullOrBlank()) params["initialPrompt"] = initialPrompt
        // On another machine: the desktop starts it there and opens it as its own
        // Remote row, whose LOCAL id comes back — so the thread opens the same way.
        val method = if (machineId == null) HelmClient.METHOD_SESSION_CREATE else HelmClient.METHOD_PEER_SPAWN
        if (machineId != null) params["peer"] = machineId
        control.spawnStarted()
        return core.act(control, SessionAction.Spawn, method, params) { outcome ->
            // Every outcome path settles — core.act delivers the verdict whatever it
            // was, including the no-link failure that answers before anything was
            // sent — so the flag cannot outlive the tap that raised it.
            control.spawnSettled()
            if (outcome is HelmClient.Outcome.Ok) {
                control.spawnCreated(core.idIn(outcome.result))
                refreshSessions()
            }
        }
    }

    // ------------------------------------------------- plans, sequences, contexts

    /**
     * Report the cursor if this link has not heard it yet — or has not heard it
     * lately ([HelmClient.CURSOR_REPORT_FRESH_MS]). The flag moves only when the link
     * actually carried the call — and it moves BACK if the call then failed: a
     * report whose answer died with the link was never heard by the desktop, so
     * the next poll must say it again (observed as the empty threads after one
     * reconnect: cursor sent, link dropped before the replay, flag left
     * standing). Staleness reads the same stamp the flag does, so a report
     * known to have failed re-says immediately regardless of the clock.
     */
    private fun reportChatCursorIfNeeded(): Boolean {
        if (chatCursorReported && core.now() - chatCursorReportedAt < HelmClient.CURSOR_REPORT_FRESH_MS) return true
        val desktopId = core.linkedDesktop()
        val issued = core.call(HelmClient.METHOD_CHAT_CURSOR, linkedMapOf<String, Any>("seq" to chats.lastSeq(desktopId))) { outcome ->
            if (outcome is HelmClient.Outcome.Failed) chatCursorReported = false
            // A recreated journal numbers from 1 again: reset, and say the
            // cursor again so Helm replays from zero. An older Helm sends no
            // epoch and keeps today's behaviour.
            val answer = core.json((outcome as? HelmClient.Outcome.Ok)?.result)
            val epoch = answer?.opt("epoch") as? String
            val latestSeq = (answer?.opt("latestSeq") as? Number)?.toLong()
            if (epoch != null && latestSeq != null && chats.adoptJournal(desktopId, epoch, latestSeq)) {
                chatCursorReported = false
                reportChatCursorIfNeeded()
            }
        }
        chatCursorReported = issued
        if (issued) chatCursorReportedAt = core.now()
        return issued
    }

    private fun refreshQueuedSessions() {
        if (!sessionRefreshQueued) return
        sessionRefreshQueued = false
        refreshSessions()
    }
}
