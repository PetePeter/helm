package com.potatomotato.helm.ui.artifacts

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.AttachmentUploadState
import com.potatomotato.helm.data.ArtifactRules
import com.potatomotato.helm.data.ArtifactRules.Verdict
import com.potatomotato.helm.data.HelmArtifact
import com.potatomotato.helm.data.HelmArtifactAttachment
import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.data.UploadSupport
import com.potatomotato.helm.ui.components.ConfirmDelete
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.PrimaryButton
import com.potatomotato.helm.ui.components.RoundAccentButton
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/** Which write the editor is open for. */
sealed interface ArtifactEdit {

    /** Mint a new markdown artifact for the session on screen. */
    data class New(val sessionId: String) : ArtifactEdit

    /**
     * Append a version to an artifact. The body starts from what the detail
     * screen was SHOWING — the version the user read, so paging back to v2 of 3
     * and revising means editing from v2, which is the honest place to start.
     */
    data class Revision(val artifact: HelmArtifact, val shown: String) : ArtifactEdit
}

/**
 * The one writing surface in the artifacts slice: a title, a body, and — for a
 * create — the files riding along with it. Create is markdown-only because the
 * desktop's session-addressed create refuses every other kind (HTML authored
 * from a phone keyboard is a sanitization question nobody has answered —
 * invariant 9), so the form offers no kind choice at all; a revise inherits the
 * artifact's own kind, and an HTML body is edited as the source it is shown as.
 *
 * The body is a TALL FIXED box rather than a growing one, deliberate: with
 * attachments staged below it, a body that grows would shove the chips and the
 * attach toolbar under the keyboard, and the controls the user is reaching for
 * are the ones that must stay where the thumb left them.
 *
 * The rules come from [ArtifactRules], the same object the client enforces
 * before the radio, so the submit is dark for exactly the reasons the wire
 * would refuse: a blank title, a no-op revision, a body that would not fit the
 * link's frames.
 */
@Composable
fun ArtifactEditorScreen(
    edit: ArtifactEdit,
    linkState: LinkState,
    onSubmit: (title: String, content: String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    /** The staged files, in staged order. A create only. */
    staged: List<StagedAttachment> = emptyList(),
    /** Per-chip upload state, keyed by [StagedAttachment.key]. */
    uploadStates: Map<String, AttachmentUploadState> = emptyMap(),
    /** Why the attach toolbar is dark, when it is. Null hides the toolbar entirely. */
    attachSupport: UploadSupport? = null,
    onAttachCamera: () -> Unit = {},
    onAttachGallery: () -> Unit = {},
    onAttachFiles: () -> Unit = {},
    /** Open a staged file locally — the chip tap. */
    onOpenStaged: (StagedAttachment) -> Unit = {},
    /** Take a staged file back off the create. */
    onRemoveStaged: (key: String) -> Unit = {},
    /** Send a failed attachment again. */
    onRetryStaged: (key: String) -> Unit = {},
    /** Why an existing attachment's last delete/replace failed, keyed by attachment id. */
    attachmentErrors: Map<String, String> = emptyMap(),
    /** Delete an existing attachment — only ever called after the confirm dialog. */
    onDeleteExisting: (attachmentId: String) -> Unit = {},
    /** Pick a file to replace an existing attachment with. */
    onReplaceExisting: (attachmentId: String) -> Unit = {},
) {
    // Bound to a local before any lambda captures it: Compose slot lambdas run
    // again on recomposition, and a parameter smart cast does not survive being
    // captured by one.
    val revision = edit as? ArtifactEdit.Revision

    // The fields survive a rotation; the draft is the thing worth saving. The
    // edit is rebuilt by navigation, so the artifact here is display only —
    // the submit never reads it back.
    var title by rememberSaveable { mutableStateOf(revision?.artifact?.title ?: "") }
    var body by rememberSaveable { mutableStateOf(revision?.shown ?: "") }

    val verdict = when (edit) {        is ArtifactEdit.New -> ArtifactRules.judgeCreate(title, body)
        is ArtifactEdit.Revision -> ArtifactRules.judgeRevision(edit.shown, body)
    }
    val sendable = verdict == Verdict.Ok
    // Anything past Waiting is a create already in motion; Create must not fire
    // a second artifact into the one being assembled.
    val uploadsRunning = staged.any { it.key !in uploadStates || uploadStates[it.key] is AttachmentUploadState.Uploading }
    val isCreate = revision == null
    var confirmingDelete by remember { mutableStateOf<HelmArtifactAttachment?>(null) }

    Box(modifier = modifier.fillMaxSize()) {
    Column(modifier = Modifier.fillMaxSize().background(HelmColors.Bg)) {
        HelmAppBar(
            title = if (revision == null) {
                stringResource(R.string.artifacts_editor_new)
            } else {
                stringResource(R.string.artifacts_editor_revise, revision.artifact.title)
            },
            linkState = linkState,
            onBack = onBack,
        )

        // Fixed-height body: the outer column no longer scrolls, so the body
        // takes the space between the fields and the composer panel and scrolls
        // INTERNALLY once the text outgrows it.
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(HelmSpacing.Gutter),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        ) {
            if (revision == null) {
                FieldLabel(stringResource(R.string.artifacts_title_label))
                Field(
                    value = title,
                    onValue = { title = it },
                    singleLine = true,
                    label = stringResource(R.string.artifacts_title_label),
                    // The reason the confirm is dark rides on the field, the way
                    // the rename dialog announces an over-long name.
                    semanticsError = if (verdict == Verdict.TooLong) {
                        stringResource(R.string.artifacts_title_too_long)
                    } else {
                        null
                    },
                )
                when (verdict) {
                    Verdict.Blank -> Hint(stringResource(R.string.artifacts_title_blank))
                    Verdict.TooLong -> Hint(stringResource(R.string.artifacts_title_too_long))
                    else -> {}
                }
                FieldLabel(stringResource(R.string.artifacts_body_markdown))
            } else {
                // A revise carries no title on the wire; the artifact keeps its
                // name, and the editor says which one is being revised.
                Text(
                    text = stringResource(R.string.artifacts_editor_revising, revision.artifact.title),
                    color = HelmColors.Dim,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                FieldLabel(stringResource(R.string.artifacts_body_label))
            }
            val bodyLabel = stringResource(R.string.artifacts_body_label)
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(HelmRadius.Md))
                    .background(HelmColors.Surface2)
                    .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
                    .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
            ) {
                BasicTextField(
                    value = body,
                    onValueChange = { body = it },
                    singleLine = false,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(color = HelmColors.Txt),
                    cursorBrush = SolidColor(HelmColors.Accent),
                    modifier = Modifier
                        .fillMaxSize()
                        .semantics {
                            contentDescription = bodyLabel
                        },
                )
            }
            when (verdict) {
                Verdict.Unchanged -> Hint(stringResource(R.string.artifacts_body_unchanged))
                Verdict.TooLarge -> Hint(stringResource(R.string.artifacts_too_large))
                else -> {}
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(HelmColors.Surface)
                .padding(HelmSpacing.Gutter),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            // A revise edits what the artifact ALREADY carries. Read live from the
            // list cache (the revision's artifact is rebuilt from it), so a
            // delete that lands removes the row without a manual refresh.
            revision?.artifact?.attachments?.takeIf { it.isNotEmpty() }?.let { existing ->
                ExistingAttachments(
                    attachments = existing,
                    errors = attachmentErrors,
                    onDelete = { confirmingDelete = it },
                    onReplace = { onReplaceExisting(it.id) },
                )
            }
            // A replacement rides the staged chain, so its chip is the one place
            // its progress or failure can show — in a revise as much as a create.
            if (!isCreate && staged.isNotEmpty()) {
                StagedChips(
                    staged = staged,
                    uploadStates = uploadStates,
                    onOpen = onOpenStaged,
                    onRemove = onRemoveStaged,
                    onRetry = onRetryStaged,
                )
            }
            if (isCreate) {
                StagedChips(
                    staged = staged,
                    uploadStates = uploadStates,
                    onOpen = onOpenStaged,
                    onRemove = onRemoveStaged,
                    onRetry = onRetryStaged,
                )
                AttachToolbar(attachSupport, onAttachCamera, onAttachGallery, onAttachFiles)
            }
            PrimaryButton(
                text = stringResource(
                    if (revision == null) R.string.artifacts_submit_create else R.string.artifacts_submit_revise,
                ),
                enabled = sendable && !uploadsRunning,
                // The client enforces the same rules again before the radio; the
                // trim here is the one place the title is settled.
                onClick = { onSubmit(ArtifactRules.title(title), body) },
            )
            GhostButton(text = stringResource(R.string.control_rename_cancel), onClick = onBack)
        }
    }
    confirmingDelete?.let { target ->
        ConfirmDelete(
            message = stringResource(R.string.artifacts_attachment_confirm_delete, target.filename),
            onConfirm = {
                confirmingDelete = null
                onDeleteExisting(target.id)
            },
            onCancel = { confirmingDelete = null },
        )
    }
    }
}

/**
 * The files the artifact already carries, each with delete and replace. A row
 * whose last edit failed stays and says why: a refused delete is no evidence
 * the file left, and hiding it would lie about what the artifact holds.
 */
@Composable
private fun ExistingAttachments(
    attachments: List<HelmArtifactAttachment>,
    errors: Map<String, String>,
    onDelete: (HelmArtifactAttachment) -> Unit,
    onReplace: (HelmArtifactAttachment) -> Unit,
) {
    Text(
        text = stringResource(R.string.artifacts_attachments_header),
        color = HelmColors.Faint,
        style = MaterialTheme.typography.labelMedium,
    )
    for (attachment in attachments) {
        val replaceLabel = stringResource(R.string.artifacts_attachment_replace, attachment.filename)
        val deleteLabel = stringResource(R.string.artifacts_attachment_delete, attachment.filename)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Pill))
                .background(HelmColors.Surface2)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Pill))
                .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = attachment.filename,
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.labelLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                errors[attachment.id]?.let { reason ->
                    ChipLine(stringResource(R.string.artifacts_attachment_failed, reason), color = HelmColors.Danger)
                }
            }
            ChipGlyph(stringResource(R.string.artifacts_attachment_replace_glyph), replaceLabel) { onReplace(attachment) }
            ChipGlyph(stringResource(R.string.artifacts_attachment_delete_glyph), deleteLabel) { onDelete(attachment) }
        }
    }
}

/**
 * The staged files, one chip each, under the body and above the attach toolbar
 * — the order the user works in: pick, see it named, then send.
 */
@Composable
private fun StagedChips(
    staged: List<StagedAttachment>,
    uploadStates: Map<String, AttachmentUploadState>,
    onOpen: (StagedAttachment) -> Unit,
    onRemove: (String) -> Unit,
    onRetry: (String) -> Unit,
) {
    for (attachment in staged) {
        val state = uploadStates[attachment.key] ?: AttachmentUploadState.Waiting
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Pill))
                .background(HelmColors.Surface2)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Pill))
                .clickable { onOpen(attachment) }
                .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = attachment.filename,
                color = HelmColors.Txt,
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.width(HelmSpacing.Sm))
            ChipState(attachment, state, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.width(HelmSpacing.Xs))
            if (state is AttachmentUploadState.Failed) {
                ChipGlyph(stringResource(R.string.artifacts_attach_retry_glyph)) { onRetry(attachment.key) }
            }
            if (state is AttachmentUploadState.Waiting) {
                ChipGlyph(stringResource(R.string.artifacts_attach_remove_glyph)) { onRemove(attachment.key) }
            }
        }
    }
}

/** The one state line a chip carries: its size while it waits, progress in flight. */
@Composable
private fun ChipState(
    attachment: StagedAttachment,
    state: AttachmentUploadState,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is AttachmentUploadState.Waiting -> ChipLine(
            humanSize(attachment.sizeBytes),
            modifier,
        )
        // The one state with a BAR as well as a line. A percentage alone reads
        // as stuck on a link that takes minutes for a photo — the bar is what
        // says the transfer is alive between two readings of the same number.
        is AttachmentUploadState.Uploading -> Column(
            modifier = modifier,
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
        ) {
            val reading = "${percent(state.sent, state.totalBytes)}%"
            ChipLine(stringResource(R.string.artifacts_chip_uploading, reading))
            val spoken = stringResource(R.string.artifacts_chip_uploading_bar, attachment.filename, reading)
            LinearProgressIndicator(
                progress = { uploadFraction(state.sent, state.totalBytes) },
                modifier = Modifier
                    .width(HelmSize.ChipProgressWidth)
                    .height(HelmSize.ChipProgressHeight)
                    .clip(RoundedCornerShape(HelmRadius.Pill))
                    .semantics { contentDescription = spoken },
                color = HelmColors.Accent,
                trackColor = HelmColors.Line,
                // No gap and no stop dot: at this size they read as artefacts
                // rather than as the two marks Material means them to be.
                gapSize = 0.dp,
                drawStopIndicator = {},
            )
        }
        is AttachmentUploadState.Done -> ChipLine(
            stringResource(R.string.artifacts_chip_done),
            modifier,
            color = HelmColors.Dim,
        )
        is AttachmentUploadState.Failed -> ChipLine(
            stringResource(R.string.artifacts_chip_failed),
            modifier,
            color = HelmColors.Danger,
        )
    }
}

@Composable
private fun ChipLine(text: String, modifier: Modifier = Modifier, color: Color = HelmColors.Faint) {
    Text(
        text = text,
        color = color,
        style = MaterialTheme.typography.labelSmall,
        maxLines = 1,
        modifier = modifier,
    )
}

/** A glyph acting as a chip button, the way the version bar's controls do. */
@Composable
private fun ChipGlyph(glyph: String, spoken: String? = null, onClick: () -> Unit) {
    Text(
        text = glyph,
        color = HelmColors.Dim,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier
            .semantics { if (spoken != null) contentDescription = spoken }
            .clickable(onClick = onClick)
            .padding(HelmSpacing.Xs),
    )
}

/**
 * The attach toolbar: three circles — camera, gallery, files. Dark with a
 * REASON whenever this desktop cannot take attachments; a greyed control with
 * no reason reads as a broken app.
 */
@Composable
private fun AttachToolbar(
    support: UploadSupport?,
    onCamera: () -> Unit,
    onGallery: () -> Unit,
    onFiles: () -> Unit,
) {
    when (support) {
        null -> {}
        UploadSupport.Available -> Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm)) {
            RoundAccentButton(
                glyph = stringResource(R.string.artifacts_attach_camera_glyph),
                contentDescription = stringResource(R.string.artifacts_attach_camera),
                onClick = onCamera,
            )
            RoundAccentButton(
                glyph = stringResource(R.string.artifacts_attach_gallery_glyph),
                contentDescription = stringResource(R.string.artifacts_attach_gallery),
                onClick = onGallery,
            )
            RoundAccentButton(
                glyph = stringResource(R.string.artifacts_attach_files_glyph),
                contentDescription = stringResource(R.string.artifacts_attach_files),
                onClick = onFiles,
            )
        }
        UploadSupport.Offline -> Hint(stringResource(R.string.artifacts_attach_unsupported_offline))
        UploadSupport.DesktopTooOld -> Hint(stringResource(R.string.artifacts_attach_unsupported_old))
        UploadSupport.NotPermitted -> Hint(stringResource(R.string.artifacts_attach_unsupported_denied))
    }
}

/**
 * Bytes a human reads: KB under a megabyte, MB from there. One decimal at most.
 * Package-visible because the detail screen's attachment rows size the SAME
 * files this editor stages, and two spellings of a megabyte would read as a bug.
 */
internal fun humanSize(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> {
        val mb = bytes / (1024f * 1024f)
        if (mb >= 10f) "${mb.toInt()} MB" else "${(mb * 10).toInt() / 10f} MB"
    }
    bytes >= 1024 -> "${bytes / 1024} KB"
    else -> "$bytes B"
}

/**
 * How much of a file has gone, 0..1. The bar and the percentage read the SAME
 * number — two spellings of "how far" would disagree at the edges and look like
 * a bug in whichever one the user was watching.
 */
private fun uploadFraction(sent: Long, total: Long): Float =
    if (total > 0) sent.coerceIn(0, total).toFloat() / total else 0f

private fun percent(sent: Long, total: Long): Int = (uploadFraction(sent, total) * 100).toInt()

@Composable
private fun FieldLabel(text: String) {
    Text(
        text = text,
        color = HelmColors.Dim,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier.padding(top = HelmSpacing.Sm),
    )
}

@Composable
private fun Hint(text: String) {
    Text(text = text, color = HelmColors.Faint, style = MaterialTheme.typography.bodySmall)
}

/** The inset field, drawn the spawn form's way: Surface2 fill, hairline edge. */
@Composable
private fun Field(
    value: String,
    onValue: (String) -> Unit,
    singleLine: Boolean,
    label: String,
    semanticsError: String?,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(HelmRadius.Md))
            .background(HelmColors.Surface2)
            .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValue,
            singleLine = singleLine,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = HelmColors.Txt),
            cursorBrush = SolidColor(HelmColors.Accent),
            modifier = Modifier
                .fillMaxWidth()
                .semantics {
                    contentDescription = label
                    if (semanticsError != null) error(semanticsError)
                },
        )
    }
}
