package com.potatomotato.helm.ui.time

import com.potatomotato.helm.data.TimeChartAxisKind
import com.potatomotato.helm.data.TimeChartModel
import com.potatomotato.helm.data.TimeChartSeries
import com.potatomotato.helm.data.TimeChartSeriesType
import com.potatomotato.helm.ui.artifacts.HtmlContainment
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TimeChartDocumentTest {
    private val theme = TimeChartTheme(
        text = "#ffffff",
        textMuted = "#8b8b95",
        grid = "#35353e",
        tooltip = "#121215",
        surface = "#0b0b0d",
    )

    @Test
    fun `token document keeps raw series data and safely embeds the local bundle`() {
        val hostileLabel = "CLI </script><img src=x onerror=alert(1)>"
        val model = TimeChartModel(
            columns = listOf(1L, 2L),
            labels = listOf("one", "two"),
            series = listOf(
                TimeChartSeries(
                    key = "cli:codex",
                    label = hostileLabel,
                    color = "#123456",
                    type = TimeChartSeriesType.BAR,
                    axis = TimeChartAxisKind.TOKENS,
                    values = listOf(1_500L, 250L),
                ),
            ),
        )

        val html = TimeChartDocument.build(
            model,
            chartBundle = "window.note = '</script>';",
            theme = theme,
            stackedTokens = true,
        )

        val encoded = Regex("""<script type="application/json" id="chart-model">(.*?)</script>""", RegexOption.DOT_MATCHES_ALL)
            .find(html)?.groupValues?.get(1)
            ?: error("Chart model JSON is missing")
        val data = JSONObject(encoded)
        val series = data.getJSONArray("series").getJSONObject(0)

        assertEquals(hostileLabel, series.getString("label"))
        assertEquals(JSONArray(listOf(1_500, 250)).toString(), series.getJSONArray("values").toString())
        assertEquals("#123456", series.getString("color"))
        assertTrue(data.getBoolean("stackedTokens"))
        assertFalse(encoded.contains("</script>"))
        assertTrue(html.contains("<\\/script>"))
        assertTrue(html.contains(HtmlContainment.CSP_META))
        assertFalse(Regex("""<script\s+src=""", RegexOption.IGNORE_CASE).containsMatchIn(html))
    }

    @Test
    fun `token chart stacks visible datasets and exposes a touch sized legend with exact tooltips`() {
        val model = TimeChartModel(
            columns = listOf(1L),
            labels = listOf("today"),
            series = listOf(
                TimeChartSeries("cli:codex", "Codex", "#123456", TimeChartSeriesType.BAR, TimeChartAxisKind.TOKENS, listOf(1_500L)),
                TimeChartSeries("cli:claude", "Claude", "#abcdef", TimeChartSeriesType.BAR, TimeChartAxisKind.TOKENS, listOf(250L)),
            ),
        )

        val html = TimeChartDocument.build(model, "window.Chart = {};", theme, stackedTokens = true)

        assertTrue(html.contains("stack: model.stackedTokens ? 'tokens' : undefined"))
        assertTrue(html.contains("stacked: model.stackedTokens"))
        assertTrue(html.contains("chart.setDatasetVisibility(index, !visible)"))
        assertTrue(html.contains("min-height:48px"))
        assertTrue(html.contains("new Intl.NumberFormat('en-US').format(value)"))
        assertTrue(html.contains("formatMinuteValue(value)"))
        assertTrue(html.contains("const series = model.series[item.datasetIndex]"))
    }

    @Test
    fun `timesheet chart leaves its series grouped and keeps the right token axis`() {
        val model = TimeChartModel(
            columns = listOf(1L),
            labels = listOf("today"),
            series = listOf(
                TimeChartSeries("user", "You", "#123456", TimeChartSeriesType.BAR, TimeChartAxisKind.MINUTES, listOf(65L)),
                TimeChartSeries("tokens", "Tokens", "#abcdef", TimeChartSeriesType.LINE, TimeChartAxisKind.TOKENS, listOf(1_500L)),
            ),
        )

        val html = TimeChartDocument.build(model, "window.Chart = {};", theme, stackedTokens = false)

        assertTrue(html.contains("stack: model.stackedTokens ? 'tokens' : undefined"))
        assertTrue(html.contains("stacked: model.stackedTokens"))
        val encoded = Regex("""<script type="application/json" id="chart-model">(.*?)</script>""", RegexOption.DOT_MATCHES_ALL)
            .find(html)?.groupValues?.get(1)
            ?: error("Chart model JSON is missing")
        val data = JSONObject(encoded)
        assertFalse(data.getBoolean("stackedTokens"))
        assertEquals("minutes", data.getJSONArray("series").getJSONObject(0).getString("axis"))
        assertEquals("tokens", data.getJSONArray("series").getJSONObject(1).getString("axis"))
    }
}
