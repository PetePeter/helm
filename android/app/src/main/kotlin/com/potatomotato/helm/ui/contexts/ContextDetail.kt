package com.potatomotato.helm.ui.contexts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmContext
import com.potatomotato.helm.ui.components.LoadBody
import com.potatomotato.helm.ui.components.LoadView
import com.potatomotato.helm.ui.components.Pill
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * One context node, read in full.
 *
 * Scope-blind like every other surface here.
 *
 * THE BODY IS PLAIN TEXT, deliberately. Context nodes are written by agents as
 * often as by the user, and AI-authored content is untrusted by invariant 9 —
 * so it is not put through the markdown renderer and gains no links, no images
 * and no styling it could have asked for. A node that is genuinely empty says so
 * rather than showing a blank screen the user cannot tell from a failure.
 */
@Composable
fun ContextDetail(
    context: LoadView<HelmContext>,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
) {
    LoadBody(
        view = context,
        loadingText = stringResource(R.string.context_detail_loading),
        emptyText = stringResource(R.string.context_detail_loading),
        // The node itself is never the empty thing — its BODY may be, and that
        // is said inside the body area so the title and pills stay readable.
        isEmpty = { false },
        onRefresh = onRefresh,
        modifier = modifier,
    ) { shown ->
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            item(key = "head") { ContextHead(shown) }
            item(key = "body") {
                Text(
                    text = shown.content.ifBlank { stringResource(R.string.context_empty_content) },
                    color = if (shown.content.isBlank()) HelmColors.Faint else HelmColors.Txt,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
                )
            }
        }
    }
}

/** The title, with the type and permission the list row also wears. */
@Composable
private fun ContextHead(context: HelmContext) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        Text(
            text = context.title,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.titleLarge,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm)) {
            // The type is free text on the desktop, so it is shown as written —
            // an unrecognised label is a label, not an error.
            Pill(
                text = context.type.ifBlank { stringResource(R.string.context_type_none) },
                color = HelmColors.Dim,
            )
            Pill(
                text = stringResource(context.permission.labelRes),
                color = context.permission.pillColor,
            )
        }
    }
}
