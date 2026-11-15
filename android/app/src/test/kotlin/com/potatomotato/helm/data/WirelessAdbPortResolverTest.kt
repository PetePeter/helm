package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WirelessAdbPortResolverTest {
    @Test
    fun `uses a valid port advertised by the phone's Wi-Fi address`() {
        assertEquals(35007, wirelessAdbPortFor("10.98.1.10", "10.98.1.10", 35007))
    }

    @Test
    fun `ignores services advertised by another device`() {
        assertNull(wirelessAdbPortFor("10.98.1.10", "10.98.1.11", 35007))
    }

    @Test
    fun `ignores invalid ports`() {
        assertNull(wirelessAdbPortFor("10.98.1.10", "10.98.1.10", 0))
        assertNull(wirelessAdbPortFor("10.98.1.10", "10.98.1.10", 65536))
    }

    @Test
    fun `holds Wi-Fi multicast only before Android T extension 7`() {
        assertTrue(needsWifiMulticastLock(apiLevel = 32, tiramisuExtensionLevel = 0))
        assertTrue(needsWifiMulticastLock(apiLevel = 33, tiramisuExtensionLevel = 6))
        assertFalse(needsWifiMulticastLock(apiLevel = 33, tiramisuExtensionLevel = 7))
        assertFalse(needsWifiMulticastLock(apiLevel = 34, tiramisuExtensionLevel = 0))
    }
}
