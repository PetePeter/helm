package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transport choice, as a value.
 *
 * This gates the RADIOS, so the case that matters most is the unreadable one: a
 * preference that fails to parse must never be the reason a phone cannot reach
 * its desktop at all.
 */
class TransportPreferenceTest {

    @Test
    fun `a fresh install is Auto`() {
        assertEquals(TransportPreference.Auto, TransportPreference.fromStored(null))
    }

    @Test
    fun `every choice round-trips through its stored spelling`() {
        for (preference in TransportPreference.entries) {
            assertEquals(preference, TransportPreference.fromStored(preference.stored))
        }
    }

    @Test
    fun `an unreadable stored value reads as Auto, not as a disabled radio`() {
        // A value from a newer build, or a corrupt preference. Falling back to
        // either forced mode would silently switch a radio off on upgrade.
        assertEquals(TransportPreference.Auto, TransportPreference.fromStored("WifiDirect"))
        assertEquals(TransportPreference.Auto, TransportPreference.fromStored(""))
        assertEquals(TransportPreference.Auto, TransportPreference.fromStored("lanonly"))
    }

    @Test
    fun `Auto permits both transports`() {
        assertTrue(TransportPreference.Auto.allowsLan)
        assertTrue(TransportPreference.Auto.allowsBluetooth)
    }

    @Test
    fun `each forced choice permits exactly one`() {
        assertTrue(TransportPreference.LanOnly.allowsLan)
        assertFalse(TransportPreference.LanOnly.allowsBluetooth)

        assertTrue(TransportPreference.BluetoothOnly.allowsBluetooth)
        assertFalse(TransportPreference.BluetoothOnly.allowsLan)
    }

    @Test
    fun `the live preference adopts what was stored and writes what is chosen`() {
        val store = MemoryTransportPreferenceStore(TransportPreference.BluetoothOnly)

        TransportPreferences.bind(store)
        assertEquals(TransportPreference.BluetoothOnly, TransportPreferences.preference.value)

        TransportPreferences.set(TransportPreference.LanOnly)
        assertEquals(TransportPreference.LanOnly, TransportPreferences.preference.value)
        assertEquals(TransportPreference.LanOnly, store.saved)

        // Restore the process-wide default; this is a singleton and the suite
        // shares it.
        TransportPreferences.bind(MemoryTransportPreferenceStore(TransportPreference.Auto))
    }
}

/** An in-memory store — the same shape the preferences implementation has. */
class MemoryTransportPreferenceStore(
    private var current: TransportPreference = TransportPreference.Auto,
) : TransportPreferenceStore {
    var saved: TransportPreference? = null
        private set

    override fun load(): TransportPreference = current

    override fun save(preference: TransportPreference) {
        saved = preference
        current = preference
    }
}
