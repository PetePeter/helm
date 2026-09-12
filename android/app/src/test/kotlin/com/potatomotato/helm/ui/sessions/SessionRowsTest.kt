package com.potatomotato.helm.ui.sessions

import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.components.SessionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the sessions list renders: group headers, and which sessions survive a
 * collapsed group. Pure on purpose — the failure modes (a collapsed group still
 * showing rows, a toggle that collapses a different project, a count that
 * disagrees with the rows) are logic, not layout.
 */
class SessionRowsTest {

    @Test
    fun `nothing collapsed renders every session under its project header`() {
        // Arrives already sorted by project — SessionRepository owns that order.
        val rows = SessionRows.build(
            listOf(s("a1", "/repo/alpha"), s("a2", "/repo/alpha"), s("b1", "/repo/beta")),
            collapsed = emptySet(),
        )

        val labels = rows.mapNotNull { (it as? RowEntry.Header)?.label }
        assertEquals(listOf("alpha", "beta"), labels)
        assertEquals(5, rows.size)
    }

    @Test
    fun `a collapsed group shows its header with the count, and no rows`() {
        val rows = SessionRows.build(
            listOf(s("a1", "/repo/alpha"), s("a2", "/repo/alpha"), s("b1", "/repo/beta")),
            collapsed = setOf("alpha"),
        )

        val header = rows.filterIsInstance<RowEntry.Header>().first()
        assertTrue(header.collapsed)
        assertEquals(2, header.count)
        // The other group's rows are untouched.
        assertTrue(rows.any { (it as? RowEntry.Session)?.session?.id == "b1" })
        assertFalse(rows.any { (it as? RowEntry.Session)?.session?.id == "a1" })
    }

    @Test
    fun `an expanded header carries the count too, so the row can always say how much is inside`() {
        val rows = SessionRows.build(listOf(s("a1", "/repo/alpha")), collapsed = emptySet())

        val header = rows.filterIsInstance<RowEntry.Header>().single()
        assertFalse(header.collapsed)
        assertEquals(1, header.count)
    }

    @Test
    fun `toggling adds a label that was not collapsed and drops one that was`() {
        assertEquals(setOf("alpha"), SessionRows.toggle(emptySet(), "alpha"))
        assertEquals(emptySet<String>(), SessionRows.toggle(setOf("alpha"), "alpha"))
    }

    private fun s(id: String, projectPath: String) = HelmSession(
        id = id,
        name = id,
        projectPath = projectPath,
        cliType = "claudecode",
        cliTypeName = "claude",
        activity = SessionState.Idle,
    )
}
