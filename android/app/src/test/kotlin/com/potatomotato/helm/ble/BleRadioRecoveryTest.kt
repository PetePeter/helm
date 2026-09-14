package com.potatomotato.helm.ble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The radio on/off and bring-up retry policy, driven exactly the way the
 * service's receiver drives it. The service itself stays Android-only wiring.
 */
class BleRadioRecoveryTest {
    private val scheduler = FakeScheduler()
    private val logs = mutableListOf<String>()

    private var bringUps = 0
    private var standDowns = 0
    private var bringUpResult = false

    private val recovery = BleRadioRecovery(
        scheduler = scheduler,
        log = { logs.add(it) },
    ).apply {
        bringUp = { bringUps++; bringUpResult }
        standDown = { standDowns++ }
    }

    @Test
    fun `a successful first bring-up schedules nothing`() {
        bringUpResult = true
        recovery.onBluetoothState(true)

        recovery.start()

        assertTrue(recovery.up)
        assertEquals(1, bringUps)
        assertEquals(emptyList<Long>(), scheduler.delays)
    }

    @Test
    fun `a first bring-up with the radio off waits for bluetooth instead of retrying`() {
        recovery.onBluetoothState(false)

        recovery.start()

        assertEquals(1, bringUps)
        assertFalse(recovery.up)
        assertEquals(emptyList<Long>(), scheduler.delays)

        bringUpResult = true
        recovery.onBluetoothOn()

        assertTrue(recovery.up)
        assertEquals(2, bringUps)
    }

    @Test
    fun `a transient failure while the radio is on retries with backoff`() {
        recovery.onBluetoothState(true)

        recovery.start()
        assertEquals(listOf(1_000L), scheduler.delays)

        scheduler.runPending()
        assertEquals(listOf(1_000L, 2_000L), scheduler.delays)

        bringUpResult = true
        scheduler.runPending()

        assertTrue(recovery.up)
    }

    @Test
    fun `a link that never comes up gives up after the bounded retries`() {
        recovery.onBluetoothState(true)

        recovery.start()
        scheduler.runPending()
        scheduler.runPending()
        scheduler.runPending()

        // One initial attempt plus the full budget, then silence.
        assertEquals(4, bringUps)
        assertEquals(listOf(1_000L, 2_000L, 4_000L), scheduler.delays)

        scheduler.runPending()
        assertEquals(4, bringUps)
        assertFalse(recovery.up)
    }

    @Test
    fun `bluetooth off stands the link down and bluetooth on brings it back`() {
        bringUpResult = true
        recovery.onBluetoothState(true)
        recovery.start()
        assertTrue(recovery.up)

        recovery.onBluetoothOff()

        assertEquals(1, standDowns)
        assertFalse(recovery.up)

        recovery.onBluetoothOn()

        assertEquals(2, bringUps)
        assertTrue(recovery.up)
        assertEquals(emptyList<Long>(), scheduler.delays)
    }

    @Test
    fun `a retry still in flight is dropped when bluetooth turns off`() {
        recovery.onBluetoothState(true)
        recovery.start()
        assertEquals(listOf(1_000L), scheduler.delays)

        recovery.onBluetoothOff()
        assertEquals(0, standDowns)

        bringUpResult = true
        scheduler.runPending()

        // The stale retry must not bring the link up into a dead radio.
        assertEquals(1, bringUps)
        assertFalse(recovery.up)

        recovery.onBluetoothOn()

        assertTrue(recovery.up)
    }

    @Test
    fun `bluetooth on while the link is already up changes nothing`() {
        bringUpResult = true
        recovery.onBluetoothState(true)
        recovery.start()
        val before = bringUps

        recovery.onBluetoothOn()

        assertEquals(before, bringUps)
        assertEquals(0, standDowns)
        assertTrue(recovery.up)
    }

    @Test
    fun `a radio that comes back gets a fresh retry budget`() {
        recovery.onBluetoothState(true)
        recovery.start()
        scheduler.runPending()
        scheduler.runPending()
        scheduler.runPending()
        assertEquals(4, bringUps)

        bringUpResult = true
        recovery.onBluetoothOn()
        assertTrue(recovery.up)

        // The next outage starts over from a full budget: 1s first, not 8s.
        bringUpResult = false
        recovery.onBluetoothOff()
        recovery.onBluetoothOn()

        assertEquals(1_000L, scheduler.delays.last())
    }
}
