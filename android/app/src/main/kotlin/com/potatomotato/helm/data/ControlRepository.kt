package com.potatomotato.helm.data

import com.potatomotato.helm.wire.WireShape
import java.util.concurrent.atomic.AtomicInteger
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

    /**
     * Opens the session's artifacts. It gates on the LIST tool — the screen's
     * first ask — though the detail screen then needs `session_artifact_get`
     * too; the gate is the authority either way, and a refusal there is state
     * on that screen, not here.
     */
    Artifacts("session_artifact_list"),

    /**
     * The artifact writes. They never appear on the control sheet — they are
     * row affordances on the artifacts screens — but they gate and report like
     * every other action here: one tool each for `__mobile_tools__` to confirm,
     * one notice each for the outcome bar. Revise and save need their target
     * named before they can act, like Rename, so the screens open a form
     * instead of firing at once; delete confirms on its own screen.
     */
    CreateArtifact("session_artifact_create"),
    ReviseArtifact("session_artifact_update"),
    SaveArtifact("session_artifact_download"),
    DeleteArtifact("session_artifact_delete"),
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

/**
 * How the last control action ended.
 *
 * [seq] is a monotonically increasing nonce, and it exists because two
 * outcomes can be byte-identical (spawn twice, be refused twice) while the
 * bar that shows them must still count as TWO: the UI keys its 30-second
 * dismiss timer on this value, and an equal second notice would silently
 * dedup against the first and never be said again.
 */
data class ActionNotice(val seq: Long, val action: SessionAction, val outcome: ActionOutcome)

/**
 * The artifact write that just landed, parked for the artifacts screens to
 * honour exactly once — a request, not a state, the same shape
 * [com.potatomotato.helm.notify.PendingOpen] uses for a notification tap. It
 * exists because two successful deletes carry byte-identical notices, so a
 * state an effect merely watches would silently dedup the second one and
 * strand the user on the editor.
 *
 * [artifactId] is the artifact the action named — the id a create minted, or
 * the one a revise/delete acted on. Null only when a create's answer named
 * none, which the screen reads as "back to the list".
 */
data class ArtifactLanding(val action: SessionAction, val artifactId: String?)

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
     * Monotonic; never reused, so a repeated outcome is still a NEW notice.
     * Atomic because [noticed] runs on the link's and the scheduler's threads.
     */
    private val nextSeq = AtomicInteger(FIRST_SEQ.toInt())

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

    /**
     * A spawn is crossing the wire. The spawn form and the list's New session
     * button grey on it: two taps are two sessions, and neither tap can see the
     * other's answer coming. Raised on the tap, settled on EVERY outcome — a
     * refusal and a dead link end the ask just as surely as a success does.
     */
    private val _spawnInFlight = MutableStateFlow(false)
    val spawnInFlight: StateFlow<Boolean> = _spawnInFlight.asStateFlow()

    /** The tap just became a `session_create` call. */
    fun spawnStarted() {
        _spawnInFlight.value = true
    }

    /** The spawn's answer arrived — or the ask died trying. Either way it is over. */
    fun spawnSettled() {
        _spawnInFlight.value = false
    }

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
        _notice.value = ActionNotice(seq = nextSeq.getAndIncrement().toLong(), action = action, outcome = outcome)
    }

    /** One notice is shown once. Dismissing it must not resurrect it on recompose. */
    fun clearNotice() {
        _notice.value = null
    }

    /**
     * Take a `directory_list` result. False when the payload is not a directory list.
     *
     * The desktop answers in registration order; the phone sorts by project
     * label so every consumer — the spawner especially — reads A-Z. A folder
     * with no project sorts under its own name, which is what its row shows.
     */
    fun directoriesArrived(result: Any?): Boolean {
        val array = result as? JSONArray ?: run {
            WireShape.undecodable<Unit>("a directory_list result", "a JSON array", result)
            return false
        }
        _directories.value = (0 until array.length()).mapNotNull { index ->
            val entry = array.opt(index) as? JSONObject ?: return@mapNotNull null
            val path = entry.opt("dirPath") as? String ?: return@mapNotNull null
            HelmDirectory(
                path = path,
                name = entry.opt("name") as? String ?: lastPathSegment(path),
                projectName = entry.opt("projectName") as? String,
            )
        }.sortedWith(
            compareBy({ (it.projectName ?: it.name).lowercase() }, { it.path }),
        )
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
     *
     * Sorted by display name — the wire arrives in the desktop's config order,
     * and the phone is where the list is read, not authored.
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
        }.sortedBy { it.name.lowercase() }
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

    /** The parked landing, and the only state an artifacts screen navigates on. */
    private val _artifactLanding = MutableStateFlow<ArtifactLanding?>(null)
    val artifactLanding: StateFlow<ArtifactLanding?> = _artifactLanding.asStateFlow()

    /** Park one landing. Called only for outcomes a screen navigates on. */
    fun artifactLanded(action: SessionAction, artifactId: String?) {
        _artifactLanding.value = ArtifactLanding(action, artifactId)
    }

    /** Take the parked landing. The second read sees nothing, by design. */
    fun consumeArtifactLanding(): ArtifactLanding? =
        _artifactLanding.value?.also { _artifactLanding.value = null }

    private companion object {
        /** The smallest chip on screen 7 — enough to read, cheap enough to not think about. */
        const val DEFAULT_REQUESTED_LINES = 50

        const val UNREADABLE_TAIL = "Helm answered without a terminal tail"

        /** [ActionNotice.seq] starts at the first notice and only ever climbs. */
        const val FIRST_SEQ = 1L
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
 *
 * [projectName] is the owning project when there is one. It is separate from
 * [name] because an ALTERNATE folder of a project carries its own name, so
 * "project ▸ folder" needs both. Absent on an older desktop, which is why
 * the row falls back to [name] alone rather than rendering a dangling marker.
 */
data class HelmDirectory(val path: String, val name: String, val projectName: String? = null)
