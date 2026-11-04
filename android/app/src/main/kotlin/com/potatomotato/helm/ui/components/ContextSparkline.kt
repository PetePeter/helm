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
        val ceiling = (window?.takeIf { it > 0 } ?: samples.maxOf { it.tokens }).coerceAtLeast(1L).toFloat()
        fun x(s: ContextSample) = (s.at - first) / span * size.width
        fun y(fill: Float) = size.height - fill.coerceIn(0f, 1f) * size.height
        if (detailed && window != null && window > 0) {
            val dash = PathEffect.dashPathEffect(floatArrayOf(8f, 8f))
            drawLine(HelmColors.Faint, Offset(0f, y(1f)), Offset(size.width, y(1f)), pathEffect = dash)
            limits?.let {
                val amber = y(it.amber.toFloat() / window)
                val red = y(it.red.toFloat() / window)
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

/** The list row's graph: the last [ContextGraph.ROW_SPAN_MS], with the % under it. */
@Composable
fun ContextRowGraph(history: ContextHistory, now: Long) {
    val last = history.samples.last()
    Column(horizontalAlignment = androidx.compose.ui.Alignment.End) {
        ContextSparkline(
            samples = ContextGraph.window(history.samples, now - ContextGraph.ROW_SPAN_MS, now),
            window = history.window,
            limits = history.limits,
            modifier = Modifier.size(width = 40.dp, height = 12.dp),
        )
        history.window?.takeIf { it > 0 }?.let { window ->
            Text(
                text = "${Math.round(last.tokens * 100.0 / window)}%",
                color = ContextGraph.level(last, history.limits).let { if (it == ContextLevel.Ok) HelmColors.Dim else it.color() },
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/**
 * The open-session header: a 3dp fill bar, coloured by level (accent, amber,
 * red). It was a 40dp graph card; on a phone that height belongs to the terminal.
 */
@Composable
fun ContextStrip(history: ContextHistory, modifier: Modifier = Modifier) {
    val fill = ContextGraph.fill(history) ?: return
    val color = ContextGraph.level(history.samples.last(), history.limits).color()
    Box(modifier.fillMaxWidth().height(3.dp).background(HelmColors.Line)) {
        Box(Modifier.fillMaxWidth(fill).fillMaxHeight().background(color))
    }
}
