package com.potatomotato.helm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/** The control actions the sheet offers, and the gated tool each one is. */
enum class SessionAction(val tool: String) {
    Snapshot("session_read_terminal"),
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

    /** Directories Helm knows about, for the spawn form. Empty until asked. */
    private val _directories = MutableStateFlow<List<HelmDirectory>>(emptyList())
    val directories: StateFlow<List<HelmDirectory>> = _directories.asStateFlow()

    fun snapshotRequested(lines: Int) {
        _snapshot.value = Snapshot.Loading(lines)
    }

    /**
     * Take a `session_read_terminal` result. A payload without a `stripped` tail
     * is a failure rather than an empty screen: the phone asked for cleaned text
     * and an empty list would read as "the session has printed nothing".
     */
    fun snapshotArrived(result: Any?, requested: Int) {
        val stripped = (result as? JSONObject)?.opt("stripped") as? JSONArray
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
        val array = result as? JSONArray ?: return false
        _directories.value = (0 until array.length()).mapNotNull { index ->
            val entry = array.opt(index) as? JSONObject ?: return@mapNotNull null
            val path = entry.opt("dirPath") as? String ?: return@mapNotNull null
            HelmDirectory(path = path, name = entry.opt("name") as? String ?: lastPathSegment(path))
        }
        return true
    }

    private companion object {
        const val UNREADABLE_TAIL = "Helm answered without a terminal tail"
    }
}

/**
 * One directory Helm can spawn into. The path IS the identity — two projects can
 * share a last segment — and [name] is only what a phone-width row shows.
 */
data class HelmDirectory(val path: String, val name: String)
