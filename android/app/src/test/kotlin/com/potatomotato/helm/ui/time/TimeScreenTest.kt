package com.potatomotato.helm.ui.time

import com.potatomotato.helm.data.TimeTokenRow
import com.potatomotato.helm.data.TimeTokenSheet
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TimeScreenTest {

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
    fun `chart viewport reserves plot height and grows for wrapped legend rows`() {
        val widthDp = 360f
        val plotHeightDp = widthDp * 290f / 700f

        assertEquals(plotHeightDp + 8f + 3 * 28f, chartHeightDp(widthDp, 3), 0.01f)
        assertTrue(chartHeightDp(widthDp, 3) > chartHeightDp(widthDp, 1))
    }
}
