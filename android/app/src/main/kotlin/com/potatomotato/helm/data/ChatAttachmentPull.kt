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

    /**
     * The bytes are on the device. [location] is where a person will look for
     * them; [uri] is what a viewer or a decoder needs to open them.
     */
    data class Ready(val location: String, val uri: String) : PullState

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

    /** Slices that arrived ahead of the gap, keyed by where they start. */
    private val early = mutableMapOf<Long, ByteArray>()

    /** Offsets asked for and not yet answered. The pipeline's window. */
    private val asked = mutableSetOf<Long>()

    /** Where the file ends, once an `eof` slice has said so. */
    private var end: Long? = null

    /** The first offset never yet asked for. Rewound by [forgetAsks]. */
    private var requested: Long = 0L

    /** Contiguous bytes in hand — what the progress bar honestly shows. */
    var received: Long = 0L
        private set

    /** True once every byte up to the end has been taken in order. */
    var done: Boolean = false
        private set

    /** Where to ask from next — the front of the gap. Used by a retry. */
    fun nextOffset(): Long = received

    /**
     * The next offset to ASK for, or null when there is nothing to ask right
     * now — the window is full, or the end is known and already requested.
     *
     * PIPELINING IS THE POINT. A round trip on this link costs far more than the
     * bytes do, so up to [window] asks are kept in flight; a strictly serial
     * loop spends most of its life waiting. Answers may then arrive out of
     * order, which is why [accept] holds early slices instead of refusing them.
     */
    fun nextAsk(sliceBytes: Int, window: Int): Long? {
        if (done || asked.size >= window) return null
        // Once the end is known, there is nothing beyond it to ask for. Until
        // then the advertised size is only a hint — the file on disk is the
        // authority — so asking up to it, and once past it, is correct.
        end?.let { if (requested >= it) return null }
        if (end == null && requested > total) return null

        val from = requested
        requested += sliceBytes
        asked += from
        return from
    }

    /**
     * Take one slice. Returns false only when the slice is not one we are
     * waiting for — a duplicate, or an offset nobody asked for. Out-of-ORDER is
     * expected and held, not refused: with several asks in flight the answers
     * race each other, and refusing the fast one would throw away work.
     */
    fun accept(offset: Long, bytes: ByteArray, eof: Boolean): Boolean {
        if (done) return false
        if (!asked.remove(offset)) return false
        // The EARLIEST eof wins. An ask that was already in flight past the real
        // tail answers empty-and-eof at a larger offset; letting that move the
        // end would leave a transfer that can never complete.
        if (eof) end = minOf(end ?: Long.MAX_VALUE, offset + bytes.size)

        if (offset == received) {
            parts += bytes
            received += bytes.size
            drain()
        } else {
            early[offset] = bytes
        }

        if (received >= (end ?: Long.MAX_VALUE)) done = true
        return true
    }

    /** Fold in whatever already arrived beyond the gap we have just closed. */
    private fun drain() {
        while (true) {
            val next = early.remove(received) ?: return
            parts += next
            received += next.size
        }
    }

    /**
     * Abandon the asks in flight and rewind to the gap. Answers to the
     * abandoned asks are refused on arrival, so a retry cannot double-count a
     * slice that was merely late.
     */
    fun forgetAsks() {
        asked.clear()
        early.clear()
        requested = received
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

/**
 * How much to ask for at a time. The desktop refuses anything past its slice
 * budget (`ARTIFACT_DOWNLOAD_MAX_DECODED_BYTES`, 96,768 bytes — the largest
 * body that base64-encodes inside one 128KiB wire frame), so this sits just
 * under it. Asking for less would only buy more round trips, and round trips
 * are the expensive part: 64KiB used to cost one for every 64KiB of file.
 */
const val ATTACHMENT_SLICE_BYTES = 93 * 1024

/**
 * How many asks may be in flight at once.
 *
 * A round trip costs far more than the bytes on this link, so the win is in not
 * waiting. Four is deliberate restraint rather than a tuned number: the
 * desktop's per-device budget is 120 calls a minute, and a deeper window would
 * spend it on one file while the rest of the app still has to work.
 */
const val ATTACHMENT_PIPELINE = 4
