package com.potatomotato.helm.data

import com.potatomotato.helm.wire.WireShape
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import com.potatomotato.helm.wire.MobileRecord
import org.json.JSONObject

/**
 * One binary file stored on the desktop beside an artifact — a chart image, a
 * data dump — as the list answer names it. METADATA ONLY: the bytes never ride
 * the list; they are fetched one attachment at a time with a bounded download
 * ask, the same way an artifact body is.
 *
 * [contentType] is a hint the desktop passes through from the source and is
 * nullable on the wire for exactly that reason — a hint the desktop never had
 * must not be invented here.
 */
data class HelmArtifactAttachment(
    val id: String,
    val filename: String,
    val contentType: String?,
    val sizeBytes: Long,
    val createdAtEpochMs: Long,
)

/**
 * One artifact of a session, as the list screen draws it.
 *
 * [kind] is the desktop's raw wire value (`markdown`, `html`, …) rather than an
 * enum on purpose: a kind this build has never met is still a readable artifact
 * rendered as text, and refusing the whole list over one unknown kind would trade
 * N-1 readable artifacts for a purity the reader never asked for.
 *
 * [attachments] is WIRE-SAFE in both directions: a desktop old enough to have
 * never heard of attachments omits the field and parses to an empty list, and a
 * desktop new enough may omit it for an artifact that simply has none. The read
 * answer deliberately carries no attachments — the list is their home — so a
 * detail screen reads them from the list cache, not from the body it asked for.
 */
data class HelmArtifact(
    val id: String,
    val title: String,
    val kind: String,
    val versionCount: Int,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
    val attachments: List<HelmArtifactAttachment> = emptyList(),
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
 *
 * The same record carries an artifact VERSION's body and an ATTACHMENT's bytes —
 * the desktop answers both with a binary blob whose body is raw, and a version
 * answer adds `version` while an attachment answer does not — which is why
 * [version] defaults instead of being required.
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
 * A version download and an attachment download share this one machine — the
 * phone saves both as files, and neither is "saved" until the sink says so.
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

/**
 * The state of the artifacts list for the session on screen.
 *
 * [Refreshing] is what a re-visit looks like when the session has been listed
 * before: the previous answer stays on screen while a fresh one crosses the
 * link, because the rows the user is looking at are the best-known truth and a
 * blank screen is the worst one.
 */
sealed interface ArtifactList {
    data object Idle : ArtifactList
    data class Loading(val sessionId: String) : ArtifactList

    /** A fresh ask in flight; [cached] is what the last answer for the session said. */
    data class Refreshing(val sessionId: String, val cached: List<HelmArtifact>) : ArtifactList
    data class Ready(val sessionId: String, val artifacts: List<HelmArtifact>) : ArtifactList
    data class Failed(val sessionId: String, val message: String) : ArtifactList
}

/**
 * The state of one artifact's body on the detail screen. [Refreshing] is the
 * read-side twin of the list's: a version (or artifact) already read once shows
 * its cached body while the re-ask crosses the link, so paging back to a
 * version never blanks the screen the user was just reading.
 */
sealed interface ArtifactRead {
    data object Idle : ArtifactRead
    data class Loading(val artifactId: String, val version: Int?) : ArtifactRead
    data class Refreshing(
        val sessionId: String,
        val artifactId: String,
        val version: Int?,
        val cached: HelmArtifactRead,
    ) : ArtifactRead
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
 * THE CACHES AND THEIR ONE EVICTION RULE. A per-session list cache and a
 * per-(session, artifact, version) read cache stand behind the pulls, and both
 * obey the same discipline — OMISSION-ONLY PURGE. A cache entry leaves only
 * when a fresh, PARSED answer for that session demonstrably omits it: that is
 * the desktop saying the artifact is gone, the one fact that outranks the
 * cache. A failed refresh, an undecodable answer, a dropped link, or time
 * itself never evict anything — stale rows a user can still read beat an empty
 * screen that pretends to be the truth, and the next successful answer is the
 * purge when there is one to make.
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

    /**
     * The attachment fetches this screen has running, keyed by
     * [artifactAttachmentKey]. A SEPARATE machine from [save] on purpose: a body
     * download is one answer and narrates in a single line under the action rows,
     * while an attachment is a sliced transfer whose progress belongs on its own
     * row — and several rows can be pulling at once.
     */
    val attachmentPulls = AttachmentPulls()

    /** Last parsed list answer per session — what a re-visit shows while it refreshes. */
    private val listCache = HashMap<String, List<HelmArtifact>>()

    /** Last parsed read answer per (session, artifact, asked version) — what paging back shows. */
    private val readCache = HashMap<ReadKey, HelmArtifactRead>()

    /** Keyed on the ASKED version, so `null` (the latest) is its own cache slot. */
    private data class ReadKey(val sessionId: String, val artifactId: String, val version: Int?)

    /** The cached rows for a session, when it has been listed before; empty otherwise. */
    fun cachedArtifacts(sessionId: String): List<HelmArtifact> = listCache[sessionId].orEmpty()

    /**
     * An ask for the session's artifact list. A session with a cache shows it
     * ([ArtifactList.Refreshing]); a first visit waits ([ArtifactList.Loading]).
     */
    fun listRequested(sessionId: String) {
        val cached = listCache[sessionId]
        _list.value = if (cached != null) {
            ArtifactList.Refreshing(sessionId, cached)
        } else {
            ArtifactList.Loading(sessionId)
        }
    }

    /**
     * Take a `session_artifact_list` result. True when the ask is settled —
     * applied, or a stale arrival for ANOTHER session dropped, since the newer
     * ask still owns the state. False when the answer arrived and could not be
     * read, which the caller turns into a failure the screen can show.
     */
    fun listArrived(sessionId: String, result: Any?): Boolean {
        // The session an answer may still speak for: whichever ask is in flight.
        val askedSession: String? = when (val state = _list.value) {
            is ArtifactList.Loading -> state.sessionId
            is ArtifactList.Refreshing -> state.sessionId
            else -> null
        }
        if (askedSession != null && askedSession != sessionId) return true

        val array = result as? JSONArray ?: run {
            WireShape.undecodable<Unit>("a session_artifact_list result", "a JSON array", result)
            return false
        }
        val parsed = (0 until array.length()).mapNotNull { parseEntry(array.optJSONObject(it)) }
        // Replacement IS the purge: what the fresh answer omits leaves the cache,
        // and nothing else — not a failure, not an age limit — ever evicts a row.
        listCache[sessionId] = parsed
        // The same omission is the read cache's only eviction: reads of an
        // artifact the list no longer names are reads of an artifact that is gone.
        parsedIds(parsed).let { live ->
            readCache.keys.removeAll { it.sessionId == sessionId && it.artifactId !in live }
        }
        _list.value = ArtifactList.Ready(sessionId, parsed)
        return true
    }

    private val _attachmentErrors = MutableStateFlow<Map<String, String>>(emptyMap())

    /**
     * Why an attachment edit (delete, or the delete half of a replace) failed,
     * keyed by attachment id. Lives beside the cache rather than in the editor so
     * the failed row keeps its reason across a rotation — the row itself stays,
     * because a refused delete is no evidence the file left.
     */
    val attachmentErrors: StateFlow<Map<String, String>> = _attachmentErrors.asStateFlow()

    /**
     * The desktop confirmed an attachment is gone: drop it from the cached row
     * NOW, so the editor and detail screens stop offering a file that no longer
     * exists, without waiting for the list re-pull that follows.
     */
    fun attachmentRemoved(sessionId: String, artifactId: String, attachmentId: String) {
        _attachmentErrors.value = _attachmentErrors.value - attachmentId
        val cached = listCache[sessionId] ?: return
        val pruned = cached.map { artifact ->
            if (artifact.id != artifactId) artifact
            else artifact.copy(attachments = artifact.attachments.filterNot { it.id == attachmentId })
        }
        listCache[sessionId] = pruned
        _list.value = when (val state = _list.value) {
            is ArtifactList.Ready -> if (state.sessionId == sessionId) state.copy(artifacts = pruned) else state
            is ArtifactList.Refreshing -> if (state.sessionId == sessionId) state.copy(cached = pruned) else state
            else -> state
        }
    }

    /** A delete was refused or lost; the row stays and says why. */
    fun attachmentEditFailed(attachmentId: String, message: String) {
        _attachmentErrors.value = _attachmentErrors.value + (attachmentId to message)
    }

    /** A fresh attempt on this row starts clean. */
    fun attachmentEditStarted(attachmentId: String) {
        _attachmentErrors.value = _attachmentErrors.value - attachmentId
    }

    /** Record why the list is missing. The message is what the user reads. */
    fun listFailed(sessionId: String, message: String) {
        // The cache stands: a failed ask is no evidence an artifact left.
        _list.value = ArtifactList.Failed(sessionId, message)
    }

    /** An ask for one artifact's body — [version] null for the latest. */
    fun readRequested(sessionId: String, artifactId: String, version: Int?) {
        val cached = readCache[ReadKey(sessionId, artifactId, version)]
        _read.value = if (cached != null) {
            ArtifactRead.Refreshing(sessionId, artifactId, version, cached)
        } else {
            ArtifactRead.Loading(artifactId, version)
        }
    }

    /**
     * Take a `session_artifact_get` result. True when the ask is settled —
     * applied, or a stale arrival for a different artifact or version dropped,
     * which is exactly the paging race the guard exists for. False when the
     * answer arrived and could not be read, which the caller turns into a
     * failure the screen can show.
     */
    fun readArrived(sessionId: String, artifactId: String, version: Int?, result: Any?): Boolean {
        // The (artifact, version) the in-flight ask named — Loading or a cached
        // Refreshing, both guard the same way.
        val asked: Pair<String, Int?>? = when (val state = _read.value) {
            is ArtifactRead.Loading -> state.artifactId to state.version
            is ArtifactRead.Refreshing -> state.artifactId to state.version
            else -> null
        }
        if (asked != null && asked != (artifactId to version)) return true

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
        val read = parseRead(body, id, content)
        // Filed under the ASK, so a later ask of the same shape finds it.
        readCache[ReadKey(sessionId, artifactId, version)] = read
        _read.value = ArtifactRead.Done(read)
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
     * Take a `session_artifact_download` answer, which arrives as a binary
     * [MobileRecord.Blob]: filename, mime type and the body as RAW BYTES. The
     * base64 the answer used to carry is gone — it cost a third of the wire and
     * a decode at both ends for a body that was never text.
     *
     * Same contract as the other arrivals: true when settled (applied, or a
     * stale arrival for another artifact dropped), false when the answer could
     * not be read.
     */
    fun downloadArrived(artifactId: String, result: Any?): Boolean {
        val state = _save.value
        if (state is ArtifactSave.Downloading && state.artifactId != artifactId) return true

        val blob = result as? MobileRecord.Blob
        if (blob == null) {
            WireShape.undecodable<Unit>(
                "a session_artifact_download result",
                "a binary blob record carrying the file bytes",
                result,
            )
            return false
        }
        _save.value = ArtifactSave.Ready(
            HelmArtifactFile(
                artifactId = artifactId,
                filename = blob.filename,
                mimeType = blob.mimeType,
                // An answer with no version — an attachment's, always — is the
                // latest; 1 is what a fresh artifact is, and a file does not
                // care either way.
                version = blob.version ?: 1,
                bytes = blob.bytes,
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
            attachments = parseAttachments(entry.opt("attachments")),
        )
    }

    /**
     * An artifact's attachment metadata, read the wire-safe way: the whole
     * field absent is simply no attachments, and one malformed entry is dropped
     * rather than being allowed to cost the reader its artifact.
     */
    private fun parseAttachments(raw: Any?): List<HelmArtifactAttachment> {
        val array = raw as? JSONArray ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val meta = array.optJSONObject(index)
            val id = meta?.opt("id") as? String ?: return@mapNotNull null
            HelmArtifactAttachment(
                id = id,
                filename = meta.opt("filename") as? String ?: id,
                contentType = meta.opt("contentType") as? String,
                sizeBytes = (meta.opt("sizeBytes") as? Number)?.toLong() ?: 0L,
                createdAtEpochMs = (meta.opt("createdAt") as? Number)?.toLong() ?: 0L,
            )
        }
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

    private fun parsedIds(parsed: List<HelmArtifact>): Set<String> = parsed.map { it.id }.toSet()
}
