package com.potatomotato.helm.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.components.DialogAction
import com.potatomotato.helm.ui.components.ScrimDialog
import androidx.activity.compose.BackHandler
import com.potatomotato.helm.ui.control.SessionSheet
import com.potatomotato.helm.ui.share.ShareWaitDialog
import com.potatomotato.helm.data.ShareState

@Composable
internal fun PhoneOverlays(state: PhoneScaffoldState, actions: PhoneScaffoldActions, atRoot: Boolean) {
    // The sheet overlays the thread so the session stays visible behind its actions.
    if (state.open != null && state.homeState.destination == Destination.Sheet) {
        val session = state.open
        BackHandler(onBack = actions.overlay.onBackToThread)
        SessionSheet(
            sessionName = session.name,
            keepWarm = (session.keepWarmUntilEpochMs ?: 0L) > System.currentTimeMillis(),
            frozen = session.frozen,
            capabilities = state.capabilities,
            onDismiss = actions.overlay.onBackToThread,
            onAction = actions.overlay.onSessionAction,
            onRename = actions.overlay.onRenameSession,
            clis = state.clis,
            onSwitchCli = actions.overlay.onSwitchCli,
        )
    }

    if (state.homeState.leaving && atRoot) {
        ExitDialog(
            onBackground = actions.overlay.onBackground,
            onQuit = actions.overlay.onQuit,
            onDismiss = actions.overlay.onExitDismiss,
        )
    }
    if (state.chatAttachSession != null) {
        ShareWaitDialog(
            state = state.shareState as? ShareState.Sending,
            onContinue = actions.overlay.onContinueShare,
            onCancel = actions.overlay.onCancelShare,
        )
    }
}

/** The one question back asks at the root. See the root BackHandler for why. */
@Composable
internal fun ExitDialog(onBackground: () -> Unit, onQuit: () -> Unit, onDismiss: () -> Unit) {
    ScrimDialog(
        title = stringResource(R.string.exit_title),
        body = stringResource(R.string.exit_body),
        onDismiss = onDismiss,
    ) {
        // Backgrounding leads because it is both the safe answer and the one
        // the user almost always meant by pressing back.
        DialogAction(text = stringResource(R.string.exit_background), onClick = onBackground)
        DialogAction(text = stringResource(R.string.exit_quit), onClick = onQuit, emphasised = false)
        DialogAction(text = stringResource(R.string.exit_cancel), onClick = onDismiss, emphasised = false)
    }
}
