package com.potatomotato.helm.data

/**
 * A file attached to a chat message, as the phone knows it before fetching it.
 *
 * Ids rather than a path: the desktop's own path for the same file rides the
 * wire too, but it names another machine's filesystem and has never been
 * openable from here. [artifactId] + [attachmentId] address a
 * `session_artifact_download`, and the name and size are here so a tile can be
 * drawn — and a size shown — before a single byte is asked for.
 */
data class ChatAttachment(
    val artifactId: String,
    val attachmentId: String,
    val filename: String,
    val mimeType: String,
    val sizeBytes: Long,
)

/** Where one attachment's fetch has got to. Per message, not per session. */
sealed interface PullState {
    /** Nothing asked for. The tile says the filename and its size. */
    data object Idle : PullState

    /** Slices are arriving. [received] of [total] bytes are in hand. */
    data class Pulling(val received: Long, val total: Long) : PullState

    /** The bytes are on the device at [uri], ready to hand to a viewer. */
    data class Ready(val uri: String) : PullState

    /** Nothing was saved. Retryable — the tile offers it. */
    data class Failed(val message: String) : PullState
}

/**
 * One file crossing the link, one slice at a time.
 *
 * WHY SLICES AT ALL: a frame carries ~94KiB and a phone photo is measured in
 * megabytes, so a whole-file fetch could only ever answer "too big". Paging
 * turns the frame budget into a per-request cost instead of a per-file verdict.
 *
 * The rules here are all about the same failure — a file that LOOKS complete and
 * is not:
 *  - A slice whose offset is not exactly where we are is REFUSED, not stored.
 *    A duplicate (a retry the link answered twice) would otherwise be appended
 *    a second time; a gap (an answer that overtook another) would be silently
 *    stitched over the hole. Either produces a plausible file that is corrupt.
 *  - Nothing is handed to a viewer before [done]. A partial image opens, renders
 *    half, and looks like the desktop sent something broken.
 *  - A failure keeps what arrived, so a retry resumes rather than restarting.
 *    On BLE that is the difference between a lost minute and a lost transfer.
 */
class AttachmentTransfer(val total: Long) {
    private val parts = mutableListOf<ByteArray>()

    /** Bytes accepted so far, which is also where the next slice must start. */
    var received: Long = 0L
        private set

    /** True once a slice arrived marked as the last one. */
    var done: Boolean = false
        private set

    /** Where to ask from next. Meaningless once [done]. */
    fun nextOffset(): Long = received

    /**
     * Take one slice. Returns false when it was not the slice we were waiting
     * for — the caller treats that as a stumble to retry, never as progress.
     */
    fun accept(offset: Long, bytes: ByteArray, eof: Boolean): Boolean {
        if (done) return false
        if (offset != received) return false
        parts += bytes
        received += bytes.size
        if (eof) done = true
        return true
    }

    /**
     * The whole file. Only meaningful once [done]; asking early would hand back
     * a truncated file that nothing downstream could tell from a complete one,
     * so it refuses instead.
     */
    fun bytes(): ByteArray {
        check(done) { "the transfer is not finished" }
        val out = ByteArray(received.toInt())
        var at = 0
        for (part in parts) {
            part.copyInto(out, at)
            at += part.size
        }
        return out
    }

    /** What the tile should say right now. */
    fun state(): PullState = PullState.Pulling(received, total)
}

/** How much to ask for at a time — inside the desktop's ~94KiB slice budget. */
const val ATTACHMENT_SLICE_BYTES = 64 * 1024
