package com.potatomotato.helm.data

import com.potatomotato.helm.wire.WireShape
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/** The control actions the sheet offers, and the gated tool each one is. */
enum class SessionAction(val tool: String) {
    Snapshot("session_read_terminal"),
    Rename("session_rename"),
    Compact("session_compact"),
    Spawn("session_create"),
    Close("session_close"),
}

/** How the last control action ended. */
sealed interface ActionOutcome {
    data object Done : ActionOutcome

    /**
     * Helm refused. This is a RULE, not a fault: the permitted-tools cache cannot
     * see the ownership gate, so "close a session this phone did not create" is
     * refused every time while still appearing permitted. The deny message is
     * byte-identical across every deny path by desktop design, so the app cannot
     * and must not try to explain WHICH rule — only that a rule applied.
     */
    data object Refused : ActionOutcome

    /** The link, not the gate. Worth telling apart: one is a rule, one is radio. */
    data class Failed(val message: String) : ActionOutcome
}

data class ActionNotice(val action: SessionAction, val outcome: ActionOutcome)

/** The terminal tail, pulled on demand. */
sealed interface Snapshot {
    data object Idle : Snapshot
    data class Loading(val lines: Int) : Snapshot
    data class Lines(val lines: List<String>, val requested: Int) : Snapshot
    data class Failed(val message: String) : Snapshot
}

/**
 * ControlRepository — the state behind mockup screens 4 and 7.
 *
 * It holds two things the control surface cannot do without: the terminal tail a
 * snapshot pulled, and the outcome of the last action, so a refusal is something
 * the user READS rather than something that silently does nothing.
 *
 * Deliberately free of Android types, like every other repository here — the
 * parsing and the refusal paths are the parts worth testing, and they test on
 * the JVM.
 */
class ControlRepository {
    private val _snapshot = MutableStateFlow<Snapshot>(Snapshot.Idle)
    val snapshot: StateFlow<Snapshot> = _snapshot.asStateFlow()

    private val _notice = MutableStateFlow<ActionNotice?>(null)
    val notice: StateFlow<ActionNotice?> = _notice.asStateFlow()

    /**
     * The last line count a terminal peek was asked for — what the screen 7 chip
     * row highlights and what its refresh re-pulls. It lives HERE rather than in
     * the [Snapshot] state on purpose: a Loading, a Failed, navigation away and
     * back, and a different session must all leave the answer standing. Only a
     * new request replaces it. Starts at the smallest chip, which is also what
     * the sheet pulls before the user has chosen anything.
     */
    private val _requestedLines = MutableStateFlow(DEFAULT_REQUESTED_LINES)
    val requestedLines: StateFlow<Int> = _requestedLines.asStateFlow()

    /** Directories Helm knows about, for the spawn form. Empty until asked. */
    private val _directories = MutableStateFlow<List<HelmDirectory>>(emptyList())
    val directories: StateFlow<List<HelmDirectory>> = _directories.asStateFlow()

    /**
     * Why the directory list is missing, when Helm was asked and could not
     * answer. Null while an ask is in flight or a list has landed — the eternal
     * "waiting for the directory list" hint must not outlive a failure the user
     * could retry.
     */
    private val _directoriesError = MutableStateFlow<String?>(null)
    val directoriesError: StateFlow<String?> = _directoriesError.asStateFlow()

    /** The CLI catalogue from `tool_list`. Empty until asked — or when the call failed, which the spawn form covers with its fallback. */
    private val _clis = MutableStateFlow<List<HelmCli>>(emptyList())
    val clis: StateFlow<List<HelmCli>> = _clis.asStateFlow()

    /**
     * The session a confirmed spawn created, waiting to be opened once the list
     * shows it. Null when no spawn has landed or the answer named no session.
     */
    private val _createdSessionId = MutableStateFlow<String?>(null)
    val createdSessionId: StateFlow<String?> = _createdSessionId.asStateFlow()

    fun snapshotRequested(lines: Int) {
        _snapshot.value = Snapshot.Loading(lines)
        _requestedLines.value = lines
    }

    /**
     * Take a `session_read_terminal` result. A payload without a `stripped` tail
     * is a failure rather than an empty screen: the phone asked for cleaned text
     * and an empty list would read as "the session has printed nothing".
     */
    fun snapshotArrived(result: Any?, requested: Int) {
        val stripped = (result as? JSONObject)?.opt("stripped") as? JSONArray
        if (stripped == null) {
            WireShape.undecodable<Unit>(
                "a session_read_terminal result",
                "a JSON object with a `stripped` array",
                result,
            )
        }
        _snapshot.value = if (stripped == null) {
            Snapshot.Failed(UNREADABLE_TAIL)
        } else {
            Snapshot.Lines((0 until stripped.length()).map { stripped.optString(it) }, requested)
        }
    }

    fun snapshotFailed(message: String) {
        _snapshot.value = Snapshot.Failed(message)
    }

    fun clearSnapshot() {
        _snapshot.value = Snapshot.Idle
    }

    fun noticed(action: SessionAction, outcome: ActionOutcome) {
        _notice.value = ActionNotice(action, outcome)
    }

    /** One notice is shown once. Dismissing it must not resurrect it on recompose. */
    fun clearNotice() {
        _notice.value = null
    }

    /** Take a `directory_list` result. False when the payload is not a directory list. */
    fun directoriesArrived(result: Any?): Boolean {
        val array = result as? JSONArray ?: run {
            WireShape.undecodable<Unit>("a directory_list result", "a JSON array", result)
            return false
        }
        _directories.value = (0 until array.length()).mapNotNull { index ->
            val entry = array.opt(index) as? JSONObject ?: return@mapNotNull null
            val path = entry.opt("dirPath") as? String ?: return@mapNotNull null
            HelmDirectory(path = path, name = entry.opt("name") as? String ?: lastPathSegment(path))
        }
        return true
    }

    /** A new ask supersedes whatever the last one failed with. */
    fun directoriesRequested() {
        _directoriesError.value = null
    }

    /** Record why the directory list is missing. The message is what the user reads. */
    fun directoriesFailed(message: String) {
        _directoriesError.value = message
    }

    /**
     * Take a `tool_list` result — the desktop's full CLI catalogue. False when
     * the payload is not a catalogue at all, in which case the previous answer
     * stands and the spawn form falls back to harvesting `session_list`.
     */
    fun clisArrived(result: Any?): Boolean {
        val array = result as? JSONArray ?: run {
            WireShape.undecodable<Unit>("a tool_list result", "a JSON array", result)
            return false
        }
        _clis.value = (0 until array.length()).mapNotNull { index ->
            val entry = array.opt(index) as? JSONObject ?: return@mapNotNull null
            val cliType = entry.opt("cliType") as? String ?: return@mapNotNull null
            val paths = entry.opt("supportedDirPaths") as? JSONArray
            HelmCli(
                cliType = cliType,
                name = entry.opt("name") as? String ?: cliType,
                supportedDirPaths = (0 until (paths?.length() ?: 0)).mapNotNull { paths?.opt(it) as? String },
            )
        }
        return true
    }

    /** Record the session a confirmed spawn created. A null id means the answer named none. */
    fun spawnCreated(sessionId: String?) {
        _createdSessionId.value = sessionId
    }

    /**
     * The created id is consumed once — opening the thread must not fire
     * twice. Compare-and-set: a second spawn landing while the first is
     * still being waited on must not have its id wiped by the first clear.
     */
    fun clearCreatedSession(sessionId: String) {
        if (_createdSessionId.value == sessionId) _createdSessionId.value = null
    }

    private companion object {
        /** The smallest chip on screen 7 — enough to read, cheap enough to not think about. */
        const val DEFAULT_REQUESTED_LINES = 50

        const val UNREADABLE_TAIL = "Helm answered without a terminal tail"
    }
}

/**
 * One CLI Helm can spawn, from the `tool_list` catalogue. [cliType] is the wire
 * id `session_create` needs; [name] is only what the row shows. [supportedDirPaths]
 * is carried for parity with the desktop answer even though the form does not
 * filter on it yet — the phone-width row does not need it today.
 */
data class HelmCli(val cliType: String, val name: String, val supportedDirPaths: List<String>)

/**
 * One directory Helm can spawn into. The path IS the identity — two projects can
 * share a last segment — and [name] is only what a phone-width row shows.
 */
data class HelmDirectory(val path: String, val name: String)
