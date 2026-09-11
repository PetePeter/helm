package com.potatomotato.helm.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
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
 *
 * IT ALSO OWNS WINDOW INSETS, FOR THE WHOLE APP, AND IS THE ONLY PLACE ALLOWED
 * TO — `InsetsOwnedByThemeTest` fails the build if a screen consumes one.
 *
 * From API 35 the activity draws edge-to-edge whether it asks to or not, so
 * something must consume the insets. Doing it per screen is what caused P-0755:
 * nothing handled the status bar, so the app bar painted over the clock on all
 * six screens, while the navigation bar only looked right because five separate
 * files each happened to remember `navigationBarsPadding()`. One of them was
 * always going to be missed, and the interstitials — the permission gate and
 * the SAS prompt — never hosted an app bar to remember it in.
 *
 * `safeDrawing` is systemBars + displayCutout + ime, so this one line also
 * replaces the scattered `imePadding()` calls.
 *
 * KNOWN AND DELIBERATE: the app bar's [HelmColors.Surface] fill now stops at
 * the status bar instead of bleeding behind the clock, which is [HelmColors.Bg]
 * true black. That is a #0B0B0D vs #000000 difference — invisible on the OLED
 * panel this palette exists for. Do NOT "fix" it by moving the padding into
 * `HelmAppBar`: that hands insets back to a component two screens do not host,
 * which is the defect this replaced.
 */
@Composable
fun HelmTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = HelmColorScheme,
        typography = HelmTypography,
        shapes = HelmShapes,
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(HelmColors.Bg)
                .safeDrawingPadding(),
        ) {
            content()
        }
    }
}
