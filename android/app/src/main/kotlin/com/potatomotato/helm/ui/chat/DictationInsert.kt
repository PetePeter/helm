package com.potatomotato.helm.ui.chat

/**
 * Where dictated words go in a half-typed draft, and what a later guess replaces.
 *
 * The recogniser streams PARTIALS while the user holds the mic, and each partial
 * is its whole current guess rather than the new words — "book", "book a", "book
 * a fight", "book a flight". Appending them produces the classic stutter, and
 * correcting the third guess means the fourth must be able to take its place. So
 * the press captures the draft as a [Dictation]: the text before the caret, the
 * text after it, and nothing in between. Every guess is then simply rendered
 * against that anchor, and the words the user typed around it never move.
 *
 * Pure Kotlin like every other `*Rules`-shaped module here: the spacing and the
 * caret are the parts worth pinning, and they pin on the JVM.
 */
object DictationInsert {

    /**
     * Anchor a dictation at the current selection.
     *
     * A selection is a replacement: speaking with words highlighted swaps them,
     * the same as typing would. Out-of-range or reversed selections are coerced
     * rather than thrown on — a caret is not worth crashing a composer over.
     */
    fun begin(text: String, selectionStart: Int, selectionEnd: Int): Dictation {
        val lo = selectionStart.coerceIn(0, text.length)
        val hi = selectionEnd.coerceIn(0, text.length)
        return Dictation(
            prefix = text.substring(0, minOf(lo, hi)),
            suffix = text.substring(maxOf(lo, hi)),
        )
    }
}

/** A draft held open around the spot the dictated words are landing in. */
data class Dictation(val prefix: String, val suffix: String) {

    /**
     * The draft as it reads with [transcript] in the gap, and where the caret
     * sits afterwards — always at the end of the dictated words, which is where
     * the user would keep typing.
     *
     * Spacing is added only where the writer would have to type it: a word
     * spoken after "see " needs nothing, after "see" needs a space. A blank
     * transcript — the moment between the press and the first guess, or a
     * cancelled dictation — restores the draft exactly, spaces included.
     */
    fun with(transcript: String): Draft {
        val spoken = transcript.trim()
        if (spoken.isEmpty()) return Draft(prefix + suffix, prefix.length)

        val lead = if (prefix.isNotEmpty() && !prefix.last().isWhitespace()) " " else ""
        val trail = if (suffix.isNotEmpty() && !suffix.first().isWhitespace()) " " else ""
        val inserted = lead + spoken + trail
        return Draft(prefix + inserted + suffix, prefix.length + lead.length + spoken.length)
    }
}

/** A composer draft: its text, and where the caret is in it. */
data class Draft(val text: String, val caret: Int)
