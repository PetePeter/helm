package com.potatomotato.helm.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.data.Delivery
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * Mockup screen 2 — one session's conversation, and the reply box.
 *
 * This is the forum topic done properly: the thread is the session, the reply
 * goes to the session's PTY, and the link state stays on the bar so a message
 * typed into a dead link is never mistaken for one that was delivered.
 */
@Composable
fun ChatScreen(
    sessionId: String,
    sessionName: String,
    messages: List<ChatMessage>,
    linkState: LinkState,
    onBack: () -> Unit,
    onSend: (String) -> Unit,
    onVoice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Keyed on the session, and saveable: a half-typed reply survives a rotation
    // but must NEVER follow the user into a different session's thread.
    var draft by rememberSaveable(sessionId) { mutableStateOf("") }
    val listState = rememberLazyListState()

    // Follow the conversation, but only from the bottom. A user who has scrolled
    // up is READING; yanking them back to the newest line on every arriving
    // message — or on a reconnect that delivers a backlog — loses their place,
    // which is exactly what a link drop must not do. The check reads the layout
    // as it is when the message lands, never a value captured earlier.
    LaunchedEffect(messages.size) {
        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
        val wasAtBottom = lastVisible < 0 || lastVisible >= messages.size - 2
        if (messages.isNotEmpty() && wasAtBottom) listState.scrollToItem(messages.lastIndex)
    }

    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg).imePadding()) {
        HelmAppBar(title = sessionName, linkState = linkState, onBack = onBack)

        if (messages.isEmpty()) {
            Box(
                modifier = Modifier.weight(1f).fillMaxWidth().padding(HelmSpacing.Xl),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(R.string.chat_empty),
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
                )
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(HelmSpacing.Gutter),
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            ) {
                items(messages, key = { it.key }) { Bubble(it) }
            }
        }

        Composer(
            draft = draft,
            onDraft = { draft = it },
            onVoice = onVoice,
            onSend = {
                val text = draft.trim()
                if (text.isNotEmpty()) {
                    onSend(text)
                    draft = ""
                }
            },
        )
    }
}

@Composable
private fun Bubble(message: ChatMessage) {
    val fromPhone = message.fromPhone

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (fromPhone) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            horizontalAlignment = if (fromPhone) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = BUBBLE_MAX_WIDTH),
        ) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(HelmRadius.Lg))
                    .background(if (fromPhone) HelmColors.Surface2 else HelmColors.Surface)
                    .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
            ) {
                Text(
                    text = message.text.ifEmpty { stringResource(R.string.chat_attachment) },
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            // Only outgoing messages carry a delivery state, and only the two
            // that tell the user something they cannot otherwise see.
            when (message.delivery) {
                Delivery.Sending -> BubbleNote(R.string.chat_sending, HelmColors.Faint)
                Delivery.Failed -> BubbleNote(R.string.chat_failed, HelmColors.Danger)
                Delivery.Sent, null -> Unit
            }
        }
    }
}

@Composable
private fun BubbleNote(textRes: Int, color: Color) {
    Text(
        text = stringResource(textRes),
        color = color,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.padding(top = HelmSpacing.Xs, start = HelmSpacing.Sm, end = HelmSpacing.Sm),
    )
}

@Composable
private fun Composer(
    draft: String,
    onDraft: (String) -> Unit,
    onVoice: () -> Unit,
    onSend: () -> Unit,
) {
    Hairline()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .navigationBarsPadding()
            .padding(HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .clip(RoundedCornerShape(HelmRadius.Md))
                .background(HelmColors.Surface2)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
                .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
        ) {
            if (draft.isEmpty()) {
                Text(
                    text = stringResource(R.string.chat_placeholder),
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            BasicTextField(
                value = draft,
                onValueChange = onDraft,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = HelmColors.Txt),
                cursorBrush = SolidColor(HelmColors.Accent),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // The mic is permanent and first-class, not an option inside a keyboard:
        // away from the desk it is the primary way a reply gets written.
        Box(
            modifier = Modifier
                .size(HelmSize.MicButton)
                .clip(CircleShape)
                .background(HelmColors.Accent)
                .clickable(onClick = onVoice),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.voice_mic_glyph),
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Text(
            text = stringResource(R.string.chat_send),
            color = if (draft.isBlank()) HelmColors.Faint else HelmColors.Accent,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier
                .clip(RoundedCornerShape(HelmRadius.Pill))
                .clickable(enabled = draft.isNotBlank(), onClick = onSend)
                .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
        )
    }
}

/** A bubble never spans the full width: the gutter is what says who is talking. */
private val BUBBLE_MAX_WIDTH = 280.dp
