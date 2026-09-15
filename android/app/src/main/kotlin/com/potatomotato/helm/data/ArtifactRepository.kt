package com.potatomotato.helm.data

import com.potatomotato.helm.wire.WireShape
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * One artifact of a session, as the list screen draws it.
 *
 * [kind] is the desktop's raw wire value (`markdown`, `html`, …) rather than an
 * enum on purpose: a kind this build has never met is still a readable artifact
 * rendered as text, and refusing the whole list over one unknown kind would trade
 * N-1 readable artifacts for a purity the reader never asked for.
 */
data class HelmArtifact(
    val id: String,
    val title: String,
    val kind: String,
    val versionCount: Int,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
)

/**
 * One artifact's body, as the detail screen draws it: the metadata of the
 * [artifact] it belongs to plus exactly ONE version's content — the shape the
 * desktop's `session_artifact_get` answers, never the whole versions array.
 */
data class HelmArtifactRead(
    val artifact: HelmArtifact,
    val requestedVersion: Int,
    val content: String,
)

/**
 * One artifact's bytes, as the desktop's `session_artifact_download` envelope
 * delivers them and as the device sink writes them. Plain class rather than a
 * data class because a byte array has no meaningful structural equality — two
 * downloads of the same file are still two files.
 */
class HelmArtifactFile(
    val artifactId: String,
    val filename: String,
    val mimeType: String,
    val version: Int,
    val bytes: ByteArray,
)

/**
 * The state of one artifact's download on the detail screen. The bytes landing
 * ([Ready]) and the file landing on disk ([Saved]) are deliberately separate:
 * a Done notice between the two would claim a save that has not happened.
 */
sealed interface ArtifactSave {
    data object Idle : ArtifactSave
    data class Downloading(val artifactId: String) : ArtifactSave

    /** The envelope arrived; the device sink has not written it yet. */
    data class Ready(val file: HelmArtifactFile) : ArtifactSave

    /** Written to the phone's storage; [path] is where the user finds it. */
    data class Saved(val artifactId: String, val path: String) : ArtifactSave
    data class Failed(val artifactId: String, val message: String) : ArtifactSave
}

/** The state of the artifacts list for the session on screen. */
sealed interface ArtifactList {
    data object Idle : ArtifactList
    data class Loading(val sessionId: String) : ArtifactList
    data class Ready(val sessionId: String, val artifacts: List<HelmArtifact>) : ArtifactList
    data class Failed(val sessionId: String, val message: String) : ArtifactList
}

/** The state of one artifact's body on the detail screen. */
sealed interface ArtifactRead {
    data object Idle : ArtifactRead
    data class Loading(val artifactId: String, val version: Int?) : ArtifactRead
    data class Done(val read: HelmArtifactRead) : ArtifactRead
    data class Failed(val artifactId: String, val message: String) : ArtifactRead
}

/**
 * ArtifactRepository — the phone's picture of one session's artifacts.
 *
 * Pulled on demand, never streamed, for the same reason the terminal tail is: the
 * BLE link's frame budget is the scarce thing, and the list screen asks once per
 * visit rather than subscribing to anything.
 *
 * Every arrival is CHECKED AGAINST THE ASK before it is applied. Two asks can be
 * in flight — back out of one session's artifacts and into another's, or page
 * from version 2 to 3 while 2 is still crossing the link — and a late answer to
 * the old ask must not land under the new one's name. That guard is the whole
 * reason the states carry the session and artifact ids they are about.
 *
 * Deliberately free of Android types, like every other repository here. The
 * device sink that turns a [HelmArtifactFile] into a file on the phone lives
 * behind `save.ArtifactFiles` and is injected at the UI edge.
 */
class ArtifactRepository {
    private val _list = MutableStateFlow<ArtifactList>(ArtifactList.Idle)
    val list: StateFlow<ArtifactList> = _list.asStateFlow()

    private val _read = MutableStateFlow<ArtifactRead>(ArtifactRead.Idle)
    val read: StateFlow<ArtifactRead> = _read.asStateFlow()

    private val _save = MutableStateFlow<ArtifactSave>(ArtifactSave.Idle)
    val save: StateFlow<ArtifactSave> = _save.asStateFlow()

    /** An ask for the session's artifact list. Replaces any failure with patience. */
    fun listRequested(sessionId: String) {
        _list.value = ArtifactList.Loading(sessionId)
    }

    /**
     * Take a `session_artifact_list` result. True when the ask is settled —
     * applied, or a stale arrival for ANOTHER session dropped, since the newer
     * ask still owns the state. False when the answer arrived and could not be
     * read, which the caller turns into a failure the screen can show.
     */
    fun listArrived(sessionId: String, result: Any?): Boolean {
        val state = _list.value
        if (state is ArtifactList.Loading && state.sessionId != sessionId) return true

        val array = result as? JSONArray ?: run {
            WireShape.undecodable<Unit>("a session_artifact_list result", "a JSON array", result)
            return false
        }
        val parsed = (0 until array.length()).mapNotNull { parseEntry(array.optJSONObject(it)) }
        _list.value = ArtifactList.Ready(sessionId, parsed)
        return true
    }

    /** Record why the list is missing. The message is what the user reads. */
    fun listFailed(sessionId: String, message: String) {
        _list.value = ArtifactList.Failed(sessionId, message)
    }

    /** An ask for one artifact's body — [version] null for the latest. */
    fun readRequested(artifactId: String, version: Int?) {
        _read.value = ArtifactRead.Loading(artifactId, version)
    }

    /**
     * Take a `session_artifact_get` result. True when the ask is settled —
     * applied, or a stale arrival for a different artifact or version dropped,
     * which is exactly the paging race the guard exists for. False when the
     * answer arrived and could not be read, which the caller turns into a
     * failure the screen can show.
     */
    fun readArrived(artifactId: String, version: Int?, result: Any?): Boolean {
        val state = _read.value
        if (state is ArtifactRead.Loading &&
            (state.artifactId != artifactId || state.version != version)
        ) {
            return true
        }

        val body = result as? JSONObject
        val id = body?.opt("id") as? String
        // An EMPTY body is a valid read — an artifact may hold nothing yet; a
        // MISSING one means the answer is not a read at all.
        val content = body?.opt("requestedVersionContent") as? String
        if (id == null || content == null) {
            WireShape.undecodable<Unit>(
                "a session_artifact_get result",
                "a JSON object with `id` and `requestedVersionContent` strings",
                result,
            )
            return false
        }
        _read.value = ArtifactRead.Done(parseRead(body, id, content))
        return true
    }

    /** Record why the body is missing. The message is what the user reads. */
    fun readFailed(artifactId: String, message: String) {
        _read.value = ArtifactRead.Failed(artifactId, message)
    }

    /** An ask for one artifact as a file — [version] null for the latest. */
    fun downloadRequested(artifactId: String) {
        _save.value = ArtifactSave.Downloading(artifactId)
    }

    /**
     * Take a `session_artifact_download` result — `{filename, mimeType, base64,
     * version, size}`. The base64 body DECODES here, because the one thing worse
     * than no file is a corrupt one saved to the phone's storage. Same contract
     * as the other arrivals: true when settled (applied, or a stale arrival for
     * another artifact dropped), false when the answer could not be read.
     */
    fun downloadArrived(artifactId: String, result: Any?): Boolean {
        val state = _save.value
        if (state is ArtifactSave.Downloading && state.artifactId != artifactId) return true

        val body = result as? JSONObject
        val filename = body?.opt("filename") as? String
        val mimeType = body?.opt("mimeType") as? String
        val base64 = body?.opt("base64") as? String
        if (filename == null || mimeType == null || base64 == null) {
            WireShape.undecodable<Unit>(
                "a session_artifact_download result",
                "a JSON object with `filename`, `mimeType` and `base64` strings",
                result,
            )
            return false
        }
        val bytes = try {
            java.util.Base64.getDecoder().decode(base64)
        } catch (_: IllegalArgumentException) {
            WireShape.undecodable<Unit>(
                "a session_artifact_download result",
                "a `base64` string that decodes",
                result,
            )
            return false
        }
        _save.value = ArtifactSave.Ready(
            HelmArtifactFile(
                artifactId = artifactId,
                filename = filename,
                mimeType = mimeType,
                // A shape that answers no version is the latest; 1 is what a
                // fresh artifact is, and a file does not care either way.
                version = (body.opt("version") as? Number)?.toInt() ?: 1,
                bytes = bytes,
            ),
        )
        return true
    }

    /** Record why the file is missing. The message is what the user reads. */
    fun downloadFailed(artifactId: String, message: String) {
        _save.value = ArtifactSave.Failed(artifactId, message)
    }

    /** The device sink wrote the file; [path] is what the Save row shows. */
    fun saveLanded(artifactId: String, path: String) {
        _save.value = ArtifactSave.Saved(artifactId, path)
    }

    /** The device sink could not write the file. The message is what the user reads. */
    fun saveFailed(artifactId: String, message: String) {
        _save.value = ArtifactSave.Failed(artifactId, message)
    }

    private fun parseEntry(entry: JSONObject?): HelmArtifact? {
        val id = entry?.opt("id") as? String ?: return null
        return HelmArtifact(
            id = id,
            title = entry.opt("title") as? String ?: id,
            kind = entry.opt("kind") as? String ?: "",
            versionCount = (entry.opt("versionCount") as? Number)?.toInt() ?: 1,
            // org.json hands back Integer or Long by magnitude; both are the number.
            createdAtEpochMs = (entry.opt("createdAt") as? Number)?.toLong() ?: 0L,
            updatedAtEpochMs = (entry.opt("updatedAt") as? Number)?.toLong() ?: 0L,
        )
    }

    private fun parseRead(body: JSONObject, id: String, content: String): HelmArtifactRead =
        HelmArtifactRead(
            artifact = HelmArtifact(
                id = id,
                title = body.opt("title") as? String ?: id,
                kind = body.opt("kind") as? String ?: "",
                versionCount = (body.opt("versionCount") as? Number)?.toInt() ?: 1,
                createdAtEpochMs = (body.opt("createdAt") as? Number)?.toLong() ?: 0L,
                updatedAtEpochMs = (body.opt("updatedAt") as? Number)?.toLong() ?: 0L,
            ),
            requestedVersion = (body.opt("requestedVersion") as? Number)?.toInt() ?: 1,
            content = content,
        )
}
