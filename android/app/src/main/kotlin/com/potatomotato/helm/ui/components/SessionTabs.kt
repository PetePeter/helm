package com.potatomotato.helm.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The surfaces a single session shows, side by side.
 *
 * A session has more than a conversation, and burying the rest in the overflow
 * sheet made them feel like ACTIONS rather than places. These are places, so they
 * get a tab each — the same shape the desktop pane uses. The sheet keeps only the
 * things that DO something (rename, compact, close, snapshot, spawn).
 */
enum class SessionTab { Chat, Artifacts, Plans, Sequences }

private val SessionTab.labelRes: Int
    get() = when (this) {
        SessionTab.Chat -> R.string.session_tab_chat
        SessionTab.Artifacts -> R.string.session_tab_artifacts
        SessionTab.Plans -> R.string.session_tab_plans
        SessionTab.Sequences -> R.string.session_tab_sequences
    }

/**
 * The places the app's ROOT has, as opposed to the places one session has.
 *
 * Sessions is first and is what the app opens on: the plan board and the context
 * browser are things you go and look at, while a session is the thing you came
 * to use. There is no Sequences entry here — a sequence with no plans beside it
 * is a lane header with nothing in it, and the board already draws the lanes.
 *
 * The switch between them lives in the root app bar's context-label menu, not a
 * tab row: three whole surfaces is a place you go, and the bar's label names
 * where you are.
 */
enum class HomeTab { Sessions, Plans, Contexts }

internal val HomeTab.labelRes: Int
    get() = when (this) {
        HomeTab.Sessions -> R.string.home_tab_sessions
        HomeTab.Plans -> R.string.home_tab_plans
        HomeTab.Contexts -> R.string.home_tab_contexts
    }

/**
 * The glyph that leads each surface in the root bar's menu — see [ContextMenuItem].
 * It lives on the enum rather than beside the menu so a surface's name and its
 * mark cannot drift apart.
 */
internal val HomeTab.glyphRes: Int
    get() = when (this) {
        HomeTab.Sessions -> R.string.context_glyph_sessions
        HomeTab.Plans -> R.string.context_glyph_plans
        HomeTab.Contexts -> R.string.context_glyph_contexts
    }

/**
 * The tab row under the session's app bar.
 *
 * Selection is carried by the ACCENT underline and full-white label, never by a
 * fill: a filled tab on true black would read as a raised surface, and elevation
 * here is a hairline by contract (see [HelmColors]).
 */
@Composable
fun SessionTabs(
    selected: SessionTab,
    onSelect: (SessionTab) -> Unit,
    modifier: Modifier = Modifier,
) {
    TabRow(
        tabs = SessionTab.entries,
        selected = selected,
        labelRes = { it.labelRes },
        onSelect = onSelect,
        modifier = modifier,
    )
}

/**
 * The tab row at the app's root was retired: the root's surfaces switch through
 * the app bar's context-label menu instead (see [HelmAppBar] contextMenuItems).
 * [TabRow] remains owned by the session's own tabs — one look for "these are
 * places side by side" where the places belong to a session.
 */
@Composable
private fun <T> TabRow(
    tabs: List<T>,
    selected: T,
    labelRes: (T) -> Int,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth().background(HelmColors.Surface)) {
        Row(modifier = Modifier.fillMaxWidth()) {
            tabs.forEach { tab ->
                Tab(
                    labelRes = labelRes(tab),
                    isSelected = tab == selected,
                    onSelect = { onSelect(tab) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        Hairline()
    }
}

@Composable
private fun Tab(
    labelRes: Int,
    isSelected: Boolean,
    onSelect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.clickable(onClick = onSelect)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = HelmSize.TouchTarget)
                .padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Md),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(labelRes),
                color = if (isSelected) HelmColors.Txt else HelmColors.Dim,
                style = MaterialTheme.typography.titleSmall,
                textAlign = TextAlign.Center,
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(HelmSize.TabIndicator)
                .background(if (isSelected) HelmColors.Accent else HelmColors.Surface),
        )
    }
}
