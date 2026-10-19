package com.potatomotato.helm.ui.time

import com.potatomotato.helm.data.TimeAnswer
import com.potatomotato.helm.data.TimeChartAxisKind
import com.potatomotato.helm.data.TimeChartModel
import com.potatomotato.helm.data.TimeChartSeries
import com.potatomotato.helm.data.TimeChartSeriesType
import com.potatomotato.helm.data.TimeTokenRow
import com.potatomotato.helm.data.TimeTokenSheet
import com.potatomotato.helm.ui.theme.HelmColors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TimeScreenTest {

    @Test
    fun `all-zero token sheet is empty for display`() {
        val answer = TimeAnswer.Tokens(
            TimeTokenSheet(
                columns = listOf(1L, 2L),
                rows = listOf(TimeTokenRow("unused", "Unused", listOf(0L, 0L))),
                totals = listOf(0L, 0L),
            ),
        )

        assertTrue(answer.isEmptyForDisplay())
    }

    @Test
    fun `token sheet with usage is not empty for display`() {
        val answer = TimeAnswer.Tokens(
            TimeTokenSheet(
                columns = listOf(1L, 2L),
                rows = listOf(TimeTokenRow("used", "Used", listOf(0L, 1L))),
                totals = listOf(0L, 1L),
            ),
        )

        assertFalse(answer.isEmptyForDisplay())
    }

    @Test
    fun `statistics row backgrounds alternate and repeat every two rows`() {
        assertEquals(HelmColors.Surface, statisticsRowBackground(0))
        assertEquals(HelmColors.Surface2, statisticsRowBackground(1))
        assertEquals(HelmColors.Surface, statisticsRowBackground(2))
    }

    @Test
    fun `token table rows omit CLIs with a zero period total`() {
        val sheet = TimeTokenSheet(
            columns = listOf(1L, 2L),
            rows = listOf(
                TimeTokenRow("unused", "Unused", listOf(0L, 0L)),
                TimeTokenRow("luna-xhigh", "Luna xhigh", listOf(2_000_000L, 3_090_000L)),
            ),
            totals = listOf(2_000_000L, 3_090_000L),
        )

        assertEquals(listOf("luna-xhigh"), visibleTokenRows(sheet).map { it.cliType })
    }

    @Test
    fun `token row colours follow chart model keys instead of the visible row order`() {
        val model = TimeChartModel(
            columns = listOf(1L),
            labels = listOf("today"),
            series = listOf(
                TimeChartSeries("cli:second", "Second", "#abcdef", TimeChartSeriesType.BAR, TimeChartAxisKind.TOKENS, listOf(1L)),
            ),
        )

        assertEquals("#abcdef", tokenChartSeriesColor(model, "second"))
        assertEquals(null, tokenChartSeriesColor(model, "first"))
    }

    @Test
    fun `chart viewport reserves plot height and one touch-sized scrollable legend row`() {
        val widthDp = 360f
        val plotHeightDp = widthDp * 290f / 700f

        assertEquals(plotHeightDp + 8f + 48f, chartHeightDp(widthDp), 0.01f)
    }
}
