package com.potatomotato.helm.ui.artifacts

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.data.ARTIFACT_KIND_LABELS
import com.potatomotato.helm.data.ArtifactListPrefs
import com.potatomotato.helm.data.ArtifactListRules
import com.potatomotato.helm.data.ArtifactSort
import com.potatomotato.helm.data.PrefsArtifactListStore
import com.potatomotato.helm.data.TriState
import com.potatomotato.helm.ui.sessions.SessionRowText
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.ArtifactList
import com.potatomotato.helm.data.ArtifactIntent
import com.potatomotato.helm.data.ArtifactRead
import com.potatomotato.helm.data.ArtifactSave
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmArtifact
import com.potatomotato.helm.data.HelmArtifactAttachment
import com.potatomotato.helm.data.HelmArtifactRead
import com.potatomotato.helm.data.PullState
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.artifactAttachmentKey
import com.potatomotato.helm.data.answered
import com.potatomotato.helm.data.permits
import com.potatomotato.helm.ui.components.ConfirmDelete
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.HelmRow
import com.potatomotato.helm.ui.components.MarkdownBlock
import com.potatomotato.helm.ui.components.SCRIM_ALPHA
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmType
import com.potatomotato.helm.ui.control.glyphRes
import com.potatomotato.helm.ui.control.labelColor
import com.potatomotato.helm.ui.control.labelRes

/**
 * Mockup screen 8 — a session's artifacts: the list, one artifact read, and now
 * the write affordances the session-addressed tools bought.
 *
 * THE WRITES ARE GATED FROM THE GATE, row by row, exactly the way the control
 * sheet greys: `__mobile_tools__` is the only source of what this phone may do,
 * and "not permitted" is allowed to appear only because the claim is true. The
 * rows live on the screens where the thing acted on is visible — a New row under
 * the list, Revise/Save/Delete under the open artifact — because an artifacts
 * section inside the sheet would name nothing.
 *
 * RENDERING IS CONTAINED. Markdown gets the [MarkdownRules] subset, mermaid
 * fences render as diagrams, and HTML renders in a WebView that the document
 * cannot escape: the CSP rides inside it ([HtmlContainment.injectCsp]), the
 * load is opaque-origin, the network is off, and nothing the page asks for —
 * links, forms, frames — survives [ContainedWebView]'s client. Artifact
 * content is AI-authored, which invariant 9 makes untrusted, and containment
 * is what makes rendering it honest; the source view stays one tap away
 * because a phone-width render is still not the desktop's page. Each rendered
 * piece is its own WebView ([ContainedWebView] carries the cost note), so a
 * document of many fences carries the mermaid bundle once per fence — fine at
 * one-or-two diagrams, and worth knowing before adding a third renderer.
 */
@Composable
fun ArtifactsScreen(
    state: ArtifactList,
    read: ArtifactRead,
    selectedId: String?,
    capabilities: Capabilities,
    onPreview: (HelmArtifact) -> Unit,
    onExpand: (HelmArtifact) -> Unit,
    onPull: (version: Int?) -> Unit,
    onNew: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // No app bar here: this is the session's Artifacts TAB, and the session's
    // chrome is owned by the scaffold that hosts the tabs. The DETAIL screen
    // below still carries its own — it hangs off the tab, it is not one.
    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when (state) {
                is ArtifactList.Ready ->
                    ListBody(state.artifacts, read, selectedId, capabilities, onPreview, onExpand, onPull, onNew)

                // A re-visit keeps the last answer on screen while the fresh one
                // crosses the link: the rows the user is looking at are the
                // best-known truth, and a blank screen is the worst one.
                is ArtifactList.Refreshing ->
                    ListBody(state.cached, read, selectedId, capabilities, onPreview, onExpand, onPull, onNew)

                is ArtifactList.Loading -> Placeholder(stringResource(R.string.artifacts_loading))
                is ArtifactList.Failed -> Placeholder(state.message, HelmColors.Danger)
                ArtifactList.Idle -> Placeholder(stringResource(R.string.artifacts_loading))
            }
        }
    }
}

/**
 * The desktop's Artifacts layout, on phone and tablet alike: filter chips, a
 * sort switch, a horizontal card strip, and the selected card's body below it.
 * Tapping a card swaps the body in place; ⤢ opens the full detail screen
 * (revise, save, delete, attachments). Filter and sort are per device.
 */
@Composable
private fun ListBody(
    artifacts: List<HelmArtifact>,
    read: ArtifactRead,
    selectedId: String?,
    capabilities: Capabilities,
    onPreview: (HelmArtifact) -> Unit,
    onExpand: (HelmArtifact) -> Unit,
    onPull: (version: Int?) -> Unit,
    onNew: () -> Unit,
) {
    if (artifacts.isEmpty() && !capabilities.permits(SessionAction.CreateArtifact)) {
        Placeholder(stringResource(R.string.artifacts_empty))
        return
    }
    val context = LocalContext.current
    val store = remember { PrefsArtifactListStore(context) }
    var prefs by remember { mutableStateOf(store.load()) }
    val update: (ArtifactListPrefs) -> Unit = { prefs = it; store.save(it) }
    val shown = remember(artifacts, prefs) { ArtifactListRules.list(artifacts, prefs) }
    val selected = shown.firstOrNull { it.id == selectedId } ?: shown.firstOrNull()

    // The strip always has a body under it: the first card until the user
    // picks. Arriving re-reads it too — the repository shows its cached body
    // while the fresh one crosses the link.
    LaunchedEffect(selected?.id) {
        if (selected != null) onPreview(selected)
    }

    Column(modifier = Modifier.fillMaxSize()) {
        FilterBar(prefs, update)
        CardStrip(shown, selected?.id, capabilities, onPreview, onNew)
        Hairline()
        if (selected == null) {
            Placeholder(
                stringResource(if (artifacts.isEmpty()) R.string.artifacts_empty else R.string.artifacts_none_match),
            )
        } else {
            InlineViewer(selected, read, onExpand, onPull)
        }
    }
}

@Composable
private fun FilterBar(prefs: ArtifactListPrefs, onChange: (ArtifactListPrefs) -> Unit) {
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items(ARTIFACT_KIND_LABELS) { kind ->
            val state = prefs.kinds[kind] ?: TriState.Either
            TriChip(kind, state) { onChange(prefs.withKind(kind, state.next())) }
        }
        items(ArtifactIntent.entries) { intent ->
            val state = prefs.intents[intent.wireValue] ?: TriState.Either
            TriChip(intentLabel(intent), state) { onChange(prefs.withIntent(intent.wireValue, state.next())) }
        }
        item { Spacer(Modifier.width(HelmSpacing.Md)) }
        items(ArtifactSort.entries) { sort ->
            OutlineChip(sortLabel(sort), on = prefs.sort == sort) { onChange(prefs.copy(sort = sort)) }
        }
    }
}

/** Tri-state like the desktop chip: either (plain) → yes (accent) → no (struck, danger). */
@Composable
private fun TriChip(text: String, state: TriState, onClick: () -> Unit) {
    OutlineChip(text, on = state == TriState.Yes, excluded = state == TriState.No, onClick = onClick)
}

@Composable
private fun OutlineChip(text: String, on: Boolean, excluded: Boolean = false, onClick: () -> Unit) {
    // A chosen chip outlines in accent rather than filling, like the snapshot
    // line counts: an outline reads as a setting, a fill as a button.
    val tint = when {
        excluded -> HelmColors.Danger
        on -> HelmColors.Accent
        else -> HelmColors.Dim
    }
    Text(
        text = text,
        color = tint,
        style = MaterialTheme.typography.labelLarge,
        textDecoration = if (excluded) TextDecoration.LineThrough else null,
        modifier = Modifier
            .clip(RoundedCornerShape(HelmRadius.Pill))
            .border(
                HelmSize.Hairline,
                if (on || excluded) tint else HelmColors.Line,
                RoundedCornerShape(HelmRadius.Pill),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
    )
}

@Composable
private fun CardStrip(
    artifacts: List<HelmArtifact>,
    selectedId: String?,
    capabilities: Capabilities,
    onPick: (HelmArtifact) -> Unit,
    onNew: () -> Unit,
) {
    val now = System.currentTimeMillis()
    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        items(artifacts, key = { it.id }) { artifact ->
            ArtifactCard(artifact, selected = artifact.id == selectedId, now = now) { onPick(artifact) }
        }
        // The write affordance is a card like any other; a forbidden one stays
        // visible and greyed rather than silently absent.
        item {
            val permitted = capabilities.permits(SessionAction.CreateArtifact)
            CardFrame(
                selected = false,
                modifier = Modifier.alpha(if (permitted) 1f else FORBIDDEN_ALPHA),
                onClick = onNew.takeIf { permitted },
            ) {
                Text(
                    text = stringResource(R.string.artifacts_glyph_new) + " " +
                        stringResource(R.string.artifacts_action_new),
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}

@Composable
private fun ArtifactCard(artifact: HelmArtifact, selected: Boolean, now: Long, onClick: () -> Unit) {
    CardFrame(selected = selected, onClick = onClick) {
        Text(
            text = buildList {
                add(artifact.label)
                add(stringResource(R.string.artifacts_version_glyph, artifact.versionCount))
                if (artifact.intent == ArtifactIntent.Manifesto) {
                    add(stringResource(R.string.artifacts_intent_manifesto_badge))
                }
            }.joinToString(SEPARATOR),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
        )
        Text(
            text = artifact.title,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        SessionRowText.relativeTime(artifact.updatedAtEpochMs.takeIf { it > 0 }, now)?.let {
            Text(text = it, color = HelmColors.Faint, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun CardFrame(
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)?,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(HelmRadius.Md)
    Column(
        modifier = modifier
            .width(CARD_WIDTH)
            .clip(shape)
            .background(HelmColors.Surface)
            .border(HelmSize.Hairline, if (selected) HelmColors.Accent else HelmColors.Line, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(HelmSpacing.Md),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) { content() }
}

/** The selected card's body, in place; the detail screen is one tap (⤢) away. */
@Composable
private fun InlineViewer(
    artifact: HelmArtifact,
    read: ArtifactRead,
    onExpand: (HelmArtifact) -> Unit,
    onPull: (version: Int?) -> Unit,
) {
    // Only a read OF THIS artifact may draw here — a late answer for the
    // previous card must never show under the new one.
    val body = shownRead(read)?.takeIf { it.artifact.id == artifact.id }
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().background(HelmColors.Surface).padding(start = HelmSpacing.Md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = artifact.title,
                color = HelmColors.Txt,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            GhostButton(text = stringResource(R.string.artifacts_expand), onClick = { onExpand(artifact) })
        }
        if (artifact.intent == ArtifactIntent.Manifesto) ManifestoBanner()
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                body != null -> ArtifactBody(body)
                read is ArtifactRead.Failed -> Placeholder(read.message, HelmColors.Danger)
                else -> Placeholder(stringResource(R.string.artifacts_detail_loading))
            }
        }
        if (body != null && body.artifact.versionCount > 1) {
            VersionBar(versions = body.artifact.versionCount, selected = body.requestedVersion, onPick = onPull)
        }
    }
}

@Composable
private fun intentLabel(intent: ArtifactIntent): String = when (intent) {
    ArtifactIntent.Manifesto -> stringResource(R.string.artifacts_intent_manifesto_badge)
    ArtifactIntent.Normal -> stringResource(R.string.artifacts_intent_normal)
}

@Composable
private fun sortLabel(sort: ArtifactSort): String = stringResource(
    when (sort) {
        ArtifactSort.Created -> R.string.artifacts_sort_created
        ArtifactSort.Updated -> R.string.artifacts_sort_updated
        ArtifactSort.AZ -> R.string.artifacts_sort_az
    },
)

/** The detail half. [artifact] names what was opened; [state] carries its body. */
@Composable
fun ArtifactDetailScreen(
    artifact: HelmArtifact?,
    state: ArtifactRead,
    saveState: ArtifactSave,
    capabilities: Capabilities,
    linkState: LinkState,
    onPull: (version: Int?) -> Unit,
    onRevise: () -> Unit,
    onDownload: () -> Unit,
    attachmentPulls: Map<String, PullState>,
    onDownloadAttachment: (HelmArtifactAttachment) -> Unit,
    onOpenAttachment: (uri: String, mimeType: String) -> Unit,
    onDelete: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmingDelete by remember { mutableStateOf(false) }

    Box(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        Column(modifier = Modifier.fillMaxSize()) {
            val title = when {
                artifact != null -> artifact.title
                state is ArtifactRead.Done -> state.read.artifact.title
                else -> stringResource(R.string.artifacts_title)
            }
            HelmAppBar(
                title = title,
                linkState = linkState,
                onBack = onBack,
            )

            val displayedIntent = shownRead(state)?.artifact?.intent ?: artifact?.intent
            if (displayedIntent == ArtifactIntent.Manifesto) {
                ManifestoBanner()
            }

            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                when (state) {
                    is ArtifactRead.Done -> ArtifactBody(state.read)
                    // A version (or artifact) already read shows its cached body
                    // while the re-ask crosses the link — paging back never
                    // blanks the screen the user was just reading.
                    is ArtifactRead.Refreshing -> ArtifactBody(state.cached)
                    is ArtifactRead.Loading -> Placeholder(stringResource(R.string.artifacts_detail_loading))
                    is ArtifactRead.Failed -> Placeholder(state.message, HelmColors.Danger)
                    ArtifactRead.Idle -> Placeholder(stringResource(R.string.artifacts_detail_loading))
                }
            }

            // The files stored BESIDE the artifact, read from the list row rather
            // than from the body: the read answer carries no attachments by
            // design (see HelmArtifact.attachments), so the list cache is the only
            // place they exist on the phone. No row, and no header, without it.
            artifact?.attachments?.takeIf { it.isNotEmpty() }?.let { attachments ->
                AttachmentSection(
                    artifactId = artifact.id,
                    attachments = attachments,
                    pulls = attachmentPulls,
                    onDownload = onDownloadAttachment,
                    onOpen = onOpenAttachment,
                )
            }

            // The actions the session-addressed tools bought, one row each, greyed
            // from the gate like the sheet's. Revise needs the body in hand to
            // start from, so a body still crossing the link greys the row with the
            // same reason the body area above gives. A cached body IS in hand.
            val bodyInHand = shownRead(state) != null
            GatedRow(
                action = SessionAction.ReviseArtifact,
                capabilities = capabilities,
                enabled = bodyInHand,
                busyTail = if (bodyInHand) null else stringResource(R.string.artifacts_detail_loading),
                onClick = onRevise,
            )
            GatedRow(
                action = SessionAction.SaveArtifact,
                capabilities = capabilities,
                onClick = onDownload,
            )
            GatedRow(
                action = SessionAction.DeleteArtifact,
                capabilities = capabilities,
                // The one destructive action on this screen confirms, and it names
                // the artifact, because "are you sure?" answers nothing.
                onClick = { confirmingDelete = true },
            )
            SaveStateLine(saveState, artifactId = shownRead(state)?.artifact?.id ?: artifact?.id)

            // Version paging, the way the terminal tail's line counts work: the
            // desktop answers ONE version per ask, so a page is a re-ask, and the
            // row of chips is the record of what there is to ask for. A cached
            // read keeps its chips usable during the refresh it triggered.
            shownRead(state)?.let { read ->
                if (read.artifact.versionCount > 1) {
                    VersionBar(
                        versions = read.artifact.versionCount,
                        selected = read.requestedVersion,
                        onPick = onPull,
                    )
                }
            }
        }

        if (confirmingDelete) {
            ConfirmDelete(
                message = stringResource(R.string.artifacts_confirm_delete, title(artifact, state)),
                onConfirm = {
                    confirmingDelete = false
                    onDelete()
                },
                onCancel = { confirmingDelete = false },
            )
        }
    }
}

@Composable
private fun ManifestoBanner() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface2)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        Text(
            text = stringResource(R.string.artifacts_intent_manifesto_badge),
            color = HelmColors.Accent,
            style = MaterialTheme.typography.labelLarge,
        )
        Text(
            text = stringResource(R.string.artifacts_intent_manifesto_help),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

private fun title(artifact: HelmArtifact?, state: ArtifactRead): String = when {
    artifact != null -> artifact.title
    state is ArtifactRead.Done -> state.read.artifact.title
    state is ArtifactRead.Refreshing -> state.cached.artifact.title
    else -> ""
}

/**
 * The artifact's attachments, one row each, under a header that only exists when
 * there is something under it.
 *
 * Tapping a row starts a SLICED fetch of that file — the same transfer a chat
 * attachment makes — so each row narrates itself: bytes-of-bytes while it runs,
 * where it landed when it finishes, why not when it does not. That is why the
 * progress is here and not in the single Save line under the action rows: several
 * rows can be pulling at once, and one line cannot say so. A finished row becomes
 * an open button rather than re-fetching what is already on the phone.
 */
@Composable
private fun AttachmentSection(
    artifactId: String,
    attachments: List<HelmArtifactAttachment>,
    pulls: Map<String, PullState>,
    onDownload: (HelmArtifactAttachment) -> Unit,
    onOpen: (uri: String, mimeType: String) -> Unit,
) {
    Hairline()
    Text(
        text = stringResource(R.string.artifacts_attachments_header),
        color = HelmColors.Faint,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
    )
    for (attachment in attachments) {
        val pull = pulls[artifactAttachmentKey(artifactId, attachment.id)] ?: PullState.Idle
        HelmRow(
            title = attachment.filename,
            onClick = {
                // A pulled file opens; anything else asks for the bytes. A row
                // mid-transfer ignores the tap rather than starting a second
                // loop into the same buffer.
                when (pull) {
                    is PullState.Ready -> onOpen(pull.uri, attachment.contentType ?: DEFAULT_ATTACHMENT_MIME)
                    is PullState.Pulling -> Unit
                    else -> onDownload(attachment)
                }
            },
            // No chevron: the tap fetches a file onto the phone, it does not
            // open another screen, and a chevron would promise one.
            chevron = false,
            subtitle = {
                val (line, tint) = attachmentLine(pull, attachment.sizeBytes)
                Text(
                    text = line,
                    color = tint,
                    style = MaterialTheme.typography.bodySmall,
                )
            },
        )
    }
}

/**
 * The one line under an attachment's name: its size until something is happening
 * to it, then what is happening. Bytes-of-bytes rather than a percentage, because
 * on this link a percentage that has not moved in a minute is indistinguishable
 * from a frozen one.
 */
@Composable
private fun attachmentLine(pull: PullState, sizeBytes: Long): Pair<String, Color> = when (pull) {
    is PullState.Pulling -> stringResource(
        R.string.chat_attachment_pulling,
        humanSize(pull.received),
        humanSize(maxOf(pull.total, sizeBytes)),
    ) to HelmColors.Faint
    is PullState.Ready -> stringResource(R.string.artifacts_save_saved, pull.location) to HelmColors.Dim
    is PullState.Failed -> pull.message to HelmColors.Danger
    PullState.Idle -> humanSize(sizeBytes) to HelmColors.Faint
}

/** What a file with no declared type opens as. The system picks from the name. */
private const val DEFAULT_ATTACHMENT_MIME = "application/octet-stream"

/** The body on screen: settled, or the cached one a refresh is re-checking. */
private fun shownRead(state: ArtifactRead): HelmArtifactRead? = when (state) {
    is ArtifactRead.Done -> state.read
    is ArtifactRead.Refreshing -> state.cached
    else -> null
}

/** What the Save row knows beyond its label: the file's journey, in one line. */
@Composable
private fun SaveStateLine(saveState: ArtifactSave, artifactId: String?) {
    val (text, color) = when (val state = saveState) {
        is ArtifactSave.Downloading -> if (state.artifactId == artifactId) {
            stringResource(R.string.artifacts_save_receiving) to HelmColors.Faint
        } else {
            return
        }
        is ArtifactSave.Ready -> if (state.file.artifactId == artifactId) {
            stringResource(R.string.artifacts_save_writing) to HelmColors.Faint
        } else {
            return
        }
        is ArtifactSave.Saved -> if (state.artifactId == artifactId) {
            stringResource(R.string.artifacts_save_saved, state.path) to HelmColors.Dim
        } else {
            return
        }
        is ArtifactSave.Failed -> if (state.artifactId == artifactId) {
            state.message to HelmColors.Danger
        } else {
            return
        }
        ArtifactSave.Idle -> return
    }
    Text(
        text = text,
        color = color,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
    )
}

/**
 * One gated action row, drawn the sheet's ActionRow way — tile, label, and the
 * gate's reason when there is an honest one to give. A row that cannot work is
 * faded whole; "not permitted" is claimed only when the discovery actually
 * answered, because an unanswered ask is not a verdict.
 */
@Composable
private fun GatedRow(
    action: SessionAction,
    capabilities: Capabilities,
    onClick: () -> Unit,
    enabled: Boolean = true,
    busyTail: String? = null,
) {
    val permitted = capabilities.permits(action)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // The mockup fades the WHOLE row, tile included — colour alone did
            // not read as disabled next to a still-solid tile.
            .then(if (permitted) Modifier else Modifier.alpha(FORBIDDEN_ALPHA))
            .clickable(enabled = permitted && enabled, onClick = onClick)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        Box(
            modifier = Modifier
                .size(HelmSize.ActionTile)
                .clip(RoundedCornerShape(HelmRadius.Sm))
                .background(HelmColors.Surface2)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Sm)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(action.glyphRes),
                color = action.labelColor(permitted),
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        Text(
            text = stringResource(action.labelRes),
            color = action.labelColor(permitted),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )

        when {
            !permitted -> Text(
                text = stringResource(
                    if (capabilities.answered) R.string.control_not_permitted else R.string.control_asking,
                ),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
            )
            // Permitted but not usable right now — the body still crossing the
            // link — said in the same words the body area is saying.
            !enabled && busyTail != null -> Text(
                text = busyTail,
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
            )
        }
    }
}

@Composable
private fun ArtifactBody(read: HelmArtifactRead) {
    when (read.artifact.kind) {
        KIND_HTML -> HtmlViewer(read.content)
        KIND_MARKDOWN, KIND_COMPACT -> MarkdownBody(read.content)
        // A kind this build has never met is still text a reader can read;
        // refusing the whole artifact over its label would protect nobody.
        else -> PlainBody(read.content)
    }
}

/**
 * An HTML artifact: the rendered page, contained, with the source one tap away.
 *
 * Rendering is the point of the artifact; the WebView it renders in is the
 * [ContainedWebView] kind whose settings and client do the containing, and the
 * CSP the document carries is the [HtmlContainment] one. The source view stays
 * because a phone-width render of a desktop page can hide things — a reader
 * checking WHAT was written reads the text.
 */
@Composable
private fun HtmlViewer(source: String) {
    var showSource by rememberSaveable { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(modifier = Modifier.fillMaxWidth().background(HelmColors.Surface)) {
            GhostButton(
                text = stringResource(
                    if (showSource) R.string.artifacts_view_rendered else R.string.artifacts_view_source,
                ),
                onClick = { showSource = !showSource },
            )
        }
        if (showSource) {
            SourceLines(source)
        } else {
            ContainedWebView(
                html = HtmlContainment.injectCsp(source),
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}

@Composable
private fun SourceLines(source: String) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(HelmSpacing.Md),
    ) {
        val lines = source.lines()
        items(lines.size) { index ->
            Text(
                text = lines[index].ifEmpty { " " },
                color = HelmColors.Terminal,
                style = HelmType.Terminal,
            )
        }
    }
}

@Composable
private fun MarkdownBody(markdown: String) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(HelmSpacing.Md),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        items(MarkdownRules.blocks(markdown)) { block -> MarkdownBlock(block) }
    }
}

@Composable
private fun PlainBody(content: String) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(HelmSpacing.Md),
    ) {
        item {
            Text(
                text = content,
                color = HelmColors.Txt,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun VersionBar(versions: Int, selected: Int, onPick: (Int?) -> Unit) {
    Hairline()
    LazyRow(
        modifier = Modifier.fillMaxWidth().background(HelmColors.Surface),
        contentPadding = PaddingValues(HelmSpacing.Md),
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        items((1..versions).toList()) { version ->
            OutlineChip(stringResource(R.string.artifacts_version_glyph, version), on = version == selected) {
                onPick(version)
            }
        }
    }
}

@Composable
private fun Placeholder(text: String, color: Color = HelmColors.Faint) {
    Box(modifier = Modifier.fillMaxSize().padding(HelmSpacing.Xl), contentAlignment = Alignment.Center) {
        Text(
            text = text,
            color = color,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
    }
}

private const val KIND_MARKDOWN = "markdown"
private const val KIND_HTML = "html"

/** Helm's compaction snapshot: markdown underneath, badged as its own kind. */
private const val KIND_COMPACT = "compact"
private const val SEPARATOR = " · "
private val CARD_WIDTH = 148.dp

/** The mockup greys a forbidden row to 30%, on top of the Faint colour. */
private const val FORBIDDEN_ALPHA = 0.3f
