package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DraftStoreTest {

    // -- MemoryDraftStore: the semantics every implementation must hold --

    @Test
    fun `a saved draft loads back with its caret`() {
        val store = MemoryDraftStore()

        store.save("s1", Draft("book a flight", 13))

        assertEquals(Draft("book a flight", 13), store.load("s1"))
    }

    @Test
    fun `one session's draft never loads for another`() {
        val store = MemoryDraftStore()

        store.save("s1", Draft("for one", 3))

        assertNull(store.load("s2"))
    }

    @Test
    fun `a save overwrites, it does not append`() {
        val store = MemoryDraftStore()

        store.save("s1", Draft("first", 5))
        store.save("s1", Draft("second", 6))

        assertEquals(Draft("second", 6), store.load("s1"))
    }

    @Test
    fun `saving an empty draft clears the session`() {
        val store = MemoryDraftStore()

        store.save("s1", Draft("words", 5))
        store.save("s1", Draft("", 0))

        assertNull(store.load("s1"))
    }

    @Test
    fun `clear takes one session's draft, not its neighbour's`() {
        val store = MemoryDraftStore()

        store.save("s1", Draft("one", 3))
        store.save("s2", Draft("two", 3))
        store.clear("s1")

        assertNull(store.load("s1"))
        assertEquals(Draft("two", 3), store.load("s2"))
    }

    // -- DraftCodec: what PrefsDraftStore puts on disk --

    @Test
    fun `a draft survives the JSON round trip`() {
        val draft = Draft("héllo wörld", 4)

        assertEquals(draft, DraftCodec.decode(DraftCodec.encode(draft)))
    }

    @Test
    fun `a caret past the end is clamped, not crashed on`() {
        assertEquals(Draft("hi", 2), DraftCodec.decode(DraftCodec.encode(Draft("hi", 99))))
    }

    @Test
    fun `corrupt preferences read as no draft`() {
        assertNull(DraftCodec.decode("{not json"))
    }

    @Test
    fun `nothing stored reads as no draft`() {
        assertNull(DraftCodec.decode(null))
    }
}
