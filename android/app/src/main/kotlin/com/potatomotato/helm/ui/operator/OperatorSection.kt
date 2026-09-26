package com.potatomotato.helm.ui.operator

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.components.StateDot
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The front page's "Helm" section — the operator is a place to talk to, not
 * one session among many, so it owns the top of the page: its status and last
 * reply (tap → its chat), the Call button, and the Hey Helm switch. The one
 * home of all three; the session list no longer carries any of them.
 */
@Composable
fun OperatorSection(
    summary: OperatorSummary,
    onOpenChat: (String) -> Unit,
    /** Ring the call. Null while there is nobody to ring and no call to return to. */
    onCall: (() -> Unit)?,
    /** The "Hey Helm" standby switch. Null hides it. */
    heyHelm: Boolean,
    onHeyHelm: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth().background(HelmColors.Surface)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = HelmSize.TouchTarget)
                .let { if (summary is OperatorSummary.On) it.clickable { onOpenChat(summary.id) } else it }
                .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        ) {
            if (summary is OperatorSummary.On) StateDot(state = summary.activity)
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.operator_section_title),
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    text = when (summary) {
                        OperatorSummary.Off -> stringResource(R.string.operator_section_off)
                        is OperatorSummary.On -> summary.lastReply ?: stringResource(R.string.call_helm_row_hint)
                    },
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (onCall != null) {
                Text(
                    text = stringResource(R.string.control_glyph_call),
                    color = HelmColors.Accent,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier
                        .heightIn(min = HelmSize.TouchTarget)
                        .clickable(onClick = onCall)
                        .padding(HelmSpacing.Sm),
                )
            }
        }
        if (onHeyHelm != null) HeyHelmRow(on = heyHelm, onToggle = { onHeyHelm(!heyHelm) })
        Hairline(color = HelmColors.Separator)
    }
}

/**
 * The standby switch. A labelled On/Off rather than a Material Switch, the same
 * choice the link bar's bell makes. The subtitle carries the honest caveat: the
 * built-in recogniser is not a wake-word engine.
 */
@Composable
private fun HeyHelmRow(on: Boolean, onToggle: () -> Unit) {
    Hairline(color = HelmColors.Separator)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = HelmSize.TouchTarget)
            .clickable(onClick = onToggle)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.hey_helm),
                color = HelmColors.Txt,
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.hey_helm_row_hint),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Text(
            text = stringResource(if (on) R.string.hey_helm_on else R.string.hey_helm_off),
            color = if (on) HelmColors.Accent else HelmColors.Faint,
            style = MaterialTheme.typography.titleMedium,
        )
    }
}
