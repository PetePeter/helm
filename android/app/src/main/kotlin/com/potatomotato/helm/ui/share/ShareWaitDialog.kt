package com.potatomotato.helm.ui.share

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ShareState
import com.potatomotato.helm.data.ShareWaitStage
import com.potatomotato.helm.data.megabytes
import com.potatomotato.helm.ui.components.DialogAction
import com.potatomotato.helm.ui.components.ScrimDialog

/** A slow upload keeps running while the user decides whether to wait longer. */
@Composable
fun ShareWaitDialog(
    state: ShareState.Sending?,
    onContinue: (attemptId: Long) -> Unit,
    onCancel: (attemptId: Long) -> Unit,
) {
    val current = state ?: return
    if (current.waitStage == ShareWaitStage.Uploading) return

    val cancelling = current.waitStage == ShareWaitStage.Cancelling
    val asking = current.waitStage == ShareWaitStage.AskToContinue
    ScrimDialog(
        title = stringResource(if (cancelling) R.string.share_wait_cancelling else R.string.share_wait_title),
        body = when {
            cancelling -> stringResource(R.string.share_wait_cancel_body)
            asking -> stringResource(R.string.share_wait_prompt_body)
            else -> stringResource(
                R.string.share_wait_progress_body,
                megabytes(current.sent),
                megabytes(current.total),
            )
        },
        // It stays up until the upload completes or the user chooses an action.
        onDismiss = {},
    ) {
        if (asking) {
            DialogAction(
                text = stringResource(R.string.share_wait_continue),
                onClick = { onContinue(current.attemptId) },
            )
        }
        if (!cancelling) {
            DialogAction(
                text = stringResource(R.string.share_wait_cancel),
                onClick = { onCancel(current.attemptId) },
                emphasised = false,
            )
        }
    }
}
