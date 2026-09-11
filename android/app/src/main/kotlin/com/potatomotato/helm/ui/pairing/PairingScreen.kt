package com.potatomotato.helm.ui.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.PrimaryButton
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmType

/**
 * Screen 5 of the mockup: the SAS comparison.
 *
 * The six digits are the ONLY thing standing between the user and a
 * man-in-the-middle, so the screen is built to make comparing them the obvious
 * action: the digits dominate, the two verdicts are equally reachable, and the
 * consequence of a mismatch is stated plainly rather than buried.
 *
 * Rejecting is not a cancel. It closes the link and persists nothing.
 */
@Composable
fun PairingScreen(
    desktopId: String,
    sas: String,
    onMatch: () -> Unit,
    onReject: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Lg),
    ) {
        Text(
            text = stringResource(R.string.pairing_title),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.labelSmall,
        )
        Text(
            text = desktopId,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.titleLarge,
            textAlign = TextAlign.Center,
        )

        Text(
            text = stringResource(R.string.pairing_prompt),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )

        SasDigits(sas)

        Text(
            text = stringResource(R.string.pairing_warning),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center,
        )

        // Stacked, not side by side. "They match" is the action the user came
        // to take; putting Reject beside it invites a mis-tap on the one screen
        // where a mis-tap costs the whole security property.
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            PrimaryButton(text = stringResource(R.string.pairing_match), onClick = onMatch)
            GhostButton(text = stringResource(R.string.pairing_reject), onClick = onReject)
        }
    }
}

/**
 * One cell per digit. Splitting them stops the eye reading the code as a number
 * and makes a digit-by-digit comparison against the desktop the natural motion.
 */
@Composable
private fun SasDigits(sas: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs)) {
        sas.forEach { digit ->
            Box(
                modifier = Modifier
                    .width(HelmSize.SasCellWidth)
                    .height(HelmSize.SasCellHeight)
                    .background(HelmColors.Surface2, RoundedCornerShape(HelmRadius.Sm))
                    .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Sm)),
                contentAlignment = Alignment.Center,
            ) {
                Text(text = digit.toString(), color = HelmColors.Accent, style = HelmType.SasDigit)
            }
        }
    }
}
