package com.potatomotato.helm.ui

import androidx.activity.compose.BackHandler
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
import com.potatomotato.helm.link.HelmClient
import com.potatomotato.helm.link.HelmPairing
import com.potatomotato.helm.ui.chat.ChatScreen
import com.potatomotato.helm.ui.sessions.SessionListScreen
import com.potatomotato.helm.ui.voice.VoiceScreen
import kotlinx.coroutines.delay

/**
 * The screens the user lives in, and the navigation between them.
 *
 * Navigation is a nullable session id plus a flag rather than a nav library:
 * there are three destinations on one straight path (list → thread → voice) and
 * a graph definition would be more machinery than the thing it describes. Both
 * are [rememberSaveable] so a rotation does not drop the user back to the list,
 * or out of a dictation they are halfway through.
 */
@Composable
fun HelmHome(client: HelmClient = HelmPairing.client, modifier: Modifier = Modifier) {
    val linkState by HelmLink.state.collectAsState()
    val sessions by client.sessions.sessions.collectAsState()
    val threads by client.chats.threads.collectAsState()
    var openSessionId by rememberSaveable { mutableStateOf<String?>(null) }
    var dictating by rememberSaveable { mutableStateOf(false) }

    PollSessions(client)

    val open = sessions.firstOrNull { it.id == openSessionId }
    if (openSessionId != null && open == null && sessions.isNotEmpty()) {
        // The session went away while it was on screen. Fall back to the list
        // rather than leaving the user in a thread that can no longer be replied to.
        openSessionId = null
        dictating = false
    }

    if (open != null && dictating) {
        // Sending returns to the thread rather than the list: the message lands
        // there in its Sending state, so the user sees where the words went and
        // watches them deliver instead of being left with no evidence.
        VoiceScreen(
            sessionName = open.name,
            linkState = linkState,
            onCancel = { dictating = false },
            onSend = { text ->
                client.sendChat(open.id, text)
                dictating = false
            },
            modifier = modifier,
        )
    } else if (open != null) {
        BackHandler { openSessionId = null }
        ChatScreen(
            sessionId = open.id,
            sessionName = open.name,
            messages = threads[open.id].orEmpty(),
            linkState = linkState,
            onBack = { openSessionId = null },
            onSend = { text -> client.sendChat(open.id, text) },
            onVoice = { dictating = true },
            modifier = modifier,
        )
    } else {
        SessionListScreen(
            sessions = sessions,
            linkState = linkState,
            onOpen = { openSessionId = it.id },
            modifier = modifier,
        )
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
