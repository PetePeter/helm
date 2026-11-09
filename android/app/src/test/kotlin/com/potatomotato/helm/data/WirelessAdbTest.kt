package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WirelessAdbTest {
    @Test
    fun `a granted tap writes the inverse of the current setting`() {
        val settings = FakeSettings(enabled = true)
        val adb = wirelessAdb(settings = settings, writeGranted = true)

        assertEquals(WirelessAdbToggleResult.Updated(false), adb.toggle())
        assertEquals(listOf(false), settings.writes)
        assertFalse(adb.readState().enabled)

        assertEquals(WirelessAdbToggleResult.Updated(true), adb.toggle())
        assertEquals(listOf(false, true), settings.writes)
        assertTrue(adb.readState().enabled)
    }

    @Test
    fun `without secure settings grant a tap requests developer options and never writes`() {
        val settings = FakeSettings(enabled = false)
        val adb = wirelessAdb(settings = settings, writeGranted = false)

        assertEquals(WirelessAdbToggleResult.NeedsDeveloperOptions, adb.toggle())
        assertTrue(settings.writes.isEmpty())
        assertFalse(settings.enabled)
    }

    @Test
    fun `each read reflects the current secure setting and only includes the IP while enabled`() {
        val settings = FakeSettings(enabled = true, localIp = "192.0.2.7")
        val adb = wirelessAdb(settings = settings, writeGranted = true)

        assertEquals(WirelessAdbState(supported = true, enabled = true, localIp = "192.0.2.7"), adb.readState())
        settings.enabled = false
        assertEquals(WirelessAdbState(supported = true, enabled = false, localIp = null), adb.readState())
    }

    @Test
    fun `Android 10 does not read or write the unsupported setting`() {
        val settings = FakeSettings(enabled = true)
        val adb = wirelessAdb(settings = settings, writeGranted = true, apiLevel = 29)

        assertEquals(WirelessAdbState(supported = false, enabled = false, localIp = null), adb.readState())
        assertEquals(WirelessAdbToggleResult.Unsupported, adb.toggle())
        assertEquals(0, settings.reads)
        assertTrue(settings.writes.isEmpty())
    }

    @Test
    fun `a failed secure settings write is reported without claiming the new state`() {
        val settings = FakeSettings(enabled = false, writeSucceeds = false)
        val adb = wirelessAdb(settings = settings, writeGranted = true)

        assertEquals(WirelessAdbToggleResult.Failed, adb.toggle())
        assertEquals(listOf(true), settings.writes)
        assertFalse(adb.readState().enabled)
    }

    private fun wirelessAdb(
        settings: FakeSettings,
        writeGranted: Boolean,
        apiLevel: Int = 30,
    ) = WirelessAdb(
        apiLevel = apiLevel,
        hasWritePermission = { writeGranted },
        settings = settings,
    )

    private class FakeSettings(
        var enabled: Boolean,
        private val localIp: String? = null,
        private val writeSucceeds: Boolean = true,
    ) : WirelessAdbSettingsSink {
        val writes = mutableListOf<Boolean>()
        var reads = 0
            private set

        override fun readEnabled(): Boolean {
            reads++
            return enabled
        }

        override fun writeEnabled(enabled: Boolean): Boolean {
            writes += enabled
            if (writeSucceeds) this.enabled = enabled
            return writeSucceeds
        }

        override fun localWifiIp(): String? = localIp
    }
}