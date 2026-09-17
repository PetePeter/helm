package com.potatomotato.helm.ui.artifacts

/**
 * Which targets may leave the app, and where a bare URL in prose begins and ends.
 *
 * A link's target is written by an agent as often as by the user, and invariant 9
 * says that content is untrusted — so the phone hands the system resolver an
 * ALLOW-LIST of schemes and nothing else. `javascript:`, `intent:`, `file:` and
 * `data:` are the ones that turn "open a page" into something else entirely, and
 * refusing everything unknown means a scheme invented tomorrow is refused too.
 *
 * Pure Kotlin and Android-free like [MarkdownRules]: what counts as a link is the
 * part worth testing, and it tests on the JVM.
 */
object LinkRules {

    /** A bare URL found in prose: the text that is the link, and where it ends. */
    data class Autolink(val url: String, val end: Int)

    /**
     * The target as it may be handed on, or null if it may not be.
     *
     * Whitespace around it is the writer's, not the URL's, and is dropped;
     * whitespace INSIDE it means the target is really two things, which is a
     * refusal rather than a guess at which half was meant.
     */
    fun resolve(target: String): String? {
        val trimmed = target.trim()
        if (trimmed.any { it.isWhitespace() || it.isISOControl() }) return null
        val scheme = SCHEMES.firstOrNull { trimmed.startsWith(it, ignoreCase = true) } ?: return null
        return if (trimmed.length > scheme.length) trimmed else null
    }

    /**
     * The bare URL starting at [from], if one starts there.
     *
     * It runs to the next whitespace, then gives back the punctuation that
     * belongs to the sentence rather than to the URL. A closing paren is only
     * sentence punctuation when the URL did not open one itself — `(see
     * https://x)` versus a wiki link that carries `(b)` in its own path.
     */
    fun autolink(text: String, from: Int): Autolink? {
        val scheme = SCHEMES.firstOrNull { text.startsWith(it, from, ignoreCase = true) } ?: return null
        var end = from
        while (end < text.length && !text[end].isWhitespace()) end++
        val floor = from + scheme.length
        while (end > floor && isSentencePunctuation(text, from, end)) end--
        if (end <= floor) return null
        val url = text.substring(from, end)
        return resolve(url)?.let { Autolink(it, end) }
    }

    /** Whether the character before [end] is the sentence's, not the URL's. */
    private fun isSentencePunctuation(text: String, from: Int, end: Int): Boolean {
        val last = text[end - 1]
        if (last !in TRAILING) return false
        if (last != ')') return true
        val body = text.substring(from, end)
        return body.count { it == '(' } < body.count { it == ')' }
    }

    /** `://` included: a scheme with no authority is not a page to open. */
    private val SCHEMES = listOf("https://", "http://")

    /** Punctuation a writer puts AFTER a URL, never inside one. */
    private const val TRAILING = ".,;:!?\"')]}>"
}
