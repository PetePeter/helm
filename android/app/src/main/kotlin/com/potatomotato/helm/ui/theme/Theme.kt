package com.potatomotato.helm.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.Box

/**
 * Material3 mapping of the ratified palette.
 *
 * There is NO light variant and NO dynamic colour. Material You would let the
 * user's wallpaper override the accent and, worse, replace the true-black
 * background with a tinted dark grey — which is exactly the OLED contract this
 * palette exists to keep. The app is one deliberate look on every device.
 */
private val HelmColorScheme = darkColorScheme(
    primary = HelmColors.Accent,
    onPrimary = HelmColors.OnAccent,
    secondary = HelmColors.Accent,
    onSecondary = HelmColors.OnAccent,
    background = HelmColors.Bg,
    onBackground = HelmColors.Txt,
    surface = HelmColors.Surface,
    onSurface = HelmColors.Txt,
    surfaceVariant = HelmColors.Surface2,
    onSurfaceVariant = HelmColors.Dim,
    outline = HelmColors.Line,
    outlineVariant = HelmColors.Line,
    error = HelmColors.Danger,
    onError = HelmColors.OnAccent,
)

private val HelmShapes = Shapes(
    extraSmall = RoundedCornerShape(HelmRadius.Sm),
    small = RoundedCornerShape(HelmRadius.Sm),
    medium = RoundedCornerShape(HelmRadius.Md),
    large = RoundedCornerShape(HelmRadius.Lg),
    extraLarge = RoundedCornerShape(HelmRadius.Sheet),
)

/**
 * Wraps the whole app. The [Box] paints true black behind every screen so no
 * screen has to remember to, and so an unpainted gap can never flash grey.
 */
@Composable
fun HelmTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = HelmColorScheme,
        typography = HelmTypography,
        shapes = HelmShapes,
    ) {
        Box(modifier = Modifier.fillMaxSize().background(HelmColors.Bg)) {
            content()
        }
    }
}
