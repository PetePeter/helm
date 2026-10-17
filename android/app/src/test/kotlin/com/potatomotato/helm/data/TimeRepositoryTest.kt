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
            {"projectKey":"p1","projectName":"Helm","user":125,"ai":300,"tokens":1500},
            {"projectKey":"C:/x","projectName":"C:/x","user":5,"ai":0,"tokens":20}]}"""))

        assertTrue(ok)
        val view = LoadViews.time(repo.state.value, week) as LoadView.Ready
        assertEquals(
            TimeAnswer.Projects(listOf(TimeProjectTotal("p1", "Helm", 125, 300, 1500), TimeProjectTotal("C:/x", "C:/x", 5, 0, 20))),
            view.data,
        )
    }

    @Test
    fun `one project's folder grid parses columns, rows and totals`() {
        val repo = TimeRepository()
        val ask = week.copy(projectKey = "p1")
        repo.requested(ask)
        assertTrue(repo.arrived(ask, JSONObject("""{"sheet":{"columns":[1,2],
            "rows":[{"dir":"C:/helm","user":[5,0],"ai":[0,10],"tokens":[1000,200]}],
            "totals":{"user":[5,0],"ai":[0,10],"tokens":[1000,200]}}}""")))

        val sheet = (LoadViews.time(repo.state.value, ask) as LoadView.Ready).data as TimeAnswer.Sheet
        assertEquals(listOf(1L, 2L), sheet.sheet.columns)
        assertEquals(listOf(TimeRow("C:/helm", listOf(5, 0), listOf(0, 10), listOf(1000, 200))), sheet.sheet.rows)
        assertEquals(listOf(5, 0), sheet.sheet.totalUser)
        assertEquals(listOf(1000L, 200L), sheet.sheet.totalTokens)
    }

    @Test
    fun `the token view parses the desktop CLI rows and numeric totals`() {
        val repo = TimeRepository()
        val ask = week.copy(view = TimeView.Tokens)
        repo.requested(ask)
        assertTrue(repo.arrived(ask, JSONObject("""{"sheet":{"columns":[1,2],
            "rows":[{"cliType":"codex","label":"Codex","tokens":[1500,250]},
                    {"cliType":"other","label":"other","tokens":[0,40]}],
            "totals":[1500,290]},"chartHtml":"<svg/>"}""")))

        val answer = (LoadViews.time(repo.state.value, ask) as LoadView.Ready).data as TimeAnswer.Tokens
        assertEquals(listOf(TimeTokenRow("codex", "Codex", listOf(1500L, 250L)), TimeTokenRow("other", "other", listOf(0L, 40L))), answer.sheet.rows)
        assertEquals(listOf(1500L, 290L), answer.sheet.totals)
        assertEquals("<svg/>", answer.chartHtml)
    }

    @Test
    fun `both views carry the desktop's chart markup, absent from an older desktop`() {
        val repo = TimeRepository()
        repo.requested(week)
        repo.arrived(week, JSONObject("""{"projects":[],"sheet":{"columns":[]},"chartHtml":"<svg/>"}"""))
        assertEquals("<svg/>", ((LoadViews.time(repo.state.value, week) as LoadView.Ready).data as TimeAnswer.Projects).chartHtml)

        val ask = week.copy(projectKey = "p1")
        repo.requested(ask)
        repo.arrived(ask, JSONObject("""{"sheet":{"columns":[]}}"""))
        assertEquals(null, ((LoadViews.time(repo.state.value, ask) as LoadView.Ready).data as TimeAnswer.Sheet).chartHtml)
    }

    @Test
    fun `a late answer for an ask the user already left is dropped across view changes`() {
        val repo = TimeRepository()
        val next = week.copy(view = TimeView.Tokens)
        repo.requested(week)
        repo.requested(next)
        assertTrue(repo.arrived(week, JSONObject("""{"projects":[]}""")))
        assertEquals(LoadView.Loading, LoadViews.time(repo.state.value, next))
    }

    @Test
    fun `timesheet and token answers have separate cache entries`() {
        val repo = TimeRepository()
        val tokens = week.copy(view = TimeView.Tokens)
        repo.requested(week)
        repo.arrived(week, JSONObject("""{"projects":[]}"""))
        repo.requested(tokens)
        repo.arrived(tokens, JSONObject("""{"sheet":{"columns":[],"rows":[],"totals":[]}}"""))
        repo.requested(week)
        assertEquals(LoadView.Ready(TimeAnswer.Projects(emptyList()), true), LoadViews.time(repo.state.value, week))
        repo.requested(tokens)
        assertEquals(LoadView.Ready(TimeAnswer.Tokens(TimeTokenSheet(emptyList(), emptyList(), emptyList())), true), LoadViews.time(repo.state.value, tokens))
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
