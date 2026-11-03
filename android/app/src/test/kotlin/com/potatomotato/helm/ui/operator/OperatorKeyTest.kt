package com.potatomotato.helm.ui.operator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OperatorKeyTest {
    @Test
    fun `no operator is unavailable, never a dial`() {
        assertEquals(OperatorKeyAction.Unavailable, OperatorKeyAction.decide(operatorId = null, liveCallTarget = null))
    }

    @Test
    fun `an idle line dials the operator`() {
        assertEquals(OperatorKeyAction.Dial("helm"), OperatorKeyAction.decide(operatorId = "helm", liveCallTarget = null))
    }

    @Test
    fun `a second press during the operator call hangs up`() {
        assertEquals(OperatorKeyAction.HangUp, OperatorKeyAction.decide(operatorId = "helm", liveCallTarget = "helm"))
    }

    @Test
    fun `another session's call is shown, never dropped or retargeted`() {
        assertEquals(OperatorKeyAction.Show("a"), OperatorKeyAction.decide(operatorId = "helm", liveCallTarget = "a"))
        // Even with the operator gone, a stray press must not cost the user their call.
        assertEquals(OperatorKeyAction.Show("a"), OperatorKeyAction.decide(operatorId = null, liveCallTarget = "a"))
    }

    @Test
    fun `a press is taken exactly once`() {
        OperatorKey.consume()
        OperatorKey.request()
        assertTrue(OperatorKey.consume())
        // A recomposition or rotation re-reading it must not dial again.
        assertFalse(OperatorKey.consume())
    }
}
