package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * parseLanAddress — the one place a pushed address becomes something dialled.
 *
 * Strictness is the point: an address the phone half-understands is an address
 * it might dial wrongly, and the wrong end of a socket is a stranger.
 */
class LanAddressStoreTest {

    @Test
    fun `splits an ordinary host and port`() {
        assertEquals(LanAddress("192.168.1.20", 47475), parseLanAddress("192.168.1.20:47475"))
    }

    @Test
    fun `tolerates surrounding whitespace`() {
        assertEquals(LanAddress("10.8.0.4", 47475), parseLanAddress("  10.8.0.4:47475 "))
    }

    @Test
    fun `splits at the LAST colon so a bracketed IPv6 literal survives`() {
        assertEquals(LanAddress("[fe80::1]", 47475), parseLanAddress("[fe80::1]:47475"))
    }

    @Test
    fun `refuses an address with no port rather than inventing one`() {
        assertNull(parseLanAddress("192.168.1.20"))
        assertNull(parseLanAddress("192.168.1.20:"))
    }

    @Test
    fun `refuses a port that is not a number or not a port`() {
        assertNull(parseLanAddress("192.168.1.20:http"))
        assertNull(parseLanAddress("192.168.1.20:0"))
        assertNull(parseLanAddress("192.168.1.20:70000"))
        assertNull(parseLanAddress("192.168.1.20:-1"))
    }

    @Test
    fun `refuses an empty host`() {
        assertNull(parseLanAddress(":47475"))
        assertNull(parseLanAddress(""))
    }
}
