package com.potatomotato.helm.ui.plans

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Which directory a plan surface is about.
 *
 * This lived inline in a composable, which is where the bug hid: a session
 * whose `projectPath` is blank fell through to a project the in-session view
 * never has (the projects are only pulled at the root), so the scope was null,
 * the pull effect skipped, and both the Plans and Sequences tabs sat on a
 * spinner forever with no retry.
 */
class PlanScopeTest {

    @Test
    fun `an open session's own directory wins over the picked project`() {
        assertEquals("/session", PlanScope.resolve("/session", "/project"))
    }

    /**
     * THE REGRESSION. A blank session path with nothing to fall back on is a
     * real "no scope" answer, so the caller can say so instead of waiting on an
     * ask that will never be made.
     */
    @Test
    fun `a session with no project directory and no project resolves to no scope`() {
        assertNull(PlanScope.resolve("", null))
        assertNull(PlanScope.resolve("   ", null))
        assertNull(PlanScope.resolve(null, null))
        // A project answered with an empty canonical path is no scope either.
        assertNull(PlanScope.resolve("", ""))
    }

    @Test
    fun `a blank session path falls back to the project when there is one`() {
        assertEquals("/project", PlanScope.resolve("", "/project"))
        assertEquals("/project", PlanScope.resolve(null, "/project"))
    }
}
