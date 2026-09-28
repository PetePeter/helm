package com.potatomotato.helm.ui.control

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Start button's debounce: two taps must never be two sessions. */
class SpawnTapLatchTest {

    @Test
    fun `stays held while the spawn is in flight, however long it takes`() {
        assertNull(SpawnTapLatch.releaseInMs(tappedAtMs = 0, inFlight = true, nowMs = 60_000))
    }

    @Test
    fun `an instant answer still holds for the rest of the minimum`() {
        assertEquals(SpawnTapLatch.HOLD_MS - 200, SpawnTapLatch.releaseInMs(tappedAtMs = 1_000, inFlight = false, nowMs = 1_200))
    }

    @Test
    fun `a slow answer releases at once`() {
        assertEquals(0L, SpawnTapLatch.releaseInMs(tappedAtMs = 0, inFlight = false, nowMs = SpawnTapLatch.HOLD_MS + 5_000))
    }
}
