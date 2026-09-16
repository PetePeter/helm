package com.potatomotato.helm.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/** How dark the app goes behind anything asking a question. One value, app-wide. */
const val SCRIM_ALPHA = 0.72f

/**
 * A question asked over the screen it interrupts.
 *
 * The chrome — scrim, dismiss-on-scrim-tap, the card that swallows its own taps
 * — is the same every time and is exactly the part that is dangerous to get
 * subtly wrong: a card that lets a tap fall through to the scrim cancels the
 * dialog under the user's finger. So it is written once here and the callers
 * supply only the question and its answers.
 *
 * Deliberately NOT a Material Dialog: this app draws its own surfaces from
 * [HelmColors], and a platform dialog arrives with its own fill and elevation
 * that no token here can reach.
 */
@Composable
fun ScrimDialog(
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    /** Said quietly under the title, when the choice needs a consequence spelled out. */
    body: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(HelmColors.Bg.copy(alpha = SCRIM_ALPHA))
            // Tapping the darkness around the card is the cancel.
            .clickable(onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(HelmSpacing.Gutter)
                .clip(RoundedCornerShape(HelmRadius.Md))
                .background(HelmColors.Surface)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
                // A bare pointer input, not an empty clickable: it keeps card
                // taps from reaching the scrim without adding the unlabeled
                // no-op node an empty clickable puts in the tree.
                .pointerInput(Unit) {}
                .padding(HelmSpacing.Lg),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        ) {
            Text(text = title, color = HelmColors.Txt, style = MaterialTheme.typography.titleMedium)
            if (body != null) {
                Text(text = body, color = HelmColors.Dim, style = MaterialTheme.typography.bodyMedium)
            }
            content()
        }
    }
}

/**
 * A full-width text answer inside a [ScrimDialog].
 *
 * [enabled] draws the label back to [HelmColors.Faint] rather than removing it:
 * an answer that vanishes when it is not available leaves the user wondering
 * what they did, and one that stays bright trains tapping through it.
 */
@Composable
fun DialogAction(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    /** Accent for the answer the user came to give; Dim for the ordinary ones. */
    emphasised: Boolean = true,
) {
    Text(
        text = text,
        color = when {
            !enabled -> HelmColors.Faint
            emphasised -> HelmColors.Accent
            else -> HelmColors.Dim
        },
        style = MaterialTheme.typography.labelLarge,
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = HelmSpacing.Md),
    )
}
