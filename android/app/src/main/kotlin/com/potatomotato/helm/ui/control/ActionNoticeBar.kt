package com.potatomotato.helm.ui.control

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.data.ActionNotice
import com.potatomotato.helm.data.ActionOutcome
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.ui.components.Hairline
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * How a control action ended, said once and dismissible.
 *
 * This bar exists because of the plan's most important line: the UI is a HINT,
 * the gate is the authority. The permitted-tools cache can be one poll stale, and
 * a refusal for something the sheet showed as permitted is a NORMAL outcome, not
 * a crash and not silence. The user has to be able to read it.
 *
 * A refusal and a dead link are worded differently on purpose — one is a rule
 * that will hold until the desktop's settings change, the other is a radio that
 * may come back on its own. What the app must NOT do is guess WHICH rule: every
 * deny path answers with the same bytes by design, so the wording points at the
 * settings rather than inventing a reason.
 */
@Composable
fun ActionNoticeBar(notice: ActionNotice, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val (text, color) = when (val outcome = notice.outcome) {
        ActionOutcome.Done -> stringResource(notice.action.doneRes) to HelmColors.Dim
        ActionOutcome.Refused -> stringResource(R.string.control_notice_refused) to HelmColors.State.Flash
        is ActionOutcome.Failed -> outcome.message to HelmColors.Danger
    }

    Column(modifier = modifier.fillMaxWidth().background(HelmColors.Surface)) {
        Hairline()
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onDismiss)
                .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Md),
        ) {
            Text(
                text = text,
                color = color,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = stringResource(R.string.control_notice_dismiss),
                color = HelmColors.Faint,
                style = MaterialTheme.typography.labelMedium,
            )
        }
        Hairline()
    }
}

/** Success is stated in the past tense of the thing that happened, never "OK". */
private val SessionAction.doneRes: Int
    get() = when (this) {
        SessionAction.Compact -> R.string.control_notice_done_compact
        SessionAction.Close -> R.string.control_notice_done_close
        SessionAction.Spawn -> R.string.control_notice_done_spawn
        // A snapshot reports itself on its own screen; it never raises a notice.
        SessionAction.Snapshot -> R.string.snapshot_title
    }
