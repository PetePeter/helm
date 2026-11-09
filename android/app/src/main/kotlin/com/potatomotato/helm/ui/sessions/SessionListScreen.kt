package com.potatomotato.helm.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.data.Reach
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.SessionListState
import com.potatomotato.helm.data.answered
import com.potatomotato.helm.data.permits
import com.potatomotato.helm.data.sessionListState
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.PrimaryButton
import com.potatomotato.helm.ui.keyboard.LocalKeyboardFocusState
import com.potatomotato.helm.ui.keyboard.keyboardFocusTarget
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * Mockup screen 1 — every session Helm is running, grouped by project.
 *
 * The list is keyed on session id so a poll that changes one dot recomposes one
 * row; [com.potatomotato.helm.data.SessionRepository] does the merging that
 * makes that true. Ordering is decided there too, never here.
 *
 * Groups collapse: the header carries a chevron and the group's size, and the
 * collapsed set is kept OUTSIDE the poll loop, so a refresh never re-expands a
 * group the user folded.
 */
@Composable
fun SessionListScreen(
    sessions: List<HelmSession>,
    linkState: LinkState,
    reach: Reach,
    capabilities: Capabilities,
    /** Per-session unread chat counts; a row with one wears the badge. */
    unread: Map<String, Int>,
    /** Per-session token history for the row graph; absent where no reply carried stats. */
    contextHistories: Map<String, ContextHistory>,
    onOpen: (HelmSession) -> Unit,
    /** Long-press acts on a session from the list — see HelmHome for the routing. */
    onLongPress: (HelmSession) -> Unit,
    /** A spawn is already crossing the wire; opening the form would ask for a second. */
    spawnInFlight: Boolean,
    onNewSession: () -> Unit,
    onPairDesktop: () -> Unit,
    selectedId: String? = null,
    modifier: Modifier = Modifier,
) {
    // A Set is not Bundle-saveable; a List of the same strings is. The collapsed
    // set is rebuilt on read, so duplicates cannot accumulate.
    var collapsedList by rememberSaveable { mutableStateOf(listOf<String>()) }
    val collapsed = collapsedList.toSet()
    val keyboardFocus = LocalKeyboardFocusState.current

    Column(
        modifier = modifier.fillMaxSize()
            .keyboardFocusTarget(keyboardFocus?.sessionListRequester)
            .background(HelmColors.Bg),
    ) {
        // Only while there is nothing to pair WITH: once a desktop is connected
        // (or connecting) the button is an answer to a question already answered,
        // and it was crowding the list on every poll.
        if (linkState == LinkState.Disconnected || linkState == LinkState.Advertising) {
            GhostButton(
                text = stringResource(R.string.pairing_pair_desktop),
                onClick = onPairDesktop,
                modifier = Modifier.padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
            )
        }

        // The spawner stays pinned below either branch: zero sessions is exactly
        // when the user most needs to start one.
        if (sessions.isEmpty()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                EmptyList(sessionListState(linkState, sessions, reach))
            }
        } else SessionRowsContent(
            sessions = sessions,
            unread = unread,
            contextHistories = contextHistories,
            collapsedGroups = collapsed,
            selectedId = selectedId,
            onToggleGroup = { label -> collapsedList = SessionRows.toggle(collapsed, label).toList() },
            onOpen = onOpen,
            onLongPress = onLongPress,
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )

        NewSessionButton(capabilities = capabilities, spawnInFlight = spawnInFlight, onClick = onNewSession)
    }
}

/**
 * The one creation affordance on the phone, pinned to the bottom per the
 * mockup's one-handed rule. It obeys the sheet's honesty rules exactly: greyed
 * without a verdict while the capability is Unknown, greyed with the reason
 * once the gate has answered no.
 */
@Composable
private fun NewSessionButton(capabilities: Capabilities, spawnInFlight: Boolean, onClick: () -> Unit) {
    val permitted = capabilities.permits(SessionAction.Spawn)

    Column {
        Hairline()
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(HelmColors.Surface)
                .padding(HelmSpacing.Md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        ) {
            Box(modifier = Modifier.weight(1f)) {
                PrimaryButton(
                    text = stringResource(R.string.sessions_new_session),
                    onClick = onClick,
                    enabled = permitted && !spawnInFlight,
                )
            }
            if (!permitted) {
                Text(
                    text = stringResource(
                        if (capabilities.answered) R.string.control_not_permitted else R.string.control_asking,
                    ),
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
    }
}

@Composable
fun SessionSwipePicker(
    sessions: List<HelmSession>,
    unread: Map<String, Int>,
    selectedId: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    SessionRowsContent(
        sessions = sessions,
        unread = unread,
        contextHistories = emptyMap(),
        collapsedGroups = emptySet(),
        selectedId = selectedId,
        onToggleGroup = {},
        onOpen = { onSelect(it.id) },
        onLongPress = {},
        compact = true,
        modifier = modifier,
    )
}


/**
 * Nothing to show is five different situations, and conflating them is how a
 * user ends up staring at a confident sentence the app never had grounds for.
 *
 * The decision lives in [sessionListState] where it can be tested; this is a
 * dumb reader of the answer.
 */
@Composable
private fun EmptyList(state: SessionListState) {
    val message = when (state) {
        SessionListState.NoLink -> R.string.sessions_no_link
        SessionListState.NotPermitted -> R.string.sessions_not_permitted
        SessionListState.Unreadable -> R.string.sessions_unreadable
        SessionListState.Loading -> R.string.sessions_loading
        // Populated never reaches here — the list drew itself.
        SessionListState.Empty, SessionListState.Populated -> R.string.sessions_none
    }

    Box(
        modifier = Modifier.fillMaxSize().padding(HelmSpacing.Xl),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = stringResource(message),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )
    }
}
