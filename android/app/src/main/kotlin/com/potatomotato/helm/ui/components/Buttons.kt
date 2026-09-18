package com.potatomotato.helm.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmType

/**
 * The mockup has exactly two button shapes, and every screen uses them. They
 * live here so "the loud one" and "the quiet one" are one definition rather
 * than per-screen guesswork.
 *
 * Both are full width: every primary action in the mockup sits in the lower
 * third, spanning the gutters, for one-handed reach.
 */

/** The loud one — accent fill, near-black label. One per screen at most. */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth(),
        colors = ButtonDefaults.buttonColors(
            containerColor = HelmColors.Accent,
            contentColor = HelmColors.OnAccent,
            // Disabled is the accent held back, not a new grey: the button must
            // read as the same control, temporarily not offered.
            disabledContainerColor = HelmColors.Surface2,
            disabledContentColor = HelmColors.Faint,
        ),
    ) {
        Text(text = text)
    }
}

/** The quiet one — transparent, hairline border, dim label. Never a fill. */
@Composable
fun GhostButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        border = BorderStroke(HelmSize.Hairline, HelmColors.Line),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = HelmColors.Dim),
    ) {
        Text(text = text)
    }
}

/**
 * The round one — the composer's send/mic circles, promoted here because a
 * second screen now needs them: the artifact editor's attach toolbar. Same
 * 40dp circle, same accent fill, same disabled treatment (Surface2 + hairline,
 * never a half-opacity accent), so a lime circle means the same thing at
 * whatever screen it stands on.
 *
 * [glyph] is a text glyph from strings.xml, not an icon asset — the app's
 * controls are drawn from the type ramp the same way the composer's are.
 */
@Composable
fun RoundAccentButton(
    glyph: String,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Box(
        modifier = modifier
            .size(HelmSize.MicButton)
            .clip(CircleShape)
            .background(if (enabled) HelmColors.Accent else HelmColors.Surface2)
            .then(
                if (enabled) {
                    Modifier
                } else {
                    Modifier.border(HelmSize.Hairline, HelmColors.Line, CircleShape)
                },
            )
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = glyph,
            // Dim rather than Faint while disabled, for the composer's reason:
            // Faint is the placeholder colour and disappears against Surface2,
            // which reads as a layout hole, not a dead control.
            color = if (enabled) HelmColors.OnAccent else HelmColors.Dim,
            style = HelmType.SendGlyph,
            modifier = Modifier.semantics { this.contentDescription = contentDescription },
        )
    }
}
