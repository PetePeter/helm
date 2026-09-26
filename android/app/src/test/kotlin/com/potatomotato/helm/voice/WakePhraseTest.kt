package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The built-in recogniser is not a wake-word engine: it hears "Hey Helm" as
 * whatever it thinks the words were. These are the spellings it actually
 * produces, and the near-misses that must NOT wake a phone in someone's pocket.
 */
class WakePhraseTest {
    @Test
    fun `the phrase is matched in any case and stripped with its punctuation`() {
        assertEquals("is the build done?", stripWakePhrase("Hey Helm, is the build done?"))
        assertEquals("is the build done", stripWakePhrase("hey helm is the build done"))
        assertEquals("status", stripWakePhrase("HEY HELM. status"))
    }

    @Test
    fun `the recogniser's usual mishearings still wake`() {
        listOf("hey home what's up", "a helm what's up", "hi helm what's up", "hay helm what's up", "hey elm what's up")
            .forEach { assertEquals(it, "what's up", stripWakePhrase(it)) }
    }

    @Test
    fun `the phrase alone leaves an empty question`() {
        assertEquals("", stripWakePhrase("Hey Helm"))
        assertEquals("", stripWakePhrase("  hey helm!  "))
    }

    @Test
    fun `speech that does not start with the phrase is ignored`() {
        assertNull(stripWakePhrase("what is the build doing"))
        assertNull(stripWakePhrase("I said hey helm earlier"))
        assertNull(stripWakePhrase("a home is where"))
        assertNull(stripWakePhrase("hey helmet"))
        assertNull(stripWakePhrase(""))
    }
}
