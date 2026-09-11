package com.potatomotato.helm.ui.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.potatomotato.helm.R

// Ratified palette. The design system (P-0740) will own these; until it lands
// they match MainActivity's rather than inventing a second set.
private val Accent = Color(0xFFCCFF00)
private val OnAccent = Color(0xFF0D1200)
private val Muted = Color(0xFF9A9A9A)
private val Warning = Color(0xFFFBBF24)

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
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text(text = stringResource(R.string.pairing_title), color = Muted, fontSize = 14.sp)
        Text(text = desktopId, color = Color.White, fontSize = 20.sp, textAlign = TextAlign.Center)

        Text(
            text = sas.spaced(),
            color = Accent,
            fontSize = 52.sp,
            textAlign = TextAlign.Center,
        )

        Text(
            text = stringResource(R.string.pairing_prompt),
            color = Color.White,
            textAlign = TextAlign.Center,
        )
        Text(
            text = stringResource(R.string.pairing_warning),
            color = Warning,
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
        ) {
            Button(
                onClick = onReject,
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF1A1A1A),
                    contentColor = Color.White,
                ),
            ) {
                Text(text = stringResource(R.string.pairing_reject))
            }
            Button(
                onClick = onMatch,
                colors = ButtonDefaults.buttonColors(
                    containerColor = Accent,
                    contentColor = OnAccent,
                ),
            ) {
                Text(text = stringResource(R.string.pairing_match))
            }
        }
    }
}

/** "830701" -> "830 701": three-and-three is far easier to read off a screen. */
private fun String.spaced(): String =
    if (length == 6) "${substring(0, 3)} ${substring(3)}" else this
