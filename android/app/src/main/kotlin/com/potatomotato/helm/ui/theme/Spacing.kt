package com.potatomotato.helm.ui.theme

import androidx.compose.ui.unit.dp

/**
 * The spacing rhythm of the mockup, rounded to a 4dp grid.
 *
 * The mockup is CSS at 300px-wide phone scale and uses odd values (11px, 13px,
 * 9px); those are artefacts of drawing it in a browser, not design intent. The
 * grid is what keeps screens consistent once they are built independently.
 */
object HelmSpacing {
    val Xs = 4.dp
    val Sm = 8.dp
    val Md = 12.dp
    val Lg = 16.dp
    val Xl = 24.dp
    val Xxl = 32.dp

    /** Standard horizontal screen inset — list rows, app bar, composer. */
    val Gutter = 16.dp
}

/** Corner radii. Pills for chips and bubbles, soft rectangles for everything else. */
object HelmRadius {
    val Sm = 8.dp
    val Md = 12.dp
    val Lg = 16.dp
    val Sheet = 20.dp
    val Pill = 999.dp
}

/** Fixed component dimensions that more than one screen depends on. */
object HelmSize {
    /** Elevation is a hairline, never a fill. See HelmColors.Line. */
    val Hairline = 1.dp

    /** Session state dot. See StateDot — one code path draws all four states. */
    val Dot = 9.dp

    /** The smaller link-state dot in the app bar. */
    val DotSmall = 6.dp

    /** Mic button — a first-class control, not buried in the keyboard. */
    val MicButton = 40.dp

    /** SAS digit cell. Large enough to read off the screen at arm's length. */
    val SasCellWidth = 40.dp
    val SasCellHeight = 52.dp

    /** Minimum touch target. Below this, one-handed use starts missing. */
    val TouchTarget = 48.dp
}
