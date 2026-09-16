package com.potatomotato.helm.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The five states every pulled surface has, drawn once.
 *
 * Loading, Ready, Ready-but-empty, Refreshing-over-cache and Failed-with-retry
 * are not five designs; they are one. Six screens each writing their own `when`
 * is six chances to forget the retry, or to blank a list the user was reading.
 * This is that `when`, and the screens above it render only their rows.
 *
 * [isEmpty] rather than requiring a collection: a DETAIL surface is "empty" on
 * different grounds than a list (a context node with no body), and both want the
 * same centred sentence.
 */
@Composable
fun <T> LoadBody(
    view: LoadView<T>,
    loadingText: String,
    emptyText: String,
    isEmpty: (T) -> Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable (T) -> Unit,
) {
    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        when (view) {
            // LOADING GETS AN ESCAPE TOO. It used to be the one state with no
            // way out: a bare sentence, so a surface that ended up waiting on an
            // ask nobody was going to answer could only be left by navigating
            // away and back. A wait the user can see deserves an answer they can
            // aim at, exactly as a failure does — and re-asking while an ask is
            // genuinely in flight costs one redundant round trip, which is
            // cheaper than a dead end.
            LoadView.Loading -> {
                Box(modifier = Modifier.weight(1f)) {
                    LoadNote(loadingText)
                }
                GhostButton(
                    text = stringResource(R.string.load_retry),
                    onClick = onRefresh,
                    modifier = Modifier.padding(HelmSpacing.Gutter),
                )
            }

            is LoadView.Failed -> {
                Box(modifier = Modifier.weight(1f)) {
                    LoadNote(view.message, HelmColors.Danger)
                }
                // The retry is a button, not a pull-to-refresh: a failure the
                // user can see needs an answer they can aim at.
                GhostButton(
                    text = stringResource(R.string.load_retry),
                    onClick = onRefresh,
                    modifier = Modifier.padding(HelmSpacing.Gutter),
                )
            }

            is LoadView.Ready -> {
                RefreshStrip(refreshing = view.refreshing, onRefresh = onRefresh)
                Box(modifier = Modifier.weight(1f)) {
                    if (isEmpty(view.data)) LoadNote(emptyText) else content(view.data)
                }
            }
        }
    }
}

/**
 * The line above a settled body: what a refresh is doing, or the offer to start
 * one. Text rather than a spinner — the rows below are already the answer, and a
 * spinner over readable content reads as "do not trust this".
 */
@Composable
private fun RefreshStrip(refreshing: Boolean, onRefresh: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(HelmColors.Surface)
            .then(if (refreshing) Modifier else Modifier.clickable(onClick = onRefresh))
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
        horizontalArrangement = Arrangement.End,
    ) {
        Text(
            text = stringResource(if (refreshing) R.string.load_refreshing else R.string.load_refresh),
            color = if (refreshing) HelmColors.Faint else HelmColors.Dim,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

/** A centred sentence where a body would be — loading, empty, or a failure. */
@Composable
fun LoadNote(text: String, color: Color = HelmColors.Faint) {
    Box(
        modifier = Modifier.fillMaxSize().padding(HelmSpacing.Xl),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = color,
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
    }
}
