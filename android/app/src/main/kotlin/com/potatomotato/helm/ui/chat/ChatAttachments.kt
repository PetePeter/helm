package com.potatomotato.helm.ui.chat

import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ChatAttachment
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The file a message is carrying, and the one tap that fetches it.
 *
 * TAP TO PULL, never automatic. The bytes cross the same BLE or LAN link the
 * conversation uses, and a thread full of photos fetching themselves would hold
 * that link for minutes at a time on a radio that manages a few KB a second.
 * The name and size are on the wire, so the user decides with the facts in front
 * of them rather than after the fact.
 *
 * Every state offers a way onward: a stumble retries (resuming, not restarting),
 * a fetch in flight can be abandoned, and a file that is no longer wanted is
 * deleted on the DESKTOP — the tile going away on its own would leave the file
 * sitting in the session's artifacts where the user cannot see it.
 */
@Composable
internal fun AttachmentTile(
    attachment: ChatAttachment,
    state: PullState,
    onPull: () -> Unit,
    onCancel: () -> Unit,
    onDelete: () -> Unit,
    onOpen: (uri: String, mimeType: String) -> Unit,
) {
    Column(
        modifier = Modifier
            .padding(top = HelmSpacing.Sm)
            .clip(RoundedCornerShape(HelmRadius.Md))
            .background(HelmColors.Surface)
            .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
            .padding(HelmSpacing.Sm),
    ) {
        // An image that has landed shows itself. A file the user asked for and
        // then has to go hunting for in Downloads is only half delivered.
        if (state is PullState.Ready && attachment.mimeType.startsWith("image/")) {
            AttachmentPreview(state.uri, attachment.filename)
        } else if (state is PullState.Ready && attachment.mimeType.startsWith("video/")) {
            AttachmentVideoPreview(state.uri)
        }
        Text(
            text = attachment.filename,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
        )
        Text(
            text = when (state) {
                is PullState.Idle -> formatBytes(attachment.sizeBytes)
                is PullState.Pulling -> stringResource(
                    R.string.chat_attachment_pulling,
                    formatBytes(state.received),
                    formatBytes(state.total),
                )
                is PullState.Ready -> state.location
                is PullState.Failed -> state.message
            },
            color = if (state is PullState.Failed) HelmColors.Danger else HelmColors.Dim,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(top = HelmSpacing.Xs),
        )
        Row(
            modifier = Modifier.padding(top = HelmSpacing.Xs),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            when (state) {
                is PullState.Idle ->
                    BubbleAction(R.string.chat_attachment_glyph, R.string.chat_attachment_get, HelmColors.Accent, onPull)
                is PullState.Pulling ->
                    BubbleAction(R.string.chat_delete_glyph, R.string.chat_attachment_cancel, HelmColors.Dim, onCancel)
                is PullState.Ready ->
                    BubbleAction(R.string.chat_attachment_open_glyph, R.string.chat_attachment_open, HelmColors.Accent) {
                        onOpen(state.uri, attachment.mimeType)
                    }
                is PullState.Failed ->
                    BubbleAction(R.string.chat_retry_glyph, R.string.chat_attachment_get, HelmColors.Danger, onPull)
            }
            if (state !is PullState.Pulling) {
                BubbleAction(R.string.chat_delete_glyph, R.string.chat_attachment_delete, HelmColors.Dim, onDelete)
            }
        }
    }
}

@Composable
private fun AttachmentVideoPreview(uri: String) {
    val context = LocalContext.current
    val videoView = remember(uri) { VideoView(context) }
    DisposableEffect(videoView) {
        onDispose { videoView.stopPlayback() }
    }
    AndroidView(
        factory = {
            videoView.apply {
                setMediaController(MediaController(context).also { it.setAnchorView(this) })
                setVideoURI(Uri.parse(uri))
            }
        },
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 180.dp, max = 300.dp)
            .clip(RoundedCornerShape(HelmRadius.Sm)),
    )
}

/**
 * The image itself, once it is on the phone.
 *
 * Decoded OFF the main thread and downsampled to a thumbnail: a 12MP photo
 * decoded whole is ~48MB of bitmap, which is how a chat thread runs a phone out
 * of memory. A decode that fails draws nothing — the tile beneath still names
 * the file and still opens it, so a preview is a bonus, never the only route.
 */
@Composable
internal fun AttachmentPreview(
    uri: String,
    filename: String,
    maxPx: Int = PREVIEW_MAX_PX,
    fullScreen: Boolean = false,
) {
    val context = LocalContext.current
    var preview by remember(uri) { mutableStateOf<ImageBitmap?>(null) }
    var loading by remember(uri) { mutableStateOf(true) }

    LaunchedEffect(uri) {
        val decoded = withContext(Dispatchers.IO) {
            try {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                context.contentResolver.openInputStream(Uri.parse(uri))
                    ?.use { BitmapFactory.decodeStream(it, null, bounds) }
                val options = BitmapFactory.Options().apply {
                    inSampleSize = sampleSizeFor(bounds.outWidth, maxPx)
                }
                context.contentResolver.openInputStream(Uri.parse(uri))
                    ?.use { BitmapFactory.decodeStream(it, null, options) }
                    ?.asImageBitmap()
            } catch (error: Exception) {
                HelmLog.w(HelmLog.CLIENT, "a pulled image could not be decoded for preview")
                null
            }
        }
        preview = decoded
        loading = false
    }

    val bitmap = preview
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = filename,
            contentScale = if (fullScreen) ContentScale.Fit else ContentScale.FillWidth,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Sm))
                .padding(bottom = HelmSpacing.Xs),
        )
    } else {
        Text(
            stringResource(if (loading) R.string.comfy_gallery_loading else R.string.comfy_gallery_preview_unavailable),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

/** The smallest power-of-two shrink that gets the width under [target]. */
private fun sampleSizeFor(width: Int, target: Int): Int {
    var sample = 1
    while (width > 0 && width / sample > target) sample *= 2
    return sample
}

private const val PREVIEW_MAX_PX = 1080

/** Sizes as a person reads them. One decimal past KB — bytes are not news. */
internal fun formatBytes(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}
