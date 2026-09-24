package com.potatomotato.helm.ui.plans

import com.potatomotato.helm.data.HelmPlanSummary
import com.potatomotato.helm.data.PlanStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the plan row's terminal action hands the spawn form: the board's own
 * directory, a suggested name, and the first instruction the new CLI reads.
 */
class PlanSpawnTest {

    private fun plan(humanId: String?, title: String = "Fix the thing") = HelmPlanSummary(
        id = "uuid-1", humanId = humanId, title = title, type = null, status = PlanStatus.Ready,
        stateUpdatedAtEpochMs = null, sequenceId = null, blockedBy = emptyList(), blocks = emptyList(),
    )

    @Test
    fun `the board's directory is the session's, untouched`() {
        assertEquals("x:\\repo", PlanSpawn.of(plan("P-0007"), "x:\\repo").dirPath)
    }

    @Test
    fun `the suggested name leads with the human id`() {
        assertEquals("P-0007 Fix the thing", PlanSpawn.of(plan("P-0007"), "/r").name)
    }

    @Test
    fun `a plan with no human id is named by its title alone`() {
        assertEquals("Fix the thing", PlanSpawn.of(plan(null), "/r").name)
        assertEquals("Fix the thing", PlanSpawn.of(plan("  "), "/r").name)
    }

    /** Reading is the whole job: claiming would move a Ready plan to Coding. */
    @Test
    fun `the prompt reads the plan and replies on chat without claiming it`() {
        val prompt = PlanSpawn.of(plan("P-0007"), "/r").prompt
        assertTrue(prompt.contains("uuid-1"))
        assertTrue(prompt.contains("plan_get"))
        assertTrue(prompt.contains("plan_context_list"))
        assertTrue(prompt.contains("chat_send"))
        assertTrue(prompt.contains("Do not call session_plan_claim"))
    }

    /** The prompt travels as sequence syntax; a stray brace would become a key. */
    @Test
    fun `a title with braces cannot inject sequence tokens`() {
        val prompt = PlanSpawn.of(plan("P-1", title = "Ship {Enter} now"), "/r").prompt
        assertFalse(prompt.contains("{"))
    }
}
