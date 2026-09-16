package com.potatomotato.helm.data

import com.potatomotato.helm.link.InMemoryPskStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the desktops screen reads.
 *
 * The desktop identifies itself with a random UUID and never sends a friendly
 * name, so every row the user sees is derived here. These tests pin the two
 * things that derivation must never get wrong: a row is only ever shown for a
 * desktop that is actually paired, and the name falls back to something a human
 * can tell apart rather than to an empty string.
 */
class PairedDesktopsTest {
    private val store = InMemoryPskStore()

    private fun pair(machineId: String) = store.save(machineId, ByteArray(32) { 1 })

    @Test
    fun `a desktop with no nickname is named from its machine id`() {
        pair("3f9c1a22-0b7e-4c1d-9a55-1f2e3d4c5b6a")

        val row = pairedDesktops(store, linkedMachineId = null).single()

        assertEquals("desktop-3f9c1a22", row.label)
        assertEquals("3f9c1a22-0b7e-4c1d-9a55-1f2e3d4c5b6a", row.machineId)
    }

    @Test
    fun `a nickname replaces the default, and clearing it restores the default`() {
        pair("abcdefgh-1111")
        store.setLabel("abcdefgh-1111", "Workshop PC")

        assertEquals("Workshop PC", pairedDesktops(store, null).single().label)

        // Blank is how the rename field says "no name of my own", and it must
        // fall back rather than render a row with nothing to tap on.
        store.setLabel("abcdefgh-1111", "   ")

        assertEquals("desktop-abcdefgh", pairedDesktops(store, null).single().label)
    }

    @Test
    fun `the linked desktop sorts first and is the only one marked linked`() {
        pair("aaaa1111")
        pair("bbbb2222")
        store.setLabel("aaaa1111", "Alpha")
        store.setLabel("bbbb2222", "Zulu")

        val rows = pairedDesktops(store, linkedMachineId = "bbbb2222")

        assertEquals(listOf("Zulu", "Alpha"), rows.map { it.label })
        assertEquals(listOf(true, false), rows.map { it.linked })
    }

    @Test
    fun `unlinked desktops are ordered by name, case insensitively`() {
        pair("1").also { store.setLabel("1", "zebra") }
        pair("2").also { store.setLabel("2", "Apple") }
        pair("3").also { store.setLabel("3", "mango") }

        val rows = pairedDesktops(store, linkedMachineId = null)

        assertEquals(listOf("Apple", "mango", "zebra"), rows.map { it.label })
    }

    @Test
    fun `a nickname left behind by a forgotten desktop is not listed`() {
        // Forgetting clears the nickname too, but a crash between the two writes
        // must not resurrect a desktop that has no key. The PSK is the only
        // thing that makes a pairing real.
        store.setLabel("ghost-machine", "Old Laptop")

        assertTrue(pairedDesktops(store, null).isEmpty())
    }

    @Test
    fun `nothing paired is an empty list, not a placeholder row`() {
        assertEquals(emptyList<PairedDesktop>(), pairedDesktops(store, linkedMachineId = "anything"))
    }
}
