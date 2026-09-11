package com.potatomotato.helm.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * The type scale of the mockup.
 *
 * No font assets: the mockup asks for the platform sans (Roboto on Android) and
 * a monospace for digits and terminal output. Shipping a webfont to match a
 * browser mockup would add weight for a difference nobody can see on a phone.
 *
 * Material roles are mapped below so Material3 components inherit the scale for
 * free; [HelmType] carries only the roles Material has no name for.
 */
internal val HelmTypography = Typography(
    // App bar title — "Helm", "ble-transport".
    titleLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        letterSpacing = (-0.2).sp,
    ),
    // Session name in a list row.
    titleMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
    ),
    // Sheet action labels, pairing prose.
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    // Chat bubbles.
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 13.sp,
        lineHeight = 19.sp,
    ),
    // Row subtitles, secondary prose.
    bodySmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 11.sp,
        lineHeight = 16.sp,
    ),
    // Buttons.
    labelLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Bold,
        fontSize = 14.sp,
    ),
    // Timestamps.
    labelMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 10.sp,
    ),
    // Group headers and eyebrow labels — uppercase, tracked out.
    labelSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 10.sp,
        letterSpacing = 1.sp,
    ),
)

/** Roles with no Material equivalent. */
object HelmType {

    /** A single SAS digit. Monospace so 1/7 and 0/8 cannot be confused. */
    val SasDigit = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
        fontSize = 24.sp,
    )

    /** Terminal snapshot body. Dense on purpose — line count is what matters. */
    val Terminal = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 11.sp,
        lineHeight = 18.sp,
    )

    /** Unread/count badge on the accent pill. */
    val Badge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.ExtraBold,
        fontSize = 9.sp,
    )
}
