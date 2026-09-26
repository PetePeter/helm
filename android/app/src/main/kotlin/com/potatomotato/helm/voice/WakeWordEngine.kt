package com.potatomotato.helm.voice

import org.json.JSONObject

/**
 * "Hey Helm" standby's ear: listens for the wake phrase and nothing else.
 * A port, so the service's standby lifecycle does not depend on the engine.
 * Every callback arrives on the main thread.
 */
interface WakeWordEngine {
    /** Open the mic and listen. [onWake] fires once per detection; [onError] means standby cannot run. */
    fun start(onWake: () -> Unit, onError: (String) -> Unit)

    /** Close the mic. Idempotent; safe before [start] has finished loading. */
    fun stop()
}

/**
 * Decides whether one keyword-spotter result is a real "hey helm". Pure, so
 * the false-wake guard is pinned by tests.
 *
 * The recogniser runs a grammar of just `["hey helm", "[unk]"]`, so anything
 * else comes back as `[unk]` or empty. The guard on top: the final text must be
 * exactly the phrase, every word must clear [minConfidence], and a detection
 * within [cooldownMs] of the last one is ignored.
 */
class WakeDetector(
    private val minConfidence: Double = 0.75,
    private val cooldownMs: Long = 2_000,
) {
    private var lastWakeMs: Long? = null

    /** [resultJson] is a Vosk FINAL result with words enabled. */
    fun accept(resultJson: String, nowMs: Long): Boolean {
        val result = runCatching { JSONObject(resultJson) }.getOrNull() ?: return false
        if (result.optString("text").trim() != PHRASE) return false
        val words = result.optJSONArray("result") ?: return false
        if (words.length() == 0) return false
        for (i in 0 until words.length()) {
            if (words.getJSONObject(i).optDouble("conf", 0.0) < minConfidence) return false
        }
        val last = lastWakeMs
        if (last != null && nowMs - last < cooldownMs) return false
        lastWakeMs = nowMs
        return true
    }

    companion object {
        const val PHRASE = "hey helm"

        /** The keyword spotter's whole vocabulary: the phrase, or not-the-phrase. */
        const val GRAMMAR = "[\"$PHRASE\", \"[unk]\"]"
    }
}
