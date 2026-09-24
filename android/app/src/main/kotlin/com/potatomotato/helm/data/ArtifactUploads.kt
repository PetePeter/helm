package com.potatomotato.helm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A file the user staged onto an artifact being created, before Create is
 * tapped.
 *
 * [source] is the picker's own `content://` uri — what a tap on the chip OPENS.
 * The bytes live in a COPY under this app's cache dir, addressed by [localPath],
 * because a picker grant can die under a rotation or a trip through the
 * recents screen, and an upload that cannot re-read its file halfway through is
 * worse than one that never started. [sha256] is the whole file's digest, taken
 * while the copy was made — the desktop verifies it before the attachment
 * exists, so it must be the digest of the bytes this phone actually holds.
 */
data class StagedAttachment(
    val key: String,
    val source: String,
    val localPath: String,
    val filename: String,
    val mimeType: String?,
    val sizeBytes: Long,
    val sha256: String,
)

/** Where one staged file's upload has got to. Per chip, not per editor. */
sealed interface AttachmentUploadState {

    /** Staged and waiting for Create. */
    data object Waiting : AttachmentUploadState

    /** A slot is open and slices are leaving. [sent] of [totalBytes] bytes. */
    data class Uploading(val sent: Long, val totalBytes: Long) : AttachmentUploadState

    /** The desktop verified and committed it. */
    data class Done(val attachmentId: String) : AttachmentUploadState

    /** Nothing landed. The chip offers a retry. */
    data class Failed(val message: String) : AttachmentUploadState
}

/**
 * Why the attach toolbar is dark, when it is. One line each, because a greyed
 * control with no reason reads as a broken app.
 */
sealed interface UploadSupport {
    data object Available : UploadSupport
    data object Offline : UploadSupport

    /** The desktop on the other end speaks protocol 3 — it has no upload half. */
    data object DesktopTooOld : UploadSupport

    /** The gate's answer did not grant the upload tools for this device. */
    data object NotPermitted : UploadSupport
}

/**
 * The pure greying decision for the attach toolbar.
 *
 * Two gates, and BOTH must open: the link must have negotiated protocol 4 (an
 * older Helm has no upload surface at all — offering it would fail as a
 * mysterious refusal), and the desktop's permitted-tools answer must have
 * granted `session_artifact_attachment_add` (the allow-list is a real
 * revocation a user can flip). [toolPermitted] is tri-state on purpose: null is
 * "not asked yet", which is NotPermitted for graying purposes but must never be
 * reported as a refusal the gate actually made.
 */
fun uploadSupport(
    toolPermitted: Boolean?,
    negotiatedProtocol: Int,
    linked: Boolean,
): UploadSupport = when {
    !linked -> UploadSupport.Offline
    negotiatedProtocol < UPLOAD_MIN_PROTOCOL -> UploadSupport.DesktopTooOld
    toolPermitted != true -> UploadSupport.NotPermitted
    else -> UploadSupport.Available
}

/**
 * Protocol 4 is what turned the binary blob record around: download replies
 * existed at 3, uploads did not. Keep the number HERE rather than beside the
 * wire codec — this is a feature gate, not a codec fact.
 */
const val UPLOAD_MIN_PROTOCOL = 4

/**
 * The per-file staging guard. The desktop commits an upload into the same store
 * its own imports use, and that store refuses past
 * `MAX_ATTACHMENT_BYTES` (10 MB, src/session/artifact-attachment-manager.ts) —
 * so staging a bigger file would only buy a refusal AFTER every byte crossed
 * the link. Mirrored here so the refusal happens before the pick is staged.
 */
const val MAX_STAGED_BYTES = 10 * 1024 * 1024

sealed interface StageVerdict {
    data object Ok : StageVerdict
    data object TooLarge : StageVerdict
}

/** The one question a pick asks before it becomes a chip. */
fun stageVerdict(sizeBytes: Long): StageVerdict =
    if (sizeBytes in 1..MAX_STAGED_BYTES) StageVerdict.Ok else StageVerdict.TooLarge

/**
 * ArtifactUploads — the phone's picture of the files riding one artifact create.
 *
 * The repository, not the composable, owns this state, for the reason every
 * other transfer on this link does: an upload outruns its screen. Rotating the
 * editor, or leaving it, must not orphan a transfer that is halfway across a
 * BLE link, and the chips must still be there when the editor comes back.
 *
 * Sequencing is the desktop's problem reversed: the phone sends ONE attachment
 * at a time, in the order staged. Two uploads at once would spend the link's
 * small frame budget on interleaved files nobody asked for, and a serial chain
 * makes "the third one failed" a sentence the UI can draw.
 */
class ArtifactUploads {

    private val _staged = MutableStateFlow<List<StagedAttachment>>(emptyList())
    val staged: StateFlow<List<StagedAttachment>> = _staged.asStateFlow()

    private val _states = MutableStateFlow<Map<String, AttachmentUploadState>>(emptyMap())
    val states: StateFlow<Map<String, AttachmentUploadState>> = _states.asStateFlow()

    /**
     * The artifact the uploads are aimed at, once Create has landed. Null until
     * then: a retry before the artifact exists has nothing to attach to.
     */
    var targetArtifactId: String? = null
        private set

    /** The session those uploads belong to — what a finished chain refreshes. */
    var targetSessionId: String? = null
        private set

    /** Add a staged file. False when the key is already on the stage. */
    fun stage(attachment: StagedAttachment): Boolean {
        if (_staged.value.any { it.key == attachment.key }) return false
        _staged.value = _staged.value + attachment
        setState(attachment.key, AttachmentUploadState.Waiting)
        return true
    }

    /** Take a staged file back off. Its upload state leaves with it. */
    fun unstage(key: String) {
        _staged.value = _staged.value.filterNot { it.key == key }
        _states.value = _states.value - key
        replacing.remove(key)
    }

    /**
     * Staged file -> the existing attachment it REPLACES. The old id is deleted
     * only once the new file's commit has answered Ok, so a failed upload can
     * never leave the artifact with neither file.
     */
    private val replacing = HashMap<String, String>()

    /** Stage [attachment] as the replacement for [oldAttachmentId]. */
    fun stageReplacement(attachment: StagedAttachment, oldAttachmentId: String): Boolean {
        if (!stage(attachment)) return false
        replacing[attachment.key] = oldAttachmentId
        return true
    }

    /** The attachment [key] replaces, or null for a plain add. */
    fun replaces(key: String): String? = replacing[key]

    /** Whether some staged file is mid-flight — a second chain must not start. */
    fun anyUploading(): Boolean = _states.value.values.any { it is AttachmentUploadState.Uploading }

    fun stagedAttachment(key: String): StagedAttachment? =
        _staged.value.firstOrNull { it.key == key }

    /** Keys still worth sending, in staged order. */
    fun pendingKeys(): List<String> =
        _staged.value.map { it.key }.filter { state(it) !is AttachmentUploadState.Done }

    /** Whether every staged file has landed. True, vacuously, when none were. */
    fun allDone(): Boolean =
        _staged.value.all { state(it.key) is AttachmentUploadState.Done }

    /**
     * The upload chain is starting: Create landed and named the artifact. Any
     * previous target is replaced — a second Create supersedes the first.
     */
    fun beginUploads(artifactId: String, sessionId: String) {
        targetArtifactId = artifactId
        targetSessionId = sessionId
    }

    fun uploadStarted(key: String, totalBytes: Long) {
        setState(key, AttachmentUploadState.Uploading(sent = 0, totalBytes = totalBytes))
    }

    /** Honest progress only: bytes actually handed to the link, in order. */
    fun uploadProgress(key: String, sent: Long) {
        val current = state(key)
        if (current is AttachmentUploadState.Uploading) {
            setState(key, current.copy(sent = sent))
        }
    }

    fun uploadDone(key: String, attachmentId: String) {
        setState(key, AttachmentUploadState.Done(attachmentId))
    }

    fun uploadFailed(key: String, message: String) {
        setState(key, AttachmentUploadState.Failed(message))
    }

    /**
     * Forget the whole stage. Called when the editor's work is finished and
     * navigated away from — the chips describe ONE create, not a library.
     */
    fun clear() {
        _staged.value = emptyList()
        _states.value = emptyMap()
        replacing.clear()
        targetArtifactId = null
        targetSessionId = null
    }

    private fun state(key: String): AttachmentUploadState? = _states.value[key]

    private fun setState(key: String, next: AttachmentUploadState) {
        _states.value = _states.value + (key to next)
    }
}
