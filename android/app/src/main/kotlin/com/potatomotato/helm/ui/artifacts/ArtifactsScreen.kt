package com.potatomotato.helm.ui.artifacts

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.ArtifactList
import com.potatomotato.helm.data.ArtifactRead
import com.potatomotato.helm.data.ArtifactSave
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.HelmArtifact
import com.potatomotato.helm.data.HelmArtifactRead
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.answered
import com.potatomotato.helm.data.permits
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.HelmAppBar
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
 * RENDERING IS STILL LIMITED. Markdown gets the [MarkdownRules] subset; HTML is
 * shown as SOURCE and nothing else. A WebView would be a sandbox escape the
 * phone's threat model never bought — artifact content is AI-authored, which
 * is untrusted by invariant 9 — and rendering HTML as text with a note pointing
 * at the desktop is the honest version of "this needs the big screen". The
 * revise editor inherits the same limitation: an HTML body is edited as source.
 */
@Composable
fun ArtifactsScreen(
    state: ArtifactList,
    capabilities: Capabilities,
    onOpen: (HelmArtifact) -> Unit,
    onNew: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // No app bar here: this is the session's Artifacts TAB, and the session's
    // chrome is owned by the scaffold that hosts the tabs. The DETAIL screen
    // below still carries its own — it hangs off the tab, it is not one.
    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when (state) {
                is ArtifactList.Ready -> ListBody(state.artifacts, capabilities, onOpen, onNew)

                // A re-visit keeps the last answer on screen while the fresh one
                // crosses the link: the rows the user is looking at are the
                // best-known truth, and a blank screen is the worst one.
                is ArtifactList.Refreshing -> ListBody(state.cached, capabilities, onOpen, onNew)

                is ArtifactList.Loading -> Placeholder(stringResource(R.string.artifacts_loading))
                is ArtifactList.Failed -> Placeholder(state.message, HelmColors.Danger)
                ArtifactList.Idle -> Placeholder(stringResource(R.string.artifacts_loading))
            }
        }
    }
}

/** The rows both a settled and a refreshing list draw; only the source differs. */
@Composable
private fun ListBody(
    artifacts: List<HelmArtifact>,
    capabilities: Capabilities,
    onOpen: (HelmArtifact) -> Unit,
    onNew: () -> Unit,
) {
    if (artifacts.isEmpty() && !capabilities.permits(SessionAction.CreateArtifact)) {
        Placeholder(stringResource(R.string.artifacts_empty))
    } else {
        ArtifactRows(artifacts, capabilities, onOpen, onNew)
    }
}

@Composable
private fun ArtifactRows(
    artifacts: List<HelmArtifact>,
    capabilities: Capabilities,
    onOpen: (HelmArtifact) -> Unit,
    onNew: () -> Unit,
) {
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(artifacts, key = { it.id }) { artifact ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onOpen(artifact) }
                    .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = artifact.title,
                        color = HelmColors.Txt,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = listOf(kindLabel(artifact.kind), versionLabel(artifact.versionCount))
                            .joinToString(SEPARATOR),
                        color = HelmColors.Faint,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Text(
                    text = CHEVRON,
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.titleLarge,
                )
            }
            Hairline(color = HelmColors.Separator)
        }
        item {
            // The write affordance is a row like any other, so the gate's reason
            // has somewhere honest to sit ("not permitted", or "checking…" while
            // the discovery is unanswered) instead of an app-bar button that
            // would have to be silently absent.
            GatedRow(
                action = SessionAction.CreateArtifact,
                capabilities = capabilities,
                onClick = onNew,
            )
        }
    }
}

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
                title = title(artifact, state),
                onConfirm = {
                    confirmingDelete = false
                    onDelete()
                },
                onCancel = { confirmingDelete = false },
            )
        }
    }
}

private fun title(artifact: HelmArtifact?, state: ArtifactRead): String = when {
    artifact != null -> artifact.title
    state is ArtifactRead.Done -> state.read.artifact.title
    state is ArtifactRead.Refreshing -> state.cached.artifact.title
    else -> ""
}

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

@Composable
private fun ConfirmDelete(title: String, onConfirm: () -> Unit, onCancel: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HelmColors.Bg.copy(alpha = SCRIM_ALPHA))
            // Tapping the darkness around the card is cancel, like the sheet.
            .clickable(onClick = onCancel),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                // Consume taps on the card so they never fall through to the
                // scrim: only a deliberate Cancel or a dismiss-tap cancels.
                .padding(HelmSpacing.Gutter)
                .clip(RoundedCornerShape(HelmRadius.Md))
                .background(HelmColors.Surface)
                .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Md))
                // A bare pointer input, not an empty clickable: it keeps scrim
                // taps from falling through to Cancel without adding the
                // unlabeled no-op node an empty clickable puts in the tree.
                .pointerInput(Unit) {}
                .padding(HelmSpacing.Lg),
            verticalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        ) {
            Text(
                text = stringResource(R.string.artifacts_confirm_delete, title),
                color = HelmColors.Txt,
                style = MaterialTheme.typography.bodyLarge,
            )
            // The destructive one is NOT the loud accent button: the accent means
            // "the thing you came here to do", and that is never losing a file.
            Text(
                text = stringResource(R.string.artifacts_confirm_delete_yes),
                color = HelmColors.Danger,
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(HelmRadius.Md))
                    .clickable(onClick = onConfirm)
                    .padding(vertical = HelmSpacing.Md),
            )
            GhostButton(text = stringResource(R.string.control_confirm_close_no), onClick = onCancel)
        }
    }
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
        KIND_HTML -> HtmlSource(read.content)
        KIND_MARKDOWN -> MarkdownBody(read.content)
        // A kind this build has never met is still text a reader can read;
        // refusing the whole artifact over its label would protect nobody.
        else -> PlainBody(read.content)
    }
}

/** HTML is shown as source, with the reason said out loud rather than implied. */
@Composable
private fun HtmlSource(source: String) {
    Column(modifier = Modifier.fillMaxSize()) {
        Text(
            text = stringResource(R.string.artifacts_source_note),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .fillMaxWidth()
                .background(HelmColors.Surface)
                .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
        )
        SourceLines(source)
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
private fun MarkdownBlock(block: MdBlock) {
    when (block) {
        is MdBlock.Image -> InlineImage(block)
        is MdBlock.Heading -> Text(
            text = block.text,
            color = HelmColors.Txt,
            style = if (block.level <= 2) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
        )

        is MdBlock.Paragraph -> Text(
            text = annotate(block.spans),
            color = HelmColors.Txt,
            style = MaterialTheme.typography.bodyMedium,
        )

        is MdBlock.Bullet -> Row {
            Text(
                text = BULLET_GLYPH,
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = annotate(block.spans),
                color = HelmColors.Txt,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        is MdBlock.Quote -> Text(
            text = annotate(block.spans),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(start = HelmSpacing.Lg),
        )

        is MdBlock.Code -> Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Sm))
                .background(HelmColors.Surface2)
                .padding(HelmSpacing.Md),
        ) {
            block.lines.forEach { line ->
                Text(
                    text = line.ifEmpty { " " },
                    color = HelmColors.Terminal,
                    style = HelmType.Terminal,
                )
            }
        }

        MdBlock.Rule -> Hairline()
    }
}

@Composable
private fun InlineImage(image: MdBlock.Image) {
    val bytes = try { Base64.decode(image.source.substringAfter(','), Base64.DEFAULT) } catch (_: IllegalArgumentException) { null }
    val bitmap = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
    if (bitmap == null) {
        Text(text = image.alt.ifBlank { "Image unavailable" }, color = HelmColors.Faint, style = MaterialTheme.typography.bodySmall)
    } else {
        Image(bitmap = bitmap.asImageBitmap(), contentDescription = image.alt.ifBlank { null }, modifier = Modifier.fillMaxWidth())
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

/** The subset's spans become styles; a link is underlined accent text, not a jump. */
@Composable
private fun annotate(spans: List<MdSpan>): AnnotatedString = buildAnnotatedString {
    for (span in spans) {
        when (span) {
            is MdSpan.Text -> append(span.text)
            is MdSpan.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(span.text) }
            is MdSpan.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(span.text) }
            is MdSpan.CodeSpan -> withStyle(
                SpanStyle(fontFamily = FontFamily.Monospace, background = HelmColors.Surface2),
            ) { append(span.text) }
            is MdSpan.Link -> withStyle(
                SpanStyle(color = HelmColors.Accent, textDecoration = TextDecoration.Underline),
            ) { append(span.text) }
        }
    }
}

@Composable
private fun VersionBar(versions: Int, selected: Int, onPick: (Int?) -> Unit) {
    Hairline()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .padding(HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        for (version in 1..versions) {
            val on = version == selected
            // The chosen chip outlines in accent rather than filling, like the
            // snapshot line counts: an outline reads as a setting, a fill as a
            // button.
            Text(
                text = stringResource(R.string.artifacts_version_glyph, version),
                color = if (on) HelmColors.Accent else HelmColors.Dim,
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .clip(RoundedCornerShape(HelmRadius.Pill))
                    .border(
                        HelmSize.Hairline,
                        if (on) HelmColors.Accent else HelmColors.Line,
                        RoundedCornerShape(HelmRadius.Pill),
                    )
                    .clickable { onPick(version) }
                    .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
            )
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

/** The wire kind, said the way a reader says it; an unknown kind shows as itself. */
@Composable
private fun kindLabel(kind: String): String = when (kind) {
    KIND_MARKDOWN -> stringResource(R.string.artifacts_kind_markdown)
    KIND_HTML -> stringResource(R.string.artifacts_kind_html)
    else -> kind
}

@Composable
private fun versionLabel(count: Int): String =
    pluralStringResource(R.plurals.artifacts_version_count, count, count)

private const val KIND_MARKDOWN = "markdown"
private const val KIND_HTML = "html"
private const val SEPARATOR = " · "
private const val CHEVRON = "›"
private const val BULLET_GLYPH = "•  "

/** The mockup greys a forbidden row to 30%, on top of the Faint colour. */
private const val FORBIDDEN_ALPHA = 0.3f
