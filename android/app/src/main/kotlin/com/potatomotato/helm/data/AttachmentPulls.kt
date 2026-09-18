package com.potatomotato.helm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * One file to fetch from the desktop, slice by slice, whatever row is showing it.
 *
 * [key] is OPAQUE on purpose: a chat tile keys its transfer on the message it
 * hangs off, an artifact's attachment row keys it on the artifact and attachment
 * ids, and the driver below must not have to know which it is holding. Everything
 * else is what the ask and the save both need — the ids to address
 * `session_artifact_download`, the name and type to write the file, the size to
 * draw honest progress before a byte has arrived.
 */
data class PullTarget(
    val key: String,
    val artifactId: String,
    val attachmentId: String,
    val filename: String,
    val mimeType: String,
    val sizeBytes: Long,
)

/**
 * The transfer key for an attachment fetched from the artifact screen.
 *
 * Both ids, because the same attachment id is only unique within its artifact and
 * the screen may hold rows from more than one over its life.
 */
fun artifactAttachmentKey(artifactId: String, attachmentId: String): String =
    "artifact:$artifactId:$attachmentId"

/**
 * AttachmentPulls — every sliced file fetch this phone has running, keyed by
 * transfer key.
 *
 * WHY THIS IS SHARED. The desktop ALWAYS slices an attachment download: its
 * `session_artifact_download` defaults the length to one slice budget, so an ask
 * without an offset and a length answers the FIRST slice and nothing more. A
 * caller that saves that answer as if it were the file writes a truncated,
 * plausible-looking file — which is exactly how the artifact screen was
 * producing corrupt images. There is therefore no such thing as an unsliced
 * attachment fetch, and no reason for a second implementation of the loop.
 *
 * A repository, not a composable, owns this — a transfer outruns its screen, and
 * scrolling a row away or rotating the phone must not restart a fetch that is
 * halfway across a BLE link. The per-file rules (out-of-order, duplicates,
 * resume-at-the-gap) all live in [AttachmentTransfer]; this is only the bookkeeping
 * around them.
 */
class AttachmentPulls {

    private val _pulls = MutableStateFlow<Map<String, PullState>>(emptyMap())

    /** Per-transfer fetch state, keyed by [PullTarget.key]. */
    val pulls: StateFlow<Map<String, PullState>> = _pulls.asStateFlow()

    private val transfers = mutableMapOf<String, AttachmentTransfer>()

    fun pullState(key: String): PullState = _pulls.value[key] ?: PullState.Idle

    /**
     * Begin (or resume) a fetch. Returns false when one is already running, so a
     * double tap cannot start two loops writing into one buffer. A resumed fetch
     * keeps what already arrived: the rewind is to the gap, not to zero.
     */
    fun pullStarted(key: String, sizeBytes: Long): Boolean {
        if (_pulls.value[key] is PullState.Pulling) return false
        val transfer = transfers.getOrPut(key) { AttachmentTransfer(sizeBytes) }
        // A retry rewinds to the gap: answers to the asks that died with the
        // last attempt are refused rather than double-counted.
        transfer.forgetAsks()
        setPull(key, transfer.state())
        return true
    }

    /**
     * The next offset to ask for, or null when the window is full or there is
     * nothing left to ask. Several asks ride at once — see [AttachmentTransfer].
     *
     * [sliceBytes] is passed in rather than read here: it depends on which
     * transport owns the link RIGHT NOW, and that is the caller's knowledge.
     */
    fun nextAsk(key: String, sliceBytes: Int): Long? =
        transfers[key]?.nextAsk(sliceBytes, ATTACHMENT_PIPELINE)

    /**
     * Take one slice. Returns the complete file when that slice was the last one,
     * and null while there is more to come — so the caller has exactly one signal
     * for "now save it". A slice nobody is waiting for is dropped rather than
     * failing the row: with several asks in flight a duplicate is a normal event.
     */
    fun sliceArrived(key: String, offset: Long, bytes: ByteArray, eof: Boolean): ByteArray? {
        val transfer = transfers[key] ?: return null
        if (!transfer.accept(offset, bytes, eof)) return null
        if (!transfer.done) {
            setPull(key, transfer.state())
            return null
        }
        return transfer.bytes()
    }

    /**
     * The fetch stumbled. What arrived is KEPT: a retry resumes from there, which
     * on a slow link is the difference between a lost minute and a lost transfer.
     */
    fun pullFailed(key: String, message: String) {
        setPull(key, PullState.Failed(message))
    }

    /** The bytes reached the device. The row becomes an open button. */
    fun pullSaved(key: String, location: String, uri: String) {
        transfers.remove(key)
        setPull(key, PullState.Ready(location, uri))
    }

    /** Abandon a fetch and its part-file. Nothing half-written is kept. */
    fun pullCancelled(key: String) {
        transfers.remove(key)
        setPull(key, PullState.Idle)
    }

    private fun setPull(key: String, state: PullState) {
        _pulls.value = if (state is PullState.Idle) _pulls.value - key else _pulls.value + (key to state)
    }
}
