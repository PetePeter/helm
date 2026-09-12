package com.potatomotato.helm.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Every colour in the app. Lifted verbatim from the approved mockup attached to
 * plan P-0740, which is the single source of truth — there is deliberately no
 * copy of it in the working tree, so there is nothing to drift against.
 *
 * THE OLED CONTRACT: [Bg] is TRUE BLACK, never a dark grey. On an OLED panel a
 * black pixel is an unlit pixel; #0a0a0a is not, and it costs the power saving
 * and the infinite contrast that this palette exists for. Elevation is carried
 * by 1px [Line] hairlines, never by lighter grey fills.
 *
 * Nothing outside this package may declare a colour — NoRawColorLiteralTest
 * enforces that, because a design system dies one hardcoded screen at a time.
 */
object HelmColors {

    /** TRUE BLACK. The canvas, not a colour. Do not lighten. */
    val Bg = Color(0xFF000000)

    /** Raised sheets and bars. Still near-black; the hairline does the lifting. */
    val Surface = Color(0xFF0B0B0D)

    /** Inset fills — input fields, chips, the SAS digit cells. */
    val Surface2 = Color(0xFF121215)

    /** Hairline borders. This is how elevation is expressed. */
    val Line = Color(0xFF1E1E23)

    /**
     * Row separators — the mockup's #101013, a shade BETWEEN Bg and [Line].
     * List rows want to be divided more quietly than components want to be edged.
     */
    val Separator = Color(0xFF101013)

    val Txt = Color(0xFFFFFFFF)
    val Dim = Color(0xFF8B8B95)
    val Faint = Color(0xFF5A5A63)

    /**
     * Terminal snapshot body — #c8c8d0, brighter than [Dim]: a tail is the
     * thing the user came to READ, and mockup screen 7 draws it that much
     * closer to [Txt] without being it.
     */
    val Terminal = Color(0xFFC8C8D0)

    /**
     * 1970s highlighter green. App chrome only — it sits deliberately OUTSIDE
     * the state palette so chrome is never mistaken for session state.
     */
    val Accent = Color(0xFFCCFF00)

    /** Text and icons drawn on top of [Accent]. Near-black, never pure white. */
    val OnAccent = Color(0xFF0D1200)

    /** Destructive actions — "Close session", "Reject". */
    val Danger = Color(0xFFF87171)

    /**
     * Session state colours, per invariant 8.
     *
     * These MIRROR the desktop's `renderer/state-colors.ts` semantically —
     * green active, blue waiting, grey idle, amber flash-attention — and that
     * file remains the source of truth for what a state MEANS. They are
     * duplicated here only because Kotlin cannot import TypeScript.
     *
     * The hex values are deliberately NOT byte-identical to the desktop's
     * (#44cc44 / #4488ff / #555555): these are the brighter tones ratified for
     * an OLED panel in the P-0740 mockup. Adding or removing a STATE on the
     * desktop must be reflected here; re-tuning a desktop hex need not be.
     *
     * RATIFIED: [Active] sits close to [Accent]. Known, accepted, do not "fix".
     */
    object State {
        val Active = Color(0xFF4ADE80)
        val Waiting = Color(0xFF60A5FA)
        val Idle = Color(0xFF52525B)
        val Flash = Color(0xFFFBBF24)
    }
}
