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
    /** Stable per SESSION, or per ARTIFACT within one — see [Companion.notificationId]. */
    val notificationId: Int get() = notificationId(sessionId, artifactId)

    companion object {
        /**
         * A lock-screen row shows roughly this much before it is cut off anyway.
         * Shortening here rather than letting the system ellipsise means the text
         * is the same length in the shade, in the list and on the lock screen.
         */
        const val MAX_BODY = 140

        const val ELLIPSIS = "…"

        /**
         * The notification id is derived from the SESSION ID — plus the artifact
         * id, when the row belongs to one artifact rather than the session.
         *
         * That is the whole mechanism behind "ten buzzes from one session replace
         * rather than stack": Android replaces a notification posted with an id it
         * already holds. Keying on the kind or the timestamp would stack them, and
         * a phone showing ten rows for one session is worse than showing none.
         * The session-only derivation is unchanged so notifications posted by a
         * build before artifacts existed remain reachable by this one.
         *
         * Offset past [FOREGROUND_ID] so an alert can never displace the ongoing
         * link notification the foreground service owns.
         */
        fun notificationId(sessionId: String, artifactId: String? = null): Int {
            val key = if (artifactId == null) sessionId else sessionId + ARTIFACT_KEY_JOINER + artifactId
            return FOREGROUND_ID + 1 + (key.hashCode().toLong() - Int.MIN_VALUE).mod(ID_SPAN).toInt()
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

        /** Mirrors HelmLinkService's own notification id. */
        private const val FOREGROUND_ID = 1

        /**
         * Joins a session id and an artifact id into one hashed key. It cannot
         * appear in either (both are UUIDs on the wire), so "session `a`, artifact
         * `b`" can never collide with "session `ab`".
         */
        private const val ARTIFACT_KEY_JOINER = "#"

        /** Room for far more sessions than a phone will ever hold at once. */
        private const val ID_SPAN = 1_000_000L

        private val WHITESPACE = Regex("\\s+")
    }
}
