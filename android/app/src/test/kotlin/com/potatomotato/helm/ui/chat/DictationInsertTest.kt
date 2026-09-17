package com.potatomotato.helm.ui.chat

import com.potatomotato.helm.data.Draft
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Dictation landing in a half-typed draft.
 *
 * The cases that matter are the ones a stream of partials creates: the same
 * anchor rendered again and again with a better guess each time, around text the
 * user typed themselves and must get back untouched.
 */
class DictationInsertTest {

    @Test
    fun `speaking into an empty draft is just the words`() {
        val dictation = DictationInsert.begin("", 0, 0)

        assertEquals(Draft("book a flight", 13), dictation.with("book a flight"))
    }

    @Test
    fun `every partial replaces the last rather than appending`() {
        val dictation = DictationInsert.begin("", 0, 0)

        val drafts = listOf("book", "book a", "book a fight", "book a flight").map(dictation::with)

        assertEquals(Draft("book a flight", 13), drafts.last())
        // The stutter this exists to prevent.
        assertEquals(Draft("book", 4), drafts.first())
    }

    @Test
    fun `words spoken at the caret keep the text on both sides`() {
        val dictation = DictationInsert.begin("hello world", 6, 6)

        assertEquals(Draft("hello there world", 11), dictation.with("there"))
    }

    @Test
    fun `a space the user already typed is not doubled`() {
        val dictation = DictationInsert.begin("see ", 4, 4)

        assertEquals(Draft("see this", 8), dictation.with("this"))
    }

    @Test
    fun `speaking at the end of a word separates them`() {
        val dictation = DictationInsert.begin("see", 3, 3)

        assertEquals(Draft("see this", 8), dictation.with("this"))
    }

    @Test
    fun `a selection is replaced by what was said`() {
        // "world" highlighted.
        val dictation = DictationInsert.begin("hello world", 6, 11)

        assertEquals(Draft("hello there", 11), dictation.with("there"))
    }

    @Test
    fun `a backwards selection means the same range`() {
        val dictation = DictationInsert.begin("hello world", 11, 6)

        assertEquals(Draft("hello there", 11), dictation.with("there"))
    }

    @Test
    fun `nothing heard yet leaves the draft exactly as it was`() {
        val dictation = DictationInsert.begin("hello world", 6, 6)

        assertEquals(Draft("hello world", 6), dictation.with(""))
        assertEquals(Draft("hello world", 6), dictation.with("   "))
    }

    @Test
    fun `a cancelled dictation gives a selection back as empty, not as the words`() {
        // Cancelling after highlighting is a deletion the user can undo by
        // typing; leaving the old words would be the app disagreeing with what
        // the screen showed while they spoke.
        val dictation = DictationInsert.begin("hello world", 6, 11)

        assertEquals(Draft("hello ", 6), dictation.with(""))
    }

    @Test
    fun `the recogniser's own padding is not the draft's`() {
        val dictation = DictationInsert.begin("see", 3, 3)

        assertEquals(Draft("see this", 8), dictation.with("  this  "))
    }

    @Test
    fun `a caret past the end of the text is coerced, not thrown on`() {
        val dictation = DictationInsert.begin("hi", 99, 99)

        assertEquals(Draft("hi there", 8), dictation.with("there"))
    }
}
