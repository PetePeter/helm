package com.potatomotato.helm.notify

/**
 * What class of event buzzed the phone.
 *
 * Several, because the user must be able to silence them apart: "a session needs
 * you" and "a session went idle" are not the same interruption, and a single
 * channel forces the choice of all or nothing. The strings are the WIRE values
 * `src/mobile/mobile-envelope.ts` sends in the chat record's optional `kind` —
 * except [Message], which has no wire value because it is what a record with NO
 * kind means.
 */
enum class AlertKind(val wire: String, val channelId: String) {

    /** Needs you — a session waiting on input, or an explicit flash_attention. */
    Attention("attention", "helm_attention"),

    /**
     * Something an agent actually SAID, as opposed to an event Helm is reporting.
     *
     * The only kind the user can answer, which is why it is the only one that
     * carries a reply box. Its wire value is never sent by the desktop — a plain
     * chat record has no kind at all, and [fromWire] must never produce this from
     * an unrecognised string, or a future desktop event would arrive wearing a
     * reply box that replies to nothing.
     */
    Message("message", "helm_message"),

    /** A session finished. */
    Completion("completion", "helm_completion"),

    /** A session went quiet. */
    Idle("idle", "helm_idle"),

    /** A session produced or revised an artifact. */
    Artifact("artifact", "helm_artifact");

    /**
     * Attention alone wears the amber flash colour; everything else takes the
     * accent. This is the only consumer of [com.potatomotato.helm.ui.components.SessionState.Flash],
     * which has been wired but unreachable since there was no push path to reach it.
     */
    val isFlash: Boolean get() = this == Attention

    companion object {
        /**
         * An unrecognised kind is still an ALERT, classified as [Attention].
         *
         * A newer desktop that grows a fourth kind must not go silent on an older
         * phone — silence would read as "nothing happened", which is the one
         * thing this whole path exists to prevent. It also must never fall back
         * to the chat thread: a kind-bearing record is not something the agent
         * said, and putting it there would fabricate a conversation.
         */
        fun fromWire(value: String): AlertKind =
            entries.firstOrNull { it.wire == value } ?: Attention
    }
}

/**
 * One notification, as the user will read it on a lock screen.
 *
 * Built through [of] so the shortening and the id derivation happen exactly once,
 * off the Android framework, where they can be tested.
 */
data class Alert(
    val sessionId: String,
    val sessionName: String,
    val text: String,
    val kind: AlertKind,
    /**
     * The artifact this row is about, when [kind] is [AlertKind.Artifact]. It is
     * part of the row's IDENTITY: distinct artifacts from one session each own a
     * row, while the same artifact revised twice replaces its own.
     */
    val artifactId: String? = null,
) {
    /** Stable per SESSION and row kind, or per ARTIFACT within one. */
    val notificationId: Int get() = notificationId(sessionId, kind, artifactId)

    companion object {
        /**
         * A lock-screen row shows roughly this much before it is cut off anyway.
         * Shortening here rather than letting the system ellipsise means the text
         * is the same length in the shade, in the list and on the lock screen.
         */
        const val MAX_BODY = 140

        const val ELLIPSIS = "…"

        /** Notification ids 1..1,000,001 belong to other app surfaces or are reserved. */
        const val RESERVED_NOTIFICATION_ID_MAX = 1_000_001

        /**
         * Each kind has a disjoint id range; rows within it are keyed by session
         * and artifact id. Reposting one row updates it in place, while different
         * kinds can never evict each other.
         *
         * The generated range starts after the fixed ids used by foreground,
         * call, ring and other notification surfaces.
         */
        fun notificationId(sessionId: String, kind: AlertKind, artifactId: String? = null): Int {
            val key = if (artifactId == null) {
                "$sessionId$ARTIFACT_KEY_JOINER${kind.wire}"
            } else {
                "$sessionId$ARTIFACT_KEY_JOINER${kind.wire}$ARTIFACT_KEY_JOINER$artifactId"
            }
            val kindOffset = kind.ordinal.toLong() * ID_SPAN
            return RESERVED_NOTIFICATION_ID_MAX + 1 + kindOffset.toInt() +
                (key.hashCode().toLong() - Int.MIN_VALUE).mod(ID_SPAN).toInt()
        }

        fun of(
            sessionId: String,
            sessionName: String,
            text: String,
            kind: AlertKind,
            artifactId: String? = null,
        ): Alert = Alert(
            sessionId = sessionId,
            sessionName = sessionName,
            text = shorten(text),
            kind = kind,
            artifactId = artifactId,
        )

        /**
         * One line, bounded. Newlines are collapsed rather than kept because the
         * shade collapses them regardless — spending the budget on invisible
         * breaks would cut off words that would otherwise have fitted.
         */
        private fun shorten(text: String): String {
            val flat = text.replace(WHITESPACE, " ").trim()
            return if (flat.length <= MAX_BODY) flat else flat.take(MAX_BODY - 1).trimEnd() + ELLIPSIS
        }

        /**
         * Separates the parts of a hashed key. Session and artifact ids are UUIDs
         * on the wire, so this cannot occur in either value.
         */
        private const val ARTIFACT_KEY_JOINER = "#"

        /** Disjoint notification-id range per kind; five current kinds fit safely in Int. */
        private const val ID_SPAN = 400_000_000L

        private val WHITESPACE = Regex("\\s+")
    }
}
