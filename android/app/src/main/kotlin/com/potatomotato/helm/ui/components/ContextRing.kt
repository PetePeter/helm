package com.potatomotato.helm.ui.components

import android.provider.Settings
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.ContextGraph
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.data.ContextRing
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The session dot with its context fill around it: the dot says what the session
 * is doing, the ring says how full its context is. Without a ring (no reading or
 * no limits yet) it is the plain [StateDot], in the same footprint, so a row's
 * columns never shift when the first reading arrives.
 *
 * Past the circle the ring heartbeats; with system animations off it holds still
 * and wears a static halo instead — a moving indicator is what reduce-motion stops.
 */
@Composable
fun ContextRing(
    state: SessionState,
    ring: ContextRing?,
    modifier: Modifier = Modifier,
    size: Dp = RING_SIZE,
) {
    Box(modifier = modifier.size(size), contentAlignment = Alignment.Center) {
        if (ring == null) {
            StateDot(state = state)
            return@Box
        }
        val context = LocalContext.current
        val animate = remember {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
        }
        val scale = if (ring.overflow && animate) heartbeat() else 1f
        val levelColor = ring.level.color()
        val dotColor = state.color
        Canvas(modifier = Modifier.size(size).graphicsLayer(scaleX = scale, scaleY = scale)) {
            val stroke = size.toPx() * RING_THICKNESS
            val arcSize = Size(this.size.width - stroke, this.size.height - stroke)
            val topLeft = Offset(stroke / 2f, stroke / 2f)
            if (ring.overflow && !animate) {
                drawCircle(levelColor.copy(alpha = HALO_ALPHA), radius = this.size.width / 2f)
            }
            drawArc(HelmColors.Line, 0f, 360f, useCenter = false, topLeft = topLeft, size = arcSize, style = Stroke(stroke))
            drawArc(
                color = levelColor,
                startAngle = -90f,
                sweepAngle = 360f * ring.fill,
                useCenter = false,
                topLeft = topLeft,
                size = arcSize,
                style = Stroke(stroke),
            )
            drawCircle(dotColor, radius = this.size.width * DOT_RADIUS)
        }
    }
}

/**
 * The open session's ring, tappable: the tap opens the same graph the desktop
 * shows on hover — tokens, window, the amber/red lines and the recent trend.
 */
@Composable
fun ContextRingButton(
    state: SessionState,
    history: ContextHistory?,
    modifier: Modifier = Modifier,
    size: Dp = HEADER_RING_SIZE,
) {
    var open by remember { mutableStateOf(false) }
    Box(modifier = modifier) {
        ContextRing(
            state = state,
            ring = history?.let { ContextGraph.ring(it) },
            size = size,
            modifier = if (history != null) Modifier.clickable { open = true } else Modifier,
        )
        if (history != null) {
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                Column(modifier = Modifier.width(POPOVER_WIDTH).padding(HelmSpacing.Md)) {
                    ContextGraph.summary(history)?.let {
                        Text(text = it, color = HelmColors.Txt, style = MaterialTheme.typography.bodyMedium)
                    }
                    ContextSparkline(
                        samples = history.samples,
                        window = history.window,
                        limits = history.limits,
                        detailed = true,
                        modifier = Modifier.fillMaxWidth().height(POPOVER_GRAPH_HEIGHT).padding(top = HelmSpacing.Sm),
                    )
                }
            }
        }
    }
}

/** Two quick pulses then a rest, like a pulse — fast enough to catch the eye in a list. */
@Composable
private fun heartbeat(): Float {
    val transition = rememberInfiniteTransition(label = "context-heartbeat")
    val scale by transition.animateFloat(
        initialValue = 1f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = keyframes {
                durationMillis = HEARTBEAT_MS
                1f at 0
                1.2f at 110
                1f at 240
                1.14f at 370
                1f at 520
            },
            repeatMode = RepeatMode.Restart,
        ),
        label = "context-heartbeat-scale",
    )
    return scale
}

private val RING_SIZE = 22.dp
private val HEADER_RING_SIZE = 30.dp
private val POPOVER_WIDTH = 260.dp
private val POPOVER_GRAPH_HEIGHT = 80.dp
private const val RING_THICKNESS = 0.18f
private const val DOT_RADIUS = 0.18f
private const val HALO_ALPHA = 0.25f
private const val HEARTBEAT_MS = 1100
