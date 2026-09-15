package com.potatomotato.helm.ui.artifacts

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.ArtifactRules
import com.potatomotato.helm.data.ArtifactRules.Verdict
import com.potatomotato.helm.data.HelmArtifact
import com.potatomotato.helm.ui.components.GhostButton
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.components.PrimaryButton
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
 * The one writing surface in the artifacts slice: a title and a body, nothing
 * else. Create is markdown-only because the desktop's session-addressed create
 * refuses every other kind (HTML authored from a phone keyboard is a
 * sanitization question nobody has answered — invariant 9), so the form offers
 * no kind choice at all; a revise inherits the artifact's own kind, and an HTML
 * body is edited as the source it is shown as.
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

    val verdict = when (edit) {
        is ArtifactEdit.New -> ArtifactRules.judgeCreate(title, body)
        is ArtifactEdit.Revision -> ArtifactRules.judgeRevision(edit.shown, body)
    }
    val sendable = verdict == Verdict.Ok

    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        HelmAppBar(
            title = if (revision == null) {
                stringResource(R.string.artifacts_editor_new)
            } else {
                stringResource(R.string.artifacts_editor_revise, revision.artifact.title)
            },
            linkState = linkState,
            onBack = onBack,
        )

        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
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
            Field(
                value = body,
                onValue = { body = it },
                singleLine = false,
                label = if (revision == null) {
                    stringResource(R.string.artifacts_body_markdown)
                } else {
                    stringResource(R.string.artifacts_body_label)
                },
                semanticsError = null,
            )
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
            PrimaryButton(
                text = stringResource(
                    if (revision == null) R.string.artifacts_submit_create else R.string.artifacts_submit_revise,
                ),
                enabled = sendable,
                // The client enforces the same rules again before the radio; the
                // trim here is the one place the title is settled.
                onClick = { onSubmit(ArtifactRules.title(title), body) },
            )
            GhostButton(text = stringResource(R.string.control_rename_cancel), onClick = onBack)
        }
    }
}

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
