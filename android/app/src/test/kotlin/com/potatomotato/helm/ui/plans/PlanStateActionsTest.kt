package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.PlanStatus
import com.potatomotato.helm.data.Capabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The state moves offered must be ones the desktop accepts — a button that is always refused is a lie. */
class PlanStateActionsTest {
    @Test
    fun `done is only offered where plan_complete accepts it`() {
        for (status in PlanStatus.entries) {
            val offersDone = PlanStateAction.Done in PlanStateActions.of(status)
            assertEquals(status.name, status == PlanStatus.Coding || status == PlanStatus.Review, offersDone)
        }
    }

    @Test
    fun `a done plan can only be reopened`() {
        assertEquals(listOf(PlanStateAction.Reopen), PlanStateActions.of(PlanStatus.Done))
    }

    @Test
    fun `suggestions offer one tap accept and confirmed reject`() {
        assertEquals(listOf(PlanStateAction.Accept, PlanStateAction.Reject), PlanStateActions.of(PlanStatus.Suggested))
    }

    @Test
    fun `suggestion actions are hidden until the phone capability verdict permits them`() {
        assertEquals(emptyList<PlanStateAction>(), PlanStateActions.available(PlanStatus.Suggested, Capabilities.Unknown))
        assertEquals(
            listOf(PlanStateAction.Accept),
            PlanStateActions.available(PlanStatus.Suggested, Capabilities.Known(setOf("plan_accept_suggestion"))),
        )
        assertEquals(
            listOf(PlanStateAction.Reject),
            PlanStateActions.available(PlanStatus.Suggested, Capabilities.Known(setOf("plan_reject_suggestion"))),
        )
        assertEquals(
            listOf(PlanStateAction.Accept, PlanStateAction.Reject),
            PlanStateActions.available(
                PlanStatus.Suggested,
                Capabilities.Known(setOf("plan_accept_suggestion", "plan_reject_suggestion")),
            ),
        )
    }

    @Test
    fun `ordinary lifecycle actions do not depend on suggestion tool capabilities`() {
        assertEquals(
            listOf(PlanStateAction.Ready),
            PlanStateActions.available(PlanStatus.Planning, Capabilities.Unknown),
        )
    }

    @Test
    fun `no move is offered to the state the plan is already in`() {
        assertFalse(PlanStateAction.Planning in PlanStateActions.of(PlanStatus.Planning))
        assertFalse(PlanStateAction.Ready in PlanStateActions.of(PlanStatus.Ready))
    }

    @Test
    fun `completion documentation must meet the desktop minimum after trimming`() {
        assertFalse(PlanStateActions.canComplete("   short   "))
        assertTrue(PlanStateActions.canComplete("ten chars!"))
    }

    @Test
    fun `a blank title cannot be saved`() {
        assertFalse(PlanStateActions.canSaveTitle("  "))
        assertTrue(PlanStateActions.canSaveTitle("x"))
    }
}
