package com.potatomotato.helm.ui.tablet

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.data.HelmCli
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.ui.SessionTabScaffold
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.ui.control.SessionActionBar
import com.potatomotato.helm.ui.control.sessionActions
import com.potatomotato.helm.ui.sessionHeaderDetails
import com.potatomotato.helm.ui.rememberEtaNow

internal data class TabletSessionDetailActions(
    val onSelectTab: (SessionTab) -> Unit,
    val onBack: () -> Unit,
    val onOverflow: () -> Unit,
    val onSessionAction: (SessionAction) -> Unit,
    val onRename: (String) -> Unit,
    val onSwitchCli: (String) -> Unit,
)

/** One tablet session surface: session chrome, action bar, tabs, then its body. */
@Composable
internal fun TabletSessionDetail(
    session: HelmSession,
    context: ContextHistory?,
    linkState: LinkState,
    tab: SessionTab,
    capabilities: Capabilities,
    clis: List<HelmCli>,
    actions: TabletSessionDetailActions,
    modifier: Modifier = Modifier,
    header: @Composable (@Composable () -> Unit) -> Unit,
    body: @Composable () -> Unit,
) {
    val nowMs = rememberEtaNow(listOfNotNull(session.eta))
    val keepWarm = session.keepWarm
    val actionModel = remember(keepWarm, session.frozen, capabilities) {
        sessionActions(keepWarm, session.frozen, capabilities)
    }
    val actionBar: @Composable () -> Unit = {
        SessionActionBar(
            actions = actionModel,
            sessionName = session.name,
            clis = clis,
            onAction = actions.onSessionAction,
            onRename = actions.onRename,
            onSwitchCli = actions.onSwitchCli,
        )
    }
    SessionTabScaffold(
        modifier = modifier,
        sessionName = session.name,
        mission = session.mission,
        details = sessionHeaderDetails(session, nowMs),
        context = context,
        quotaUsage = session.quotaUsage,
        activity = session.activity,
        linkState = linkState,
        tab = tab,
        onSelectTab = actions.onSelectTab,
        onBack = actions.onBack,
        onOverflow = actions.onOverflow,
        header = { header(actionBar) },
        body = body,
    )
}
