package com.potatomotato.helm.ui.chat

import com.potatomotato.helm.data.ComfyUiProfile
import com.potatomotato.helm.data.ComfyUiImageSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ChatAttachment
import com.potatomotato.helm.data.artifactAttachmentKey
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.ui.components.ConfirmDelete
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSpacing

@Composable
internal fun ComfyProfilePicker(
    profiles: List<ComfyUiProfile>,
    selectedId: String,
    onSelect: (String) -> Unit,
    imageSizes: List<ComfyUiImageSize>,
    selectedImageSizeId: String,
    onSelectImageSize: (String) -> Unit,
    showImageSize: Boolean,
    onCancel: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var sizeExpanded by remember { mutableStateOf(false) }
    val selected = profiles.firstOrNull { it.id == selectedId } ?: profiles.first()
    val selectedSize = imageSizes.firstOrNull { it.id == selectedImageSizeId } ?: imageSizes.firstOrNull()
    Column(
        modifier = Modifier.fillMaxWidth().background(HelmColors.Surface).padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (selected.kind == "video") "Workflow" else "Model", color = HelmColors.Dim, style = MaterialTheme.typography.labelMedium)
            Box {
                Text(
                    text = "${selected.name} ▾",
                    color = HelmColors.Accent,
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.clickable { expanded = true }.padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Xs),
                )
                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    profiles.forEach { profile ->
                        DropdownMenuItem(
                            text = { Text(profile.name) },
                            onClick = { onSelect(profile.id); expanded = false },
                        )
                    }
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                text = "Cancel generation",
                color = HelmColors.Danger,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.clickable(onClick = onCancel).padding(HelmSpacing.Xs),
            )
        }
        if (showImageSize && selectedSize != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Size", color = HelmColors.Dim, style = MaterialTheme.typography.labelMedium)
                Box {
                    Text(
                        text = "${selectedSize.name} ▾",
                        color = HelmColors.Accent,
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.clickable { sizeExpanded = true }.padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Xs),
                    )
                    DropdownMenu(expanded = sizeExpanded, onDismissRequest = { sizeExpanded = false }) {
                        imageSizes.forEach { size ->
                            DropdownMenuItem(
                                text = { Text("${size.name} (${size.width}×${size.height})") },
                                onClick = { onSelectImageSize(size.id); sizeExpanded = false },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun ComfyGalleryStrip(
    items: List<ChatAttachment>,
    includedIds: Set<String>,
    maxReferences: Int,
    pulls: Map<String, PullState>,
    onToggle: (ChatAttachment, Boolean) -> Unit,
    onDownload: (ChatAttachment) -> Unit,
    onPreview: (ChatAttachment) -> Unit,
    onSavePreview: (ChatAttachment, String) -> Unit,
    onDelete: (ChatAttachment) -> Unit,
    onOpen: (uri: String, mimeType: String) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().background(HelmColors.Surface).padding(vertical = HelmSpacing.Xs),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Gutter),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.comfy_gallery_title), color = HelmColors.Txt, style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.weight(1f))
            Text(
                stringResource(R.string.comfy_gallery_ref_count, includedIds.size, maxReferences),
                color = HelmColors.Dim,
                style = MaterialTheme.typography.labelMedium,
            )
        }
        LazyRow(
            contentPadding = PaddingValues(horizontal = HelmSpacing.Gutter),
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            items(items, key = { it.attachmentId }) { attachment ->
                val included = attachment.attachmentId in includedIds
                val key = artifactAttachmentKey(attachment.artifactId, attachment.attachmentId)
                val state = pulls[key] ?: PullState.Idle
                ComfyGalleryTile(
                    attachment = attachment,
                    included = included,
                    state = state,
                    onToggle = { onToggle(attachment, it) },
                    onDownload = { onDownload(attachment) },
                    onPreview = { onPreview(attachment) },
                    onSavePreview = { uri -> onSavePreview(attachment, uri) },
                    onDelete = { onDelete(attachment) },
                    onOpen = onOpen,
                )
            }
        }
    }
}

@Composable
private fun ComfyGalleryTile(
    attachment: ChatAttachment,
    included: Boolean,
    state: PullState,
    onToggle: (Boolean) -> Unit,
    onDownload: () -> Unit,
    onPreview: () -> Unit,
    onSavePreview: (String) -> Unit,
    onDelete: () -> Unit,
    onOpen: (uri: String, mimeType: String) -> Unit,
) {
    var previewOpen by remember(attachment.artifactId, attachment.attachmentId) { mutableStateOf(false) }
    var deleteConfirmationOpen by remember(attachment.artifactId, attachment.attachmentId) { mutableStateOf(false) }
    val saveAction = comfyGallerySaveAction(state)
    LaunchedEffect(attachment.artifactId, attachment.attachmentId, state) {
        if (state is PullState.Idle && attachment.mimeType.startsWith("image/")) onPreview()
    }
    Column(
        modifier = Modifier.width(116.dp).clip(RoundedCornerShape(HelmRadius.Md))
            .background(HelmColors.Bg).padding(HelmSpacing.Xs),
    ) {
        Box(
            modifier = Modifier.fillMaxWidth().heightIn(min = 76.dp, max = 76.dp)
                .clip(RoundedCornerShape(HelmRadius.Sm))
                .background(HelmColors.Surface2)
                .clickable {
                    previewOpen = true
                    if (state !is PullState.Ready && attachment.mimeType.startsWith("image/")) onPreview()
                },
            contentAlignment = Alignment.Center,
        ) {
            if (state is PullState.Ready && attachment.mimeType.startsWith("image/")) {
                AttachmentPreview(state.uri, attachment.filename)
            } else {
                Text(
                    stringResource(if (state is PullState.Pulling) R.string.comfy_gallery_loading else R.string.comfy_gallery_tap_view),
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        Checkbox(checked = included, onCheckedChange = onToggle)
        Text(
            attachment.filename,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (val action = saveAction) {
                ComfyGallerySaveAction.Busy -> ComfyGalleryActionText(
                    text = stringResource(R.string.comfy_gallery_saving_short),
                    color = HelmColors.Dim,
                )
                ComfyGallerySaveAction.Download -> ComfyGalleryActionText(
                    text = stringResource(R.string.comfy_gallery_save_short),
                    color = HelmColors.Accent,
                    onClick = onDownload,
                )
                is ComfyGallerySaveAction.SavePreview -> ComfyGalleryActionText(
                    text = stringResource(R.string.comfy_gallery_save_short),
                    color = HelmColors.Accent,
                    onClick = { onSavePreview(action.uri) },
                )
                is ComfyGallerySaveAction.Open -> ComfyGalleryActionText(
                    text = stringResource(R.string.chat_attachment_open),
                    color = HelmColors.Accent,
                    onClick = { onOpen(action.uri, attachment.mimeType) },
                )
            }
            ComfyGalleryActionText(
                text = stringResource(R.string.artifacts_action_delete),
                color = HelmColors.Danger,
                onClick = { deleteConfirmationOpen = true },
            )
        }
    }

    if (previewOpen && !deleteConfirmationOpen) {
        Dialog(
            onDismissRequest = { previewOpen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Column(
                modifier = Modifier.fillMaxSize().background(HelmColors.Bg).padding(HelmSpacing.Md),
                verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(attachment.filename, color = HelmColors.Txt, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 1)
                    Text(stringResource(R.string.comfy_gallery_close), color = HelmColors.Accent, modifier = Modifier.clickable { previewOpen = false }.padding(HelmSpacing.Sm))
                }
                Box(modifier = Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (state is PullState.Ready && attachment.mimeType.startsWith("image/")) {
                        AttachmentPreview(state.uri, attachment.filename, maxPx = 2400, fullScreen = true)
                    } else {
                        Text(
                            when (state) {
                                is PullState.Pulling -> stringResource(R.string.comfy_gallery_saving, formatBytes(state.received), formatBytes(state.total))
                                is PullState.Failed -> state.message
                            PullState.Idle -> stringResource(R.string.comfy_gallery_save_to_preview)
                                is PullState.Ready -> stringResource(R.string.comfy_gallery_preview_unavailable)
                            },
                            color = HelmColors.Dim,
                        )
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md), verticalAlignment = Alignment.CenterVertically) {
                    when (val action = saveAction) {
                        is ComfyGallerySaveAction.SavePreview -> {
                            Text(action.location, color = HelmColors.Dim, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f), maxLines = 1)
                            Text(stringResource(R.string.comfy_gallery_save), color = HelmColors.Accent, modifier = Modifier.clickable { onSavePreview(action.uri) }.padding(HelmSpacing.Sm))
                        }
                        is ComfyGallerySaveAction.Open -> {
                            Text(action.location, color = HelmColors.Dim, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f), maxLines = 1)
                            Text(stringResource(R.string.chat_attachment_open), color = HelmColors.Accent, modifier = Modifier.clickable { onOpen(action.uri, attachment.mimeType) }.padding(HelmSpacing.Sm))
                        }
                        ComfyGallerySaveAction.Busy -> Text(stringResource(R.string.comfy_gallery_saving_short), color = HelmColors.Dim)
                        ComfyGallerySaveAction.Download -> Text(stringResource(R.string.comfy_gallery_save), color = HelmColors.Accent, modifier = Modifier.clickable(onClick = onDownload).padding(HelmSpacing.Sm))
                    }
                    Text(
                        stringResource(R.string.artifacts_action_delete),
                        color = HelmColors.Danger,
                        modifier = Modifier.clickable { deleteConfirmationOpen = true }.padding(HelmSpacing.Sm),
                    )
                }
            }
        }
    }

    if (deleteConfirmationOpen) {
        Dialog(
            onDismissRequest = { deleteConfirmationOpen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            ConfirmDelete(
                message = stringResource(R.string.artifacts_attachment_confirm_delete, attachment.filename),
                onConfirm = {
                    deleteConfirmationOpen = false
                    previewOpen = false
                    onDelete()
                },
                onCancel = { deleteConfirmationOpen = false },
            )
        }
    }
}

@Composable
private fun ComfyGalleryActionText(
    text: String,
    color: Color,
    onClick: (() -> Unit)? = null,
) {
    val clickModifier = onClick?.let { Modifier.clickable(onClick = it) } ?: Modifier
    Box(
        modifier = Modifier.heightIn(min = 40.dp).then(clickModifier).padding(horizontal = HelmSpacing.Xs),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = color, style = MaterialTheme.typography.labelSmall, maxLines = 1)
    }
}

internal fun inputImageName(path: String): String = path.substringAfterLast('/').substringAfterLast('\\')
