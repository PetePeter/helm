package com.potatomotato.helm.ui.operator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OperatorKeyTest {
    private val min = 60_000L
    private val now = 100 * min

    @Test
    fun `no operator is unavailable, never a dial`() {
        assertEquals(OperatorKeyAction.Unavailable, OperatorKeyAction.decide(operatorId = null, liveCallTarget = null))
    }

    @Test
    fun `an idle line dials the operator`() {
        assertEquals(OperatorKeyAction.Dial("helm"), OperatorKeyAction.decide(operatorId = "helm", liveCallTarget = null))
    }

    @Test
    fun `a press during any call hangs it up`() {
        assertEquals(OperatorKeyAction.HangUp, OperatorKeyAction.decide(operatorId = "helm", liveCallTarget = "helm"))
        assertEquals(OperatorKeyAction.HangUp, OperatorKeyAction.decide(operatorId = "helm", liveCallTarget = "a"))
    }

    @Test
    fun `an unlocked press opens Helm`() {
        assertEquals(KeyPress.Open(overLockScreen = false), KeyPress.gate(locked = false, inCall = false, now, null, null))
    }

    @Test
    fun `any live call is hung up straight away, locked or not`() {
        assertEquals(KeyPress.HangUp, KeyPress.gate(locked = true, inCall = true, now, null, null))
        assertEquals(KeyPress.HangUp, KeyPress.gate(locked = false, inCall = true, now, null, null))
    }

    @Test
    fun `locked within 10 minutes of a call ending calls over the lock screen`() {
        assertEquals(KeyPress.Open(overLockScreen = true), KeyPress.gate(true, false, now, callEndedAt = now - 10 * min, screenOffAt = null))
    }

    @Test
    fun `locked within 10 minutes of the screen going off calls over the lock screen`() {
        assertEquals(KeyPress.Open(overLockScreen = true), KeyPress.gate(true, false, now, callEndedAt = null, screenOffAt = now - 3 * min))
    }

    @Test
    fun `locked longer than 10 minutes asks for an unlock first`() {
        assertEquals(KeyPress.Unlock, KeyPress.gate(true, false, now, callEndedAt = now - 10 * min - 1, screenOffAt = now - 11 * min))
        assertEquals(KeyPress.Unlock, KeyPress.gate(true, false, now, callEndedAt = null, screenOffAt = null))
    }

    @Test
    fun `a press is taken exactly once`() {
        OperatorKey.consume()
        OperatorKey.request()
        assertTrue(OperatorKey.consume())
        // A recomposition or rotation re-reading it must not dial again.
        assertFalse(OperatorKey.consume())
    }

    @Test
    fun `the shortcut and the launcher alias are presses, a plain launch is not`() {
        assertTrue(OperatorKey.isPress(OperatorKey.ACTION, "com.potatomotato.helm.MainActivity"))
        assertTrue(OperatorKey.isPress("android.intent.action.MAIN", OperatorKey.ALIAS))
        assertFalse(OperatorKey.isPress("android.intent.action.MAIN", "com.potatomotato.helm.MainActivity"))
    }
}
