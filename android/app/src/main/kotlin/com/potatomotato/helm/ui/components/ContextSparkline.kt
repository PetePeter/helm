package com.potatomotato.helm.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import com.potatomotato.helm.data.ContextGraph
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.data.ContextLevel
import com.potatomotato.helm.data.ContextLimits
import com.potatomotato.helm.data.ContextSample
import com.potatomotato.helm.ui.theme.HelmColors

fun ContextLevel.color(): Color = when (this) {
    ContextLevel.Ok -> HelmColors.Accent
    ContextLevel.Warn -> HelmColors.CacheWarn
    ContextLevel.Hot -> HelmColors.Danger
}

/** Line + soft area of [samples] against [window] (or their peak), x by time. */
@Composable
fun ContextSparkline(
    samples: List<ContextSample>,
    window: Long?,
    limits: ContextLimits?,
    modifier: Modifier = Modifier,
    detailed: Boolean = false,
) {
    if (samples.size < 2) return
    val color = ContextGraph.level(samples.last(), limits).color()
    Canvas(modifier) {
        val first = samples.first().at
        val span = (samples.last().at - first).coerceAtLeast(1L).toFloat()
        val ceiling = ContextGraph.ceiling(samples, limits, window).toFloat()
        fun x(s: ContextSample) = (s.at - first) / span * size.width
        fun y(fill: Float) = size.height - fill.coerceIn(0f, 1f) * size.height
        if (detailed) {
            val dash = PathEffect.dashPathEffect(floatArrayOf(8f, 8f))
            // The window line shows only when the graph reaches it.
            window?.takeIf { it > 0 && it <= ceiling }?.let {
                drawLine(HelmColors.Faint, Offset(0f, y(it / ceiling)), Offset(size.width, y(it / ceiling)), pathEffect = dash)
            }
            limits?.let {
                val amber = y(it.amber.toFloat() / ceiling)
                val red = y(it.red.toFloat() / ceiling)
                drawLine(HelmColors.CacheWarn.copy(alpha = 0.3f), Offset(0f, amber), Offset(size.width, amber))
                drawLine(HelmColors.Danger.copy(alpha = 0.3f), Offset(0f, red), Offset(size.width, red))
            }
        }
        val line = Path().apply {
            samples.forEachIndexed { i, s ->
                if (i == 0) moveTo(x(s), y(s.tokens / ceiling)) else lineTo(x(s), y(s.tokens / ceiling))
            }
        }
        val area = Path().apply {
            addPath(line)
            lineTo(size.width, size.height)
            lineTo(0f, size.height)
            close()
        }
        drawPath(area, color.copy(alpha = 0.2f))
        drawPath(line, color, style = Stroke(width = (if (detailed) 2.dp else 1.5.dp).toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        val last = samples.last()
        drawCircle(color, radius = (if (detailed) 3.dp else 2.dp).toPx(), center = Offset(x(last), y(last.tokens / ceiling)))
    }
}
