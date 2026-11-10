package com.potatomotato.helm.ui.tablet

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.TabletPaneHeightStore
import com.potatomotato.helm.ui.theme.HelmColors

/** Shared tablet app bar and pane frame, also used by the width previews. */
@Composable
internal fun TabletShellFrame(
    modifier: Modifier = Modifier,
    topBar: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    Column(modifier = modifier.fillMaxSize()) {
        topBar()
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
    }
}

/** The collapsed tablet keeps its session picker header even with no selection. */
@Composable
internal fun TabletCollapsedEmptyPane(
    modifier: Modifier = Modifier,
    header: @Composable () -> Unit,
) {
    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        header()
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text(
                text = TABLET_SELECT_SESSION,
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}

/** The expanded tablet's actual split pane structure with caller-owned content. */
@Composable
internal fun TabletExpandedShell(
    listWidth: Dp,
    heightStore: TabletPaneHeightStore,
    modifier: Modifier = Modifier,
    sessionsHeader: @Composable () -> Unit,
    sessions: @Composable (Modifier) -> Unit,
    todos: @Composable (Modifier) -> Unit,
    detail: @Composable (Modifier) -> Unit,
) {
    Row(modifier.fillMaxSize()) {
        Column(Modifier.width(listWidth).fillMaxHeight()) {
            sessionsHeader()
            TabletSplitter(
                store = heightStore,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                sessions = sessions,
                todos = todos,
            )
        }
        Box(Modifier.width(1.dp).fillMaxHeight().background(HelmColors.Line))
        Box(Modifier.weight(1f).fillMaxHeight()) { detail(Modifier.fillMaxSize()) }
    }
}
