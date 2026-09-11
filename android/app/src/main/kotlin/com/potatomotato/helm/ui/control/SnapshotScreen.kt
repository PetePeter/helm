package com.potatomotato.helm.ui.control

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import com.potatomotato.helm.R
import com.potatomotato.helm.ble.LinkState
import com.potatomotato.helm.data.Snapshot
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.HelmAppBar
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * Mockup screen 7 — the terminal tail, pulled on demand.
 *
 * ON DEMAND IS THE DESIGN, not a limitation. A stream of terminal output over a
 * BLE link would spend the battery this transport was chosen to save, and the
 * user away from the desk wants a look, not a feed. The line count is chosen
 * BEFORE the pull, so the cost is decided by the person paying it.
 *
 * The text arrives already cleaned: the phone asks for the `stripped` tail and
 * has no ANSI parser of its own to drift from the desktop's.
 */
@Composable
fun SnapshotScreen(
    snapshot: Snapshot,
    linkState: LinkState,
    onPull: (Int) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().background(HelmColors.Bg)) {
        HelmAppBar(
            title = stringResource(R.string.snapshot_title),
            linkState = linkState,
            onBack = onBack,
            // Refresh re-pulls the count already on screen, so the chip row stays
            // the record of what was asked for.
            onOverflow = { (snapshot as? Snapshot.Lines)?.let { onPull(it.requested) } },
        )

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when (snapshot) {
                is Snapshot.Lines ->
                    if (snapshot.lines.isEmpty()) Placeholder(stringResource(R.string.snapshot_empty))
                    else Tail(snapshot.lines)

                is Snapshot.Loading -> Placeholder(stringResource(R.string.snapshot_loading, snapshot.lines))
                is Snapshot.Failed -> Placeholder(snapshot.message, HelmColors.Danger)
                Snapshot.Idle -> Placeholder(stringResource(R.string.snapshot_idle))
            }
        }

        LineCountBar(
            selected = (snapshot as? Snapshot.Lines)?.requested
                ?: (snapshot as? Snapshot.Loading)?.lines,
            onPick = onPull,
        )
    }
}

@Composable
private fun Tail(lines: List<String>) {
    // Terminal output is not prose: a wrapped line changes what a table or a
    // diff MEANS. It scrolls sideways instead, in its own scroller, so the
    // screen itself never scrolls horizontally.
    val horizontal = rememberScrollState()

    LazyColumn(
        modifier = Modifier.fillMaxSize().horizontalScroll(horizontal),
        contentPadding = PaddingValues(HelmSpacing.Md),
    ) {
        items(lines) { line ->
            Text(
                // A blank row still occupies its line: the spacing between blocks
                // of output is information too.
                text = line.ifEmpty { " " },
                color = HelmColors.Dim,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                maxLines = 1,
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

/**
 * The chips from the mockup. Every value sits under the desktop's 500-line
 * buffer, so no chip can ask for a tail that does not exist.
 */
@Composable
private fun LineCountBar(selected: Int?, onPick: (Int) -> Unit) {
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
        for (count in LINE_COUNTS) {
            val on = count == selected
            Text(
                text = count.toString(),
                color = if (on) HelmColors.OnAccent else HelmColors.Dim,
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .clip(RoundedCornerShape(HelmRadius.Pill))
                    .background(if (on) HelmColors.Accent else HelmColors.Surface2)
                    .clickable { onPick(count) }
                    .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
            )
        }
        Text(
            text = stringResource(R.string.snapshot_lines),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

/** 50 / 200 / 500, straight from the mockup. 500 is also the buffer's ceiling. */
private val LINE_COUNTS = listOf(50, 200, 500)
