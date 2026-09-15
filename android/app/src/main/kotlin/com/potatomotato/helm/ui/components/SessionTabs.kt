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
enum class SessionTab { Chat, Artifacts }

private val SessionTab.labelRes: Int
    get() = when (this) {
        SessionTab.Chat -> R.string.session_tab_chat
        SessionTab.Artifacts -> R.string.session_tab_artifacts
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
    Column(modifier = modifier.fillMaxWidth().background(HelmColors.Surface)) {
        Row(modifier = Modifier.fillMaxWidth()) {
            SessionTab.entries.forEach { tab ->
                Tab(
                    tab = tab,
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
    tab: SessionTab,
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
                text = stringResource(tab.labelRes),
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
