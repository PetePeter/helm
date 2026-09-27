package com.potatomotato.helm.notify

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RingTicketTest {

    private val tickets = RingTicket()

    @Test
    fun `the ticket minted for a ring answers it exactly once`() {
        val ticket = tickets.issue("s1")
        assertTrue(tickets.redeem("s1", ticket))
        assertFalse(tickets.redeem("s1", ticket))
    }

    @Test
    fun `a forged, missing or other-session ticket is refused`() {
        val ticket = tickets.issue("s1")
        assertFalse(tickets.redeem("s1", null))
        assertFalse(tickets.redeem("s1", "guess"))
        assertFalse(tickets.redeem("s2", ticket))
    }

    @Test
    fun `a newer ring voids the older ring's ticket`() {
        val old = tickets.issue("s1")
        tickets.issue("s1")
        assertFalse(tickets.redeem("s1", old))
    }
}
