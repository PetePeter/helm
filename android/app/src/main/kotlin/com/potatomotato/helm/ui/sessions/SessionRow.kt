@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package com.potatomotato.helm.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ContextHistory
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.components.CONTEXT_RING_SIZE
import com.potatomotato.helm.ui.components.ContextRingButton
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

@Composable
fun SessionRow(
    session: HelmSession,
    unreadCount: Int,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    nowMs: Long,
    selected: Boolean = false,
    context: ContextHistory? = null,
    compact: Boolean = false,
) {
    val badge = SessionRows.unreadBadgeLabel(unreadCount)

    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = HelmSize.TouchTarget)
                .background(if (selected) HelmColors.Surface2 else HelmColors.Bg)
                // Long-press opens the control sheet without entering the thread —
                // close and compact are list-level questions, not thread-level ones.
                .combinedClickable(onClick = onClick, onLongClick = onLongClick)
                .padding(horizontal = if (compact) COMPACT_GUTTER else HelmSpacing.Gutter, vertical = HelmSpacing.Md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(if (compact) HelmSpacing.Xs else HelmSpacing.Md),
        ) {
            ContextRingButton(
                state = session.activity,
                history = context,
                quotaUsage = session.quotaUsage,
                size = if (compact) COMPACT_RING_SIZE else CONTEXT_RING_SIZE,
            )
            if (compact) {
                // At 320dp, the 58% picker is 186dp; this layout leaves about 122dp for the name with a badge.
                Text(
                    text = session.name,
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                badge?.let { SessionUnreadBadge(it, compact = true) }
            } else {
                val labels = SessionRowText.Labels(
                    working = stringResource(R.string.sessions_sub_working),
                    waitingApproval = stringResource(R.string.sessions_sub_waiting),
                    idle = stringResource(R.string.sessions_sub_idle),
                )
                val age = SessionRowText.relativeTime(session.lastActiveAtEpochMs, nowMs)
                val eta = SessionRowText.etaLabel(session.eta, nowMs)
                Column(modifier = Modifier.weight(1f)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
                    ) {
                        Text(
                            text = session.name,
                            color = HelmColors.Txt,
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            // Truncate, never wrap: a two-line row breaks the rhythm of the
                            // list far more than a clipped name costs.
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        // Fixed-width slots (empty ones still take their width) so the name
                        // and age columns line up on every row, whatever it carries.
                        Text(
                            text = eta?.let {
                                stringResource(
                                    if (it.overdue) R.string.sessions_eta_row_overdue else R.string.sessions_eta_row_remaining,
                                    it.minutes,
                                )
                            }.orEmpty(),
                            color = if (eta?.overdue == true) HelmColors.CacheWarn else HelmColors.Accent,
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            textAlign = TextAlign.End,
                            modifier = Modifier.width(ETA_SLOT),
                        )
                        Text(
                            text = session.statusIcons(nowMs),
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.width(ICON_SLOT),
                        )
                        Text(
                            text = age.orEmpty(),
                            color = HelmColors.Faint,
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            textAlign = TextAlign.End,
                            modifier = Modifier.width(AGE_SLOT),
                        )
                    }
                    Text(
                        text = SessionRowText.detailLine(
                            status = SessionRowText.subLine(
                                activity = session.activity,
                                cliTypeName = session.cliTypeName,
                                // The age has its own column; repeating it here said it twice.
                                age = null,
                                labels = labels,
                            ),
                            branch = session.gitBranch?.let { stringResource(R.string.sessions_git_branch, it) },
                            mission = session.mission,
                        ),
                        color = HelmColors.Faint,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // Unread chat is a count badge, not a sub-line word: findable without
                // reading anything. Its own fixed slot, so a row without one keeps the
                // same column.
                Box(modifier = Modifier.width(BADGE_SLOT), contentAlignment = Alignment.Center) {
                    badge?.let { SessionUnreadBadge(it) }
                }
            }
        }
        Hairline(color = HelmColors.Separator)
    }
}

@Composable
private fun SessionUnreadBadge(label: String, compact: Boolean = false) {
    Text(
        text = label,
        color = HelmColors.OnAccent,
        style = MaterialTheme.typography.labelSmall,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = (if (compact) Modifier.widthIn(max = COMPACT_BADGE_MAX_WIDTH) else Modifier)
            .clip(RoundedCornerShape(HelmRadius.Pill))
            .background(HelmColors.Accent)
            .padding(
                horizontal = if (compact) COMPACT_BADGE_GUTTER else HelmSpacing.Sm,
                vertical = HelmSpacing.Xs,
            ),
    )
}

private val ICON_SLOT = 34.dp
private val ETA_SLOT = 70.dp
private val AGE_SLOT = 32.dp
private val BADGE_SLOT = 28.dp
private val COMPACT_GUTTER = 4.dp
private val COMPACT_RING_SIZE = 20.dp
private val COMPACT_BADGE_GUTTER = 2.dp
private val COMPACT_BADGE_MAX_WIDTH = 28.dp
