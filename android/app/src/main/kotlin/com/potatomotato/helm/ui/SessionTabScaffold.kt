package com.potatomotato.helm.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.ui.components.ContextRingButton
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.SessionState
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.components.SessionTabs

/**
 * The chrome an open session wears, whichever tab is showing.
 *
 * One owner for the bar and tab row means switching tabs re-lays out only the
 * body: the title, link badge and overflow action do not blink or drift apart.
 */
@Composable
internal fun SessionTabScaffold(
    modifier: Modifier = Modifier,
    sessionName: String,
    mission: String?,
    details: String,
    context: ContextHistory?,
    activity: SessionState,
    linkState: LinkState,
    tab: SessionTab,
    onSelectTab: (SessionTab) -> Unit,
    onBack: () -> Unit,
    onOverflow: () -> Unit,
    header: (@Composable () -> Unit)? = null,
    afterHeader: (@Composable () -> Unit)? = null,
    body: @Composable () -> Unit,
) {
    Column(modifier = modifier.fillMaxSize()) {
        if (header == null) {
            HelmAppBar(
                title = sessionName,
                subtitle = mission,
                detailLine = details,
                linkState = linkState,
                onBack = onBack,
                showLinkBadge = false,
                leading = { ContextRingButton(state = activity, history = context) },
                onOverflow = onOverflow,
            )
        } else header()
        afterHeader?.invoke()
        SessionTabs(selected = tab, onSelect = onSelectTab)
        Box(modifier = Modifier.weight(1f)) { body() }
    }
}
