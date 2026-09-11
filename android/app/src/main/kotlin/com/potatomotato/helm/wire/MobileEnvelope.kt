package com.potatomotato.helm.wire

import org.json.JSONObject

/**
 * MobileEnvelope — the phone's half of the application record codec.
 *
 * THIS CROSSES THE WIRE. The desktop encoder is `src/mobile/mobile-envelope.ts`,
 * the two sides were built without ever meeting, and both are pinned to the
 * committed vectors at `tests/fixtures/mobile-envelope-vectors.json`. Changing a
 * field name, a key order or a type here is a wire break.
 *
 * Two rules carry the whole design:
 *
 * KEY ORDER IS PART OF THE FORMAT, so encoding is written by hand rather than
 * handed to [JSONObject]. org.json stores keys in a hash map and will happily
 * emit them in an order the desktop never produces; a JSON object is unordered
 * by spec, but byte-identical conformance vectors are not.
 *
 * DECODING NEVER THROWS. A malformed record from a paired-but-buggy desktop —
 * or from a newer protocol version — is dropped and returns null. Anything else
 * would let one bad payload take down a link that is otherwise healthy.
 */
object MobileEnvelope {

    /** Bumped only for a breaking change to these records. */
    const val VERSION = 1

    /**
     * Refuse absurd records before allocating anything. 1 MiB of JSON is already
     * four times the BLE framing cap, so anything larger is a bug or an attack.
     */
    const val MAX_ENVELOPE_BYTES = 1024 * 1024

    /**
     * Encode one call.
     *
     * Param VALUES are typed — string, integer or boolean — because the desktop's
     * tool schemas are typed and its dispatcher checks `typeof`. `session_read_terminal`
     * is the case that forced it: `lines` is a number there, and a quoted "200"
     * is not rejected, it is silently IGNORED and the call quietly returns the
     * default tail. A wrong answer that looks right is the worst failure this
     * link can produce, so the codec carries the type rather than hoping.
     *
     * This is NOT a wire break: the desktop decoder types `params` as `unknown`
     * and JSON-parses it, and every committed vector has string-only params, so
     * those re-encode byte for byte. Key ORDER is still part of the format.
     *
     * Pass a [LinkedHashMap] (or any ordered map) — iteration order becomes wire
     * order.
     */
    fun encodeCall(id: String, method: String, params: Map<String, Any>? = null): ByteArray {
        val json = StringBuilder()
        json.append("{\"v\":").append(VERSION)
        json.append(",\"t\":\"call\"")
        json.append(",\"id\":").appendJsonString(id)
        json.append(",\"method\":").appendJsonString(method)
        if (params != null) {
            json.append(",\"params\":{")
            params.entries.forEachIndexed { index, (key, value) ->
                if (index > 0) json.append(',')
                json.appendJsonString(key).append(':').appendJsonValue(value)
            }
            json.append('}')
        }
        json.append('}')
        return json.toString().toByteArray(Charsets.UTF_8)
    }

    /** Parse one record, or null for anything this build does not understand. */
    fun decode(payload: ByteArray): MobileRecord? {
        if (payload.isEmpty() || payload.size > MAX_ENVELOPE_BYTES) return null

        // A ByteArray's own toString() is its object identity, never its text.
        val record = try {
            JSONObject(payload.toString(Charsets.UTF_8))
        } catch (_: Exception) {
            // Not JSON, or JSON that is not an object — an array lands here too.
            return null
        }

        if (record.opt("v") != VERSION) return null

        return when (record.opt("t")) {
            "call" -> decodeCall(record)
            "result" -> decodeResult(record)
            "error" -> decodeFailure(record)
            "chat" -> decodeChat(record)
            else -> null
        }
    }

    private fun decodeCall(record: JSONObject): MobileRecord.Call? {
        val id = record.string("id") ?: return null
        val method = record.string("method") ?: return null
        val params = (record.opt("params") as? JSONObject)?.let { raw ->
            raw.keys().asSequence().associateWithTo(LinkedHashMap()) { raw.optString(it) }
        }
        return MobileRecord.Call(id, method, params)
    }

    private fun decodeResult(record: JSONObject): MobileRecord.Result? {
        val id = record.string("id") ?: return null
        if (!record.has("result")) return null
        // Left as the raw org.json value on purpose: the envelope says WHICH call
        // answered, and the caller that issued it knows the shape to expect.
        val value = record.opt("result")
        return MobileRecord.Result(id, if (value == JSONObject.NULL) null else value)
    }

    private fun decodeFailure(record: JSONObject): MobileRecord.Failure? {
        val id = record.string("id") ?: return null
        val error = record.opt("error") as? JSONObject ?: return null
        val code = error.opt("code") as? Number ?: return null
        val message = error.string("message") ?: return null
        return MobileRecord.Failure(id, code.toInt(), message)
    }

    private fun decodeChat(record: JSONObject): MobileRecord.Chat? {
        val sessionId = record.string("sessionId") ?: return null
        val sessionName = record.string("sessionName") ?: return null
        val text = record.string("text") ?: return null
        val at = record.opt("at") as? Number ?: return null
        return MobileRecord.Chat(
            sessionId = sessionId,
            sessionName = sessionName,
            text = text,
            at = at.toLong(),
            filePath = record.string("filePath"),
            voice = record.opt("voice") == true,
        )
    }

    /**
     * A STRING, not a value coerced to one. `optString` turns the numeric id in
     * the reject vectors into "7" and would let a malformed record through.
     */
    private fun JSONObject.string(key: String): String? = opt(key) as? String

    /**
     * One param value. Unsupported types THROW rather than fall back to
     * `toString()`: a silently stringified value is exactly the failure this
     * typing exists to prevent, and it would only surface as a call that does
     * nothing. The caller is code in this app, so the bug is fixable at source.
     */
    private fun StringBuilder.appendJsonValue(value: Any): StringBuilder = when (value) {
        is String -> appendJsonString(value)
        is Int, is Long -> append(value.toString())
        is Boolean -> append(if (value) "true" else "false")
        else -> throw IllegalArgumentException(
            "unsupported param type ${value.javaClass.simpleName}; use String, Int, Long or Boolean",
        )
    }

    private fun StringBuilder.appendJsonString(value: String): StringBuilder {
        append('"')
        for (char in value) {
            when {
                char == '"' -> append("\\\"")
                char == '\\' -> append("\\\\")
                char == '\n' -> append("\\n")
                char == '\r' -> append("\\r")
                char == '\t' -> append("\\t")
                char == '\b' -> append("\\b")
                char == '\u000C' -> append("\\f")
                // Everything else non-printable goes long-form, exactly as
                // JSON.stringify does. Non-ASCII is emitted as UTF-8, NOT escaped.
                char < ' ' -> append(String.format("\\u%04x", char.code))
                else -> append(char)
            }
        }
        return append('"')
    }
}
