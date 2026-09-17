package com.potatomotato.helm.wire

/**
 * The four application records that ride inside a SecureChannel message.
 *
 * This is the Kotlin half of `src/mobile/mobile-envelope.ts`, and the split is a
 * security boundary as much as a protocol one: everything the phone SENDS is a
 * [Call], including a chat reply, which is why "no path skips MobileGate" is
 * true by construction rather than by discipline.
 *
 * There are exactly four kinds and there will not be a fifth without a wire
 * break — the set is pinned by `tests/fixtures/mobile-envelope-vectors.json`.
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

