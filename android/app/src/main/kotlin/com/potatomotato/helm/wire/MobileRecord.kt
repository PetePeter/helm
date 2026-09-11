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

    /** Helm -> phone. An unsolicited agent message. Carries no id: it answers nothing. */
    data class Chat(
        val sessionId: String,
        val sessionName: String,
        val text: String,
        val at: Long,
        val filePath: String? = null,
        val voice: Boolean = false,
    ) : MobileRecord
}
