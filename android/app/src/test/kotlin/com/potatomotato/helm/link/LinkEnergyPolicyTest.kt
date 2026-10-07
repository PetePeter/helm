package com.potatomotato.helm.link

import com.potatomotato.helm.ble.LinkScheduler
import com.potatomotato.helm.ble.RANK_BLE
import com.potatomotato.helm.ble.RANK_LAN
import com.potatomotato.helm.link.LinkEnergyPolicy.Phase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which radios are powered, as the link comes and goes.
 *
 * The real policy over a hand-stepped scheduler. Every assertion is a gate a
 * radio obeys — a wrong one here is either a phone that cannot be reached or a
 * battery spent on a radio nobody is using.
 */
class LinkEnergyPolicyTest {
    /** Queued actions, run by hand: the search window is the only timer there is. */
    private class ManualSchedule : LinkScheduler {
        val queued = mutableListOf<Pair<Long, () -> Unit>>()
        override fun schedule(delayMs: Long, action: () -> Unit) {
            queued += delayMs to action
        }

        /** Let every window queued so far run out, oldest first. */
        fun elapseAll() {
            val due = queued.toList()
            queued.clear()
            due.forEach { it.second() }
        }
    }

    private val schedule = ManualSchedule()
    private var searches = 0
    private val policy = LinkEnergyPolicy(schedule).also { it.onSearchStarted = { searches++ } }

    private val phase get() = policy.phase.value

    @Test
    fun `a build that never starts the policy keeps both radios working`() {
        assertEquals(Phase.Searching, phase)
        assertTrue(phase.bluetooth)
        assertTrue(phase.lanRetry)
        assertTrue(schedule.queued.isEmpty())
    }

    @Test
    fun `starting searches with both radios for fifteen minutes`() {
        policy.start()

        assertEquals(Phase.Searching, phase)
        assertEquals(1, searches)
        assertEquals(listOf(15 * 60 * 1000L), schedule.queued.map { it.first })
    }

    @Test
    fun `a search nothing answers gives up and powers both radios down`() {
        policy.start()

        schedule.elapseAll()

        assertEquals(Phase.GaveUp, phase)
        assertFalse(phase.bluetooth)
        assertFalse(phase.lanRetry)
    }

    @Test
    fun `linked over LAN turns Bluetooth off entirely`() {
        policy.start()

        policy.onLink(RANK_LAN)

        assertEquals(Phase.OnLan, phase)
        assertFalse(phase.bluetooth)
        assertFalse(phase.lanRetry)
    }

    @Test
    fun `linked over Bluetooth stops the LAN redial and keeps Bluetooth`() {
        policy.start()

        policy.onLink(RANK_BLE)

        assertEquals(Phase.OnBluetooth, phase)
        assertTrue(phase.bluetooth)
        assertFalse(phase.lanRetry)
    }

    @Test
    fun `a search window that runs out after the link came up does not drop the link`() {
        policy.start()
        policy.onLink(RANK_BLE)

        schedule.elapseAll()

        assertEquals(Phase.OnBluetooth, phase)
    }

    @Test
    fun `losing the link starts a fresh search with both radios`() {
        policy.start()
        policy.onLink(RANK_LAN)

        policy.onLink(null)

        assertEquals(Phase.Searching, phase)
        assertTrue(phase.bluetooth)
        assertEquals(2, searches)
    }

    @Test
    fun `the search after a lost link gets its own fifteen minutes`() {
        policy.start()
        policy.onLink(RANK_LAN)
        val firstWindow = schedule.queued.single().second
        schedule.queued.clear()
        policy.onLink(null)

        // The window opened before the link ever came up must not end this search.
        firstWindow()
        assertEquals(Phase.Searching, phase)

        schedule.elapseAll()
        assertEquals(Phase.GaveUp, phase)
    }

    @Test
    fun `a handover from Bluetooth to LAN ends with Bluetooth off`() {
        policy.start()
        policy.onLink(RANK_BLE)

        // The new transport's handshake has not finished: nothing is authenticated.
        policy.onLink(null)
        assertTrue("Bluetooth must survive until LAN is proven", phase.bluetooth)

        policy.onLink(RANK_LAN)
        assertEquals(Phase.OnLan, phase)
        assertFalse(phase.bluetooth)
    }

    @Test
    fun `re-arming after giving up searches again for a fresh fifteen minutes`() {
        policy.start()
        schedule.elapseAll()

        policy.rearm("the app was opened")

        assertEquals(Phase.Searching, phase)
        assertEquals(2, searches)
        schedule.elapseAll()
        assertEquals(Phase.GaveUp, phase)
    }

    @Test
    fun `re-arming during a search restarts its clock`() {
        policy.start()
        val firstWindow = schedule.queued.single().second
        schedule.queued.clear()

        policy.rearm("the network changed")
        firstWindow()

        assertEquals(Phase.Searching, phase)
    }

    @Test
    fun `re-arming while linked changes nothing and searches for nothing`() {
        policy.start()
        policy.onLink(RANK_LAN)

        policy.rearm("the app was opened")

        assertEquals(Phase.OnLan, phase)
        assertEquals(1, searches)
    }

    @Test
    fun `no link is not news to a phone that already gave up`() {
        policy.start()
        schedule.elapseAll()

        policy.onLink(null)

        assertEquals(Phase.GaveUp, phase)
        assertEquals(1, searches)
    }

    @Test
    fun `a link that arrives after giving up is taken`() {
        policy.start()
        schedule.elapseAll()

        policy.onLink(RANK_LAN)

        assertEquals(Phase.OnLan, phase)
    }
}
