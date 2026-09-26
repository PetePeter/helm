package com.potatomotato.helm.voice

/**
 * "Hey Helm" as the built-in recogniser actually writes it down.
 *
 * Android's STT is not a wake-word engine, so the phrase arrives as whatever
 * words it guessed. The list is short on purpose: each extra spelling is another
 * way an ordinary sentence wakes the phone. "a home" is left out for exactly
 * that reason — it starts too many real sentences.
 */
private val WAKE = Regex(
    """^\s*(?:(?:hey|hay|hi)\s*,?\s+(?:helm|home|elm)|a\s+helm)(?![\p{L}\p{N}])[\s\p{Punct}]*(.*)$""",
    setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
)

/**
 * The question after the wake phrase — "" when the phrase was said alone — or
 * null when [utterance] does not start with it and must be ignored.
 */
fun stripWakePhrase(utterance: String): String? =
    WAKE.matchEntire(utterance)?.groupValues?.get(1)?.trim()
