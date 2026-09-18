package com.potatomotato.helm.wire

/**
 * The application records that ride inside a SecureChannel message.
 *
 * This is the Kotlin half of `src/mobile/mobile-envelope.ts`, and the split is a
 * security boundary as much as a protocol one: everything the phone SENDS is a
 * [Call], including a chat reply, which is why "no path skips MobileGate" is
 * true by construction rather than by discipline.
 *
 * The SET of kinds is pinned by `tests/fixtures/mobile-envelope-vectors.json`;
 * adding one is a wire break, which is what protocol 3 was for.
 */
sealed interface MobileRecord {

    /** Phone -> Helm. A gated tool invocation. */
    data class Call(val id: String, val method: String, val params: Map<String, String>?) : MobileRecord

    /**
     * Helm -> phone. The gate's return value for one call id.
     *
     * [result] is the parsed-but-uninterpreted org.json value — a `JSONObject`,
     * a `JSONArray`, a boxed primitive, or null. The envelope's job is to say
     * WHICH call answered, not to know the shape of every tool's return; the
     * caller that issued the call knows what it asked for. Null means the tool
     * returned null.
     */
    data class Result(val id: String, val result: Any?) : MobileRecord

    /**
     * Helm -> phone. A download reply, and the ONE record that is not JSON.
     *
     * A download answers with FILE BYTES, and JSON can only carry those as
     * base64 — a third more wire, plus an encode and a decode, for nothing. At
     * 10 MB that was 111 round trips of inflated text; raw bytes make it ~11.
     *
     * Correlated by [id] exactly like a [Result], and settled through the same
     * pending map: to everything above [com.potatomotato.helm.link.HelmClient]
     * this is simply the answer to the call it issued.
     */
    data class Blob(
        val id: String,
        val filename: String,
        val mimeType: String,
        val bytes: ByteArray,
        /** The artifact version, when the body is an artifact rather than a slice. */
        val version: Int? = null,
        /** Where this slice starts in the file. Sliced fetches only. */
        val offset: Long? = null,
        /** The whole file's length. Sliced fetches only. */
        val total: Long? = null,
        /** True when nothing follows this slice. Sliced fetches only. */
        val eof: Boolean = false,
    ) : MobileRecord {
        // A ByteArray compares by identity, so the generated equals/hashCode
        // would call two identical slices different. Overridden rather than left
        // to surprise a future caller that puts one in a set.
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Blob) return false
            return id == other.id && filename == other.filename && mimeType == other.mimeType &&
                version == other.version && offset == other.offset && total == other.total &&
                eof == other.eof && bytes.contentEquals(other.bytes)
        }

        override fun hashCode(): Int {
            var result = id.hashCode()
            result = 31 * result + filename.hashCode()
            result = 31 * result + mimeType.hashCode()
            result = 31 * result + bytes.contentHashCode()
            result = 31 * result + (version ?: 0)
            result = 31 * result + (offset ?: 0L).hashCode()
            result = 31 * result + (total ?: 0L).hashCode()
            result = 31 * result + eof.hashCode()
            return result
        }
    }

    /**
     * Helm -> phone. A failure for one call id.
     *
     * Named `Failure` rather than `Error` so it cannot be confused with
     * [kotlin.Error] at a call site.
     */
    data class Failure(val id: String, val code: Int, val message: String) : MobileRecord

    /**
     * Helm -> phone. An unsolicited agent message. Carries no id: it answers nothing.
     *
     * [kind] splits this record in two, and the split matters more than it looks.
     * ABSENT means the agent said this — it belongs in the thread. PRESENT means
     * Helm is reporting an event (a state change, a flash) — it belongs in a
     * notification and MUST NOT enter the thread, or the phone grows a
     * conversation the desktop never had and nobody would ever see the drift.
     * Routed once, in [com.potatomotato.helm.link.HelmClient.onInbound].
     */
    data class Chat(
        val sessionId: String,
        val sessionName: String,
        val text: String,
        val at: Long,
        val filePath: String? = null,
        val voice: Boolean = false,
        val kind: String? = null,

        /**
         * The artifact a `kind: "artifact"` record is about, with its title. The
         * notification row is keyed on THIS, so several artifacts from one
         * session stack instead of overwriting each other. Null for every other
         * kind. Additive on the wire: the desktop emits them before `kind` and
         * omits them entirely when absent, so nothing else on the link changed.
         */
        val artifactId: String? = null,
        val title: String? = null,

        /**
         * An attached FILE, named by ids rather than by a path.
         *
         * [filePath] above is the desktop's own path for the same file and has
         * never been openable from here — it is another machine's filesystem.
         * These are what this end can act on: [artifactId] + [attachmentId]
         * address a `session_artifact_download`, which answers in slices, so a
         * file far larger than a frame still crosses. The name and size ride
         * along so a tile can be drawn before anything is fetched.
         */
        val attachmentId: String? = null,
        val filename: String? = null,
        val mimeType: String? = null,
        val sizeBytes: Long? = null,

        /**
         * This message's place in the desktop's global chat journal — what this
         * phone's catch-up cursor is measured against. Present on every message
         * the desktop journaled; ABSENT on alerts, which are never replayed, and
         * on records from an older desktop build. Absence must update nothing:
         * advancing the cursor past a message that was never held is exactly the
         * gap this field exists to close. The desktop emits it last, after
         * `sizeBytes`, so the additive rule held without regenerating vectors.
         */
        val seq: Long? = null,

        /**
         * Marks this record as a PHONE'S OWN message, echoed into the desktop's
         * journal when it accepted this phone's `session_send_text` call — the
         * value is that call's id, prefixed with the phone's machineId so two
         * phones that number their calls alike can never drop each other's
         * echoes. This end compares it against the ids it registered when it
         * SENT ([com.potatomotato.helm.data.ChatRepository.sent]) to drop its
         * own words on replay; absent on agent messages and alerts.
         */
        val originId: String? = null,

        /**
         * True ONLY on records streamed from the journal during catch-up — live
         * fan-out never carries it. Everything in a replay is, by construction,
         * old news this phone asked to be given, so it files without buzzing.
         * Absent (the default) means live. The message still reaches the thread
         * and the unread count either way.
         */
        val replay: Boolean = false,
    ) : MobileRecord

    /**
     * Helm -> phone. Where this desktop can be reached over the network.
     * Carries no id: it answers nothing.
     *
     * Arrives ONLY over the already-authenticated channel, which is the sole
     * reason the phone may believe it. An address learned any other way is not
     * an address — it is an invitation to dial someone else.
     *
     * An EMPTY list is meaningful and must be honoured: it says "stop dialling",
     * and it is how the desktop turning LAN off reaches a phone that is
     * connected right now. Treating empty as "no news" would leave the phone
     * hammering a port that is no longer open.
     */
    data class Lan(val addresses: List<String>) : MobileRecord
}

