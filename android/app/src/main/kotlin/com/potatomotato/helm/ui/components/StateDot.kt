package com.potatomotato.helm.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize

/**
 * The four session states the dot can show.
 *
 * These mirror the desktop's activity levels (invariant 8) plus flash-attention.
 * The dot reflects ACTIVITY, never pipeline state — see docs/terminal-architecture.md.
 */
enum class SessionState {
    /** Producing output right now. */
    Active,

    /** Quiet, but recently alive — waiting on you. */
    Waiting,

    /** Nothing for a long while. */
    Idle,

    /** Grabbing your attention deliberately. See docs/flash-attention.md. */
    Flash,
}

/** The single mapping from state to colour. Nothing else may derive one. */
val SessionState.color: Color
    get() = when (this) {
        SessionState.Active -> HelmColors.State.Active
        SessionState.Waiting -> HelmColors.State.Waiting
        SessionState.Idle -> HelmColors.State.Idle
        SessionState.Flash -> HelmColors.State.Flash
    }

/**
 * Every session dot in the app, drawn by one code path.
 *
 * A live dot carries a soft halo; [SessionState.Idle] deliberately does not, so
 * "something is happening" is legible from across the room without reading the
 * hue — which also keeps the screen usable for a red/green colour-blind user.
 */
@Composable
fun StateDot(
    state: SessionState,
    modifier: Modifier = Modifier,
    size: Dp = HelmSize.Dot,
) {
    val color = state.color
    val glows = state != SessionState.Idle

    Canvas(modifier = modifier.size(if (glows) size * GLOW_EXTENT else size)) {
        val center = this.center
        val dotRadius = size.toPx() / 2f

        if (glows) {
            drawCircle(color = color.copy(alpha = OUTER_GLOW_ALPHA), radius = dotRadius * 2.2f, center = center)
            drawCircle(color = color.copy(alpha = INNER_GLOW_ALPHA), radius = dotRadius * 1.5f, center = center)
        }
        drawCircle(color = color, radius = dotRadius, center = center)
    }
}

/** The halo needs room to sit in, or it is clipped into a hard edge. */
private const val GLOW_EXTENT = 2.2f
private const val OUTER_GLOW_ALPHA = 0.12f
private const val INNER_GLOW_ALPHA = 0.22f
