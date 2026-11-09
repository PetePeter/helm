package com.potatomotato.helm.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ChatAttachment
import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.data.Delivery
import com.potatomotato.helm.data.replyStats
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.LinkedText
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * Sits above the thread while rows are selected: how many, and what can be
 * done to them. Copy lives here rather than on a per-bubble text selection
 * because long-press now means "select this message"; a selection of one
 * copies exactly what the old gesture did.
 */
@Composable
internal fun SelectionBar(
    count: Int,
    onCopy: () -> Unit,
    onRange: () -> Unit,
    onDelete: () -> Unit,
    onCancel: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        Text(
            text = stringResource(R.string.chat_selected, count),
            color = HelmColors.Txt,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.weight(1f),
        )
        BubbleAction(R.string.chat_copy_glyph, R.string.chat_copy, HelmColors.Dim, onCopy)
        BubbleAction(R.string.chat_range_glyph, R.string.chat_range, HelmColors.Dim, onRange)
        BubbleAction(R.string.chat_delete_glyph, R.string.chat_delete_selected, HelmColors.Danger, onDelete)
        BubbleAction(R.string.chat_cancel_glyph, R.string.chat_cancel_selection, HelmColors.Dim, onCancel)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun Bubble(
    message: ChatMessage,
    comfyUi: Boolean,
    selected: Boolean,
    /** Non-null while selecting: a tap toggles this row. */
    onTap: (() -> Unit)?,
    onLongPress: () -> Unit,
    onRetry: (key: String, text: String) -> Unit,
    onUnfreeze: (retry: Pair<String, String>?) -> Unit,
    onDelete: (keys: Set<String>) -> Unit,
    pulls: Map<String, PullState>,
    onPull: (key: String, attachment: ChatAttachment) -> Unit,
    onCancelPull: (key: String) -> Unit,
    onDeleteAttachment: (key: String, attachment: ChatAttachment) -> Unit,
    onOpenAttachment: (uri: String, mimeType: String) -> Unit,
) {
    val fromPhone = message.fromPhone

    // The mockup's asymmetric tail: the corner nearest the speaker is pulled in
    // (5dp vs the 16dp rest), which is what says who the bubble grew out of.
    val shape = RoundedCornerShape(
        topStart = HelmRadius.Lg,
        topEnd = HelmRadius.Lg,
        bottomStart = if (fromPhone) HelmRadius.Lg else BUBBLE_TAIL,
        bottomEnd = if (fromPhone) BUBBLE_TAIL else HelmRadius.Lg,
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .then(if (selected) Modifier.background(HelmColors.Accent.copy(alpha = SELECTED_TINT)) else Modifier)
            .combinedClickable(
                onClick = { onTap?.invoke() },
                onLongClick = onLongPress,
            ),
        horizontalArrangement = if (fromPhone) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            horizontalAlignment = if (fromPhone) Alignment.End else Alignment.Start,
            // Three quarters of the thread's width, not a fixed dp: the bubble
            // should read the same on a small phone and a tablet, and the
            // quarter left over is what keeps the other speaker's side visible.
            // The column is the ceiling; the bubble inside it still hugs its own
            // text and sits on its speaker's edge.
            modifier = Modifier.fillMaxWidth(BUBBLE_WIDTH_FRACTION),
        ) {
            Box(
                modifier = Modifier
                    .clip(shape)
                    .background(if (fromPhone) HelmColors.Accent else HelmColors.Surface2)
                    .then(
                        // Only the AI bubble carries a hairline — the accent fill
                        // is its own edge against true black.
                        if (fromPhone) Modifier else Modifier.border(HelmSize.Hairline, HelmColors.Line, shape),
                    )
                    .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
            ) {
                Column {
                    // Long-press selects the MESSAGE (copy and delete live on the
                    // selection bar), so the text is no longer a text selection of
                    // its own: the two gestures would fight over one press.
                    run {
                        // Linked, not markdown: a chat message is prose, and the
                        // one thing in it worth a tap is a URL. LinkedText keeps
                        // every other marker literal.
                        LinkedText(
                            text = message.text.ifEmpty { stringResource(R.string.chat_attachment) },
                            color = if (fromPhone) HelmColors.OnAccent else HelmColors.Txt,
                            // Accent on the accent bubble is invisible; the underline carries it.
                            linkColor = if (fromPhone) HelmColors.OnAccent else HelmColors.Accent,
                            style = MaterialTheme.typography.bodyMedium.copy(
                                // The mockup sets the me-bubble one weight heavier:
                                // OnAccent on Accent needs it to hold up.
                                fontWeight = if (fromPhone) FontWeight.Medium else null,
                            ),
                        )
                    }
                    message.comfyInputImagePath?.let { path ->
                        Text(
                            text = "🖼 ${inputImageName(path)}",
                            color = if (fromPhone) HelmColors.OnAccent.copy(alpha = 0.72f) else HelmColors.Dim,
                            style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.padding(top = HelmSpacing.Xs),
                        )
                    }
                    message.attachment?.takeUnless { comfyUi && it.mimeType.startsWith("image/") }?.let { attachment ->
                        AttachmentTile(
                            attachment = attachment,
                            state = pulls[message.key] ?: PullState.Idle,
                            onPull = { onPull(message.key, attachment) },
                            onCancel = { onCancelPull(message.key) },
                            onDelete = { onDeleteAttachment(message.key, attachment) },
                            onOpen = onOpenAttachment,
                        )
                    }
                    // Replies carry how full the session's context is; API tools add tool calls.
                    replyStats(message.contextTokens, message.toolCalls, message.contextWindow, message.thoughtCount)?.let { stats ->
                        Text(
                            text = stats,
                            color = if (fromPhone) HelmColors.OnAccent.copy(alpha = 0.55f) else HelmColors.Faint,
                            style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.padding(top = HelmSpacing.Xs),
                        )
                    }
                    Text(
                        text = formatBubbleTime(message.at),
                        color = if (fromPhone) HelmColors.OnAccent.copy(alpha = 0.55f) else HelmColors.Faint,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(top = HelmSpacing.Xs),
                    )
                }
            }

            // Only outgoing messages carry a delivery state. Sending/Failed tell
            // the user something they cannot otherwise see; Sent is the honest
            // ceiling — the wire has no read receipt, so "✓ Sent" means the
            // session_send_text call was accepted and the text reached the
            // session. A true read ack would land as a new Delivery state here
            // once Helm reports one, not as a guess at one.
            when (message.delivery) {
                Delivery.Sending -> BubbleNote(R.string.chat_sending, HelmColors.Faint)
                Delivery.Sent -> BubbleNote(R.string.chat_sent, HelmColors.Dim)
                Delivery.Frozen -> {
                    BubbleNote(R.string.chat_frozen, HelmColors.Frozen)
                    Row(
                        modifier = Modifier.padding(top = HelmSpacing.Xs),
                        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
                    ) {
                        BubbleAction(R.string.chat_unfreeze_glyph, R.string.chat_unfreeze_send, HelmColors.Frozen) {
                            onUnfreeze(message.key to message.text)
                        }
                        BubbleAction(R.string.chat_delete_glyph, R.string.chat_delete, HelmColors.Dim) {
                            onDelete(setOf(message.key))
                        }
                    }
                }
                Delivery.Failed -> {
                    BubbleNote(R.string.chat_failed, HelmColors.Danger)
                    // A dead attempt gets one row of honest exits: send the same
                    // text again, or take the row away. Delivered messages get no
                    // delete — the desktop already holds a copy no tap here can
                    // reach, so removing the bubble would only be a lie.
                    Row(
                        modifier = Modifier.padding(top = HelmSpacing.Xs),
                        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
                    ) {
                        BubbleAction(R.string.chat_retry_glyph, R.string.chat_retry, HelmColors.Danger) {
                            onRetry(message.key, message.text)
                        }
                        BubbleAction(R.string.chat_delete_glyph, R.string.chat_delete, HelmColors.Dim) {
                            onDelete(setOf(message.key))
                        }
                    }
                }
                null -> Unit
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

/** One under-bubble action: glyph, wording, tap. The glyph leads; the whole row is the target. */
@Composable
internal fun BubbleAction(glyphRes: Int, labelRes: Int, color: Color, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(HelmRadius.Md))
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        Text(
            text = stringResource(glyphRes),
            color = color,
            style = MaterialTheme.typography.labelMedium,
        )
        Text(
            text = stringResource(labelRes),
            color = color,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

/** A bubble never spans the full width: the gutter is what says who is talking. */
private const val BUBBLE_WIDTH_FRACTION = 0.75f

/** Accent wash behind a selected row: visible on true black, text still readable. */
private const val SELECTED_TINT = 0.16f

/** The pulled-in tail corner. See Bubble. */
private val BUBBLE_TAIL = 5.dp

/** Immutable, so one instance serves every bubble. Compose is single-threaded anyway. */
private val bubbleTime = java.time.format.DateTimeFormatter.ofPattern("HH:mm")

/** The mockup shows "09:38" — local wall-clock, the only clock the reader has. */
private fun formatBubbleTime(at: Long): String =
    bubbleTime.format(java.time.Instant.ofEpochMilli(at).atZone(java.time.ZoneId.systemDefault()))
