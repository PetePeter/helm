package com.potatomotato.helm.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize

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
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Button(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        colors = ButtonDefaults.buttonColors(
            containerColor = HelmColors.Accent,
            contentColor = HelmColors.OnAccent,
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
