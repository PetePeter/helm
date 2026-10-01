package com.potatomotato.helm.data

import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.components.LoadViews
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TimeRepositoryTest {
    private val week = TimeAsk(TimePeriod.Day, anchorEpochMs = 1_790_000_000_000, projectKey = null)

    @Test
    fun `the project totals land as rows, busiest first as the desktop sent them`() {
        val repo = TimeRepository()
        repo.requested(week)
        assertEquals(LoadView.Loading, LoadViews.time(repo.state.value, week))

        val ok = repo.arrived(week, JSONObject("""{"projects":[
            {"projectKey":"p1","projectName":"Helm","user":125,"ai":300},
            {"projectKey":"C:/x","projectName":"C:/x","user":5,"ai":0}]}"""))

        assertTrue(ok)
        val view = LoadViews.time(repo.state.value, week) as LoadView.Ready
        assertEquals(
            TimeAnswer.Projects(listOf(TimeProjectTotal("p1", "Helm", 125, 300), TimeProjectTotal("C:/x", "C:/x", 5, 0))),
            view.data,
        )
    }

    @Test
    fun `one project's folder grid parses columns, rows and totals`() {
        val repo = TimeRepository()
        val ask = week.copy(projectKey = "p1")
        repo.requested(ask)
        assertTrue(repo.arrived(ask, JSONObject("""{"sheet":{"columns":[1,2],
            "rows":[{"dir":"C:/helm","user":[5,0],"ai":[0,10]}],
            "totals":{"user":[5,0],"ai":[0,10]}}}""")))

        val sheet = (LoadViews.time(repo.state.value, ask) as LoadView.Ready).data as TimeAnswer.Sheet
        assertEquals(listOf(1L, 2L), sheet.sheet.columns)
        assertEquals(listOf(TimeRow("C:/helm", listOf(5, 0), listOf(0, 10))), sheet.sheet.rows)
        assertEquals(listOf(5, 0), sheet.sheet.totalUser)
    }

    @Test
    fun `a late answer for an ask the user already left is dropped`() {
        val repo = TimeRepository()
        val next = week.copy(period = TimePeriod.Month)
        repo.requested(week)
        repo.requested(next)
        assertTrue(repo.arrived(week, JSONObject("""{"projects":[]}""")))
        assertEquals(LoadView.Loading, LoadViews.time(repo.state.value, next))
    }

    @Test
    fun `a revisit shows the cached answer while refreshing`() {
        val repo = TimeRepository()
        repo.requested(week)
        repo.arrived(week, JSONObject("""{"projects":[]}"""))
        repo.requested(week)
        assertEquals(LoadView.Ready(TimeAnswer.Projects(emptyList()), true), LoadViews.time(repo.state.value, week))
    }

    @Test
    fun `an unreadable answer reports false so the client can say so`() {
        val repo = TimeRepository()
        repo.requested(week)
        assertFalse(repo.arrived(week, JSONObject("""{"nope":1}""")))
    }

    @Test
    fun `paging moves one view width and lands on local calendar steps`() {
        val anchor = java.time.LocalDate.of(2026, 9, 28).atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()
        fun date(ms: Long) = java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault()).toLocalDate()
        assertEquals(java.time.LocalDate.of(2026, 9, 29), date(TimePeriod.Hour.step(anchor, 1)))
        assertEquals(java.time.LocalDate.of(2026, 10, 5), date(TimePeriod.Day.step(anchor, 1)))
        assertEquals(java.time.LocalDate.of(2026, 8, 28), date(TimePeriod.Week.step(anchor, -1)))
        assertEquals(java.time.LocalDate.of(2027, 9, 28), date(TimePeriod.Month.step(anchor, 1)))
    }
}
