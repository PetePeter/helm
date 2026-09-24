package com.potatomotato.helm.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The one "are you sure" for anything destructive — artifacts, plans,
 * sequences, cleanup. Promoted out of the artifacts screen (P-0812) so every
 * delete in the app asks the same way, over [ScrimDialog]'s chrome.
 *
 * [confirmText] defaults to "Delete it"; a cleanup that deletes many things
 * names what it does instead.
 */
@Composable
fun ConfirmDelete(
    message: String,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    confirmText: String = stringResource(R.string.artifacts_confirm_delete_yes),
) {
    ScrimDialog(title = message, onDismiss = onCancel) {
        // The destructive one is NOT the loud accent button: the accent means
        // "the thing you came here to do", and that is never losing work.
        Text(
            text = confirmText,
            color = HelmColors.Danger,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Md))
                .clickable(onClick = onConfirm)
                .padding(vertical = HelmSpacing.Md),
        )
        GhostButton(text = stringResource(R.string.control_confirm_close_no), onClick = onCancel)
    }
}
