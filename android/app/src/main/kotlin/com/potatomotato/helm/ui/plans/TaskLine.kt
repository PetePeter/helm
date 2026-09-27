package com.potatomotato.helm.ui.plans

import android.text.format.DateFormat
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmPlanTask
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing
import java.util.Date

/**
 * Where an operator task's links go: the builder's chat, and the watched plan's
 * detail (by UUID) opened in the BUILDER's scope — the builder works the plan's
 * project, the operator's own project would offer the wrong lanes.
 */
class TaskLinks(val openSession: (String) -> Unit, val openPlan: (planId: String, builderSessionId: String?) -> Unit)

/**
 * An operator task's follow-up line under its plan row. The builder and the
 * watched plan are their own tap targets — tapping the row still opens the
 * task itself, as for any plan.
 */
@Composable
internal fun TaskLine(task: HelmPlanTask, links: TaskLinks) {
    val context = LocalContext.current
    val nextCheck = when (val check = TaskCard.nextCheck(task, System.currentTimeMillis())) {
        NextCheck.NoTimer -> stringResource(R.string.task_no_timer)
        NextCheck.DueNow -> stringResource(R.string.task_due_now)
        is NextCheck.At -> DateFormat.getTimeFormat(context).format(Date(check.epochMs))
    }
    // Two short lines rather than one long one: each label gets its own share
    // of the width, so a long builder name cannot push the others off-screen.
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        TaskCard.builder(task)?.let { builder ->
            // Only a LIVE builder is a link: a gone session's id is shown, not offered.
            val liveId = task.builderSessionId?.takeIf { task.builderName != null }
            TaskText(
                text = stringResource(R.string.task_builder, builder),
                color = if (liveId != null) HelmColors.Accent else HelmColors.Dim,
                onClick = liveId?.let { id -> { links.openSession(id) } },
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        task.watchPlanId?.let { ref ->
            val uuid = task.watchPlanUuid
            TaskText(
                text = stringResource(R.string.task_watch, ref),
                color = if (uuid != null) HelmColors.Accent else HelmColors.Dim,
                onClick = uuid?.let { id -> { links.openPlan(id, task.builderSessionId?.takeIf { task.builderName != null }) } },
                modifier = Modifier.weight(1f, fill = false),
            )
        }
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        TaskText(text = stringResource(R.string.task_next_check, nextCheck), color = HelmColors.Dim, onClick = null)
        task.waitingOn?.let {
            TaskText(
                text = stringResource(R.string.task_waiting, it),
                color = HelmColors.Dim,
                onClick = null,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
    }
}

@Composable
private fun TaskText(text: String, color: Color, onClick: (() -> Unit)?, modifier: Modifier = Modifier) {
    Text(
        text = text,
        color = color,
        style = MaterialTheme.typography.bodySmall,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = if (onClick != null) {
            modifier.heightIn(min = HelmSize.TouchTarget).clickable(onClick = onClick).padding(vertical = HelmSpacing.Sm)
        } else {
            modifier
        },
    )
}
