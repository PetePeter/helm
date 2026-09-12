package com.potatomotato.helm.wire

import com.potatomotato.helm.log.HelmLog
import org.json.JSONArray
import org.json.JSONObject

/**
 * WireShape — what a tool result LOOKS like, for the times it is not what this
 * app expected.
 *
 * WHY it exists: every `*Wire.parse*` and every repository on the phone starts
 * with a cast — `result as? JSONArray ?: return null` — and every one of them
 * used to return that null in total silence. That silence is a bug in its own
 * right, independent of any particular defect: to every layer above,
 * "I could not understand the answer" and "there is nothing to show" are the
 * same empty screen. The desktop answers `ok`, the phone shows nothing, and
 * there is no third thing anywhere that says which happened.
 *
 * It matters more here than it would elsewhere because the two ends genuinely
 * can disagree about shape: a tool dispatched through Helm's JSON-RPC path is
 * wrapped by `normalizeStructuredContent` (a bare array becomes `{items: [...]}`)
 * while the same tool dispatched through `dispatchForPeer` — which is the
 * phone's path, and the Fleet proxy's — returns the value raw. Neither side can
 * see that fork from where it stands, and the committed envelope vectors cannot
 * catch it, because they pin the ENVELOPE and this fork is inside the payload.
 *
 * ## The rule
 *
 * Describe the CONTAINER, never the contents: a type, a count, and for an
 * object its KEY NAMES. That is the same boundary the desktop's mobile audit
 * draws when it records argument key names and never argument values.
 */
object WireShape {

    /**
     * A human description of a result's shape, safe to log.
     *
     * Key names are included because they are the single most useful thing for
     * diagnosing a shape mismatch — `[items]` would name the JSON-RPC wrapper
     * outright — and because a key name is a fact about the protocol, not about
     * the user. Values never appear.
     */
    fun describe(result: Any?): String = when (result) {
        null -> "null"
        is JSONArray -> "a JSON array of ${result.length()} entries"
        is JSONObject ->
            "a JSON object with ${result.length()} keys ${result.keys().asSequence().sorted().toList()}"
        is String -> "a string of ${result.length} characters"
        else -> "a ${result.javaClass.simpleName}"
    }

    /**
     * Report a result this app could not decode, and return null so the caller
     * reads as the failure it is.
     *
     * A WARNING rather than debug: an answer that arrived and could not be
     * understood is never routine, and it is invisible everywhere else.
     */
    fun <T> undecodable(what: String, expected: String, result: Any?): T? {
        HelmLog.w(
            HelmLog.WIRE,
            "could not decode $what: expected $expected but got ${describe(result)}",
        )
        return null
    }
}
