package com.potatomotato.helm.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.potatomotato.helm.ble.HelmLink
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.ui.chat.ChatScreen
import com.potatomotato.helm.ui.control.ActionNoticeBar
import com.potatomotato.helm.ui.control.SessionSheet
import com.potatomotato.helm.ui.control.SnapshotScreen
import com.potatomotato.helm.ui.control.SpawnScreen
import com.potatomotato.helm.ui.sessions.SessionListScreen
import com.potatomotato.helm.ui.voice.VoiceScreen
import kotlinx.coroutines.delay

/**
 * Where the session's thread can take you. One straight path still — the sheet
 * and the screens it opens all hang off a session's thread, never off each other.
 */
private enum class Destination { Thread, Voice, Sheet, Snapshot, Spawn }

/**
 * The screens the user lives in, and the navigation between them.
 *
 * Navigation is a nullable session id plus a destination rather than a nav
 * library: the graph is a star around one thread, and a graph definition would be
 * more machinery than the thing it describes. Both are [rememberSaveable] so a
 * rotation does not drop the user back to the list, out of a dictation they are
 * halfway through, or out of a snapshot they are reading.
 */
@Composable
fun HelmHome(client: HelmClient = HelmPairing.client, modifier: Modifier = Modifier) {
    val linkState by HelmLink.state.collectAsState()
    val sessions by client.sessions.sessions.collectAsState()
    val threads by client.chats.threads.collectAsState()
    val capabilities by client.capabilities.state.collectAsState()
    val snapshot by client.control.snapshot.collectAsState()
    val notice by client.control.notice.collectAsState()
    val directories by client.control.directories.collectAsState()
    var openSessionId by rememberSaveable { mutableStateOf<String?>(null) }
    var where by rememberSaveable { mutableStateOf(Destination.Thread) }

    PollSessions(client)

    val open = sessions.firstOrNull { it.id == openSessionId }
    if (openSessionId != null && open == null && sessions.isNotEmpty()) {
        // The session went away while it was on screen. Fall back to the list
        // rather than leaving the user in a thread that can no longer be replied to.
        openSessionId = null
        where = Destination.Thread
    }

    // The permitted surface is asked for when a control screen needs it and is
    // forgotten with the link, so a reconnect re-asks and a capability revoked on
    // the desktop stops being offered.
    LaunchedEffect(where, capabilities) {
        if (where == Destination.Sheet && capabilities is Capabilities.Unknown) {
            client.refreshCapabilities()
        }
    }
    LaunchedEffect(where) {
        if (where == Destination.Spawn && directories.isEmpty()) client.refreshDirectories()
    }

    val toThread = { where = Destination.Thread }

    Column(modifier = modifier.fillMaxSize()) {
        notice?.let { ActionNoticeBar(notice = it, onDismiss = client.control::clearNotice) }

        Box(modifier = Modifier.fillMaxSize()) {
            when {
                open == null -> SessionListScreen(
                    sessions = sessions,
                    linkState = linkState,
                    onOpen = { openSessionId = it.id },
                )

                where == Destination.Voice -> VoiceScreen(
                    sessionName = open.name,
                    linkState = linkState,
                    onCancel = toThread,
                    // Sending returns to the thread rather than the list: the
                    // message lands there in its Sending state, so the user sees
                    // where the words went and watches them deliver.
                    onSend = { text ->
                        client.sendChat(open.id, text)
                        where = Destination.Thread
                    },
                )

                where == Destination.Snapshot -> {
                    BackHandler(onBack = toThread)
                    SnapshotScreen(
                        snapshot = snapshot,
                        linkState = linkState,
                        onPull = { lines -> client.readTerminal(open.id, lines) },
                        onBack = toThread,
                    )
                }

                where == Destination.Spawn -> {
                    BackHandler(onBack = toThread)
                    SpawnScreen(
                        directories = directories,
                        sessions = sessions,
                        linkState = linkState,
                        onSpawn = { dirPath, cliType, name ->
                            client.spawn(dirPath, cliType, name)
                            where = Destination.Thread
                        },
                        onBack = toThread,
                    )
                }

                else -> {
                    BackHandler { openSessionId = null }
                    ChatScreen(
                        sessionId = open.id,
                        sessionName = open.name,
                        messages = threads[open.id].orEmpty(),
                        linkState = linkState,
                        onBack = { openSessionId = null },
                        onSend = { text -> client.sendChat(open.id, text) },
                        onVoice = { where = Destination.Voice },
                        onOverflow = { where = Destination.Sheet },
                    )
                }
            }

            // The sheet is an overlay on the thread, not a screen of its own: the
            // conversation stays visible behind the scrim, which is what tells the
            // user which session these actions belong to.
            if (open != null && where == Destination.Sheet) {
                BackHandler(onBack = toThread)
                SessionSheet(
                    sessionName = open.name,
                    capabilities = capabilities,
                    onDismiss = toThread,
                    onAction = { action ->
                        where = when (action) {
                            SessionAction.Snapshot -> Destination.Snapshot
                            SessionAction.Spawn -> Destination.Spawn
                            SessionAction.Compact -> Destination.Thread.also { client.compact(open.id) }
                            SessionAction.Close -> Destination.Thread.also { client.closeSession(open.id) }
                        }
                        // A snapshot is pulled as soon as it is asked for, at the
                        // middle count: arriving on an empty terminal screen and
                        // having to choose again is a step nobody wants.
                        if (action == SessionAction.Snapshot) client.readTerminal(open.id, DEFAULT_SNAPSHOT_LINES)
                    },
                )
            }
        }
    }
}

/**
 * Keep the list fresh while the user can see it — and ONLY while they can.
 *
 * The desktop's per-device budget (60 calls/min) was sized for a visible screen,
 * not a background loop, so the poll is scoped to STARTED: a phone in a pocket
 * spends nothing, and the first poll after it comes out is immediate.
 */
@Composable
private fun PollSessions(client: HelmClient) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                client.refreshSessions()
                delay(POLL_INTERVAL_MS)
            }
        }
    }
}

/** Half the per-device budget, leaving room for whatever the user is doing. */
private const val POLL_INTERVAL_MS = 2_000L

/** The middle chip on screen 7 — enough to read, cheap enough to not think about. */
private const val DEFAULT_SNAPSHOT_LINES = 200
