package com.potatomotato.helm.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * One tappable list row — the skeleton the plan board, the context list and the
 * artifact list had each drawn by hand, three times, with the artifacts copy
 * quietly missing the touch target and the inter-glyph spacing the other two
 * had. Shared so a fourth list cannot reintroduce the drift, and so the copy
 * affordance lands on every row the same way.
 *
 * The skeleton is: title (truncate, never wrap — the session list's rule, so
 * every list keeps the same rhythm), an optional subtitle, then the trailing
 * edge — the ⧉ reference copy when [copy] is set, whatever [trailing] adds (a
 * status pill, usually), and the chevron. The hairline under the row belongs
 * here too: a row without its separator is half a row.
 *
 * [subtitle] is a slot rather than a string because the plan row's subtitle is
 * itself a small row (human id, startable marker), and flattening that to a
 * joined string would lose the spacing the two facts sit at.
 */
@Composable
fun HelmRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: (@Composable ColumnScope.() -> Unit)? = null,
    copy: String? = null,
    trailing: @Composable RowScope.() -> Unit = {},
    chevron: Boolean = true,
) {
    Column(modifier = modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = HelmSize.TouchTarget)
                .clickable(onClick = onClick)
                .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    color = HelmColors.Txt,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                subtitle?.invoke(this)
            }
            // The reference goes BEFORE the pill and chevron: it is a property of
            // the row's subject, and the chrome that opens the detail stays last,
            // where the thumb already looks for it.
            copy?.let { reference -> CopyGlyphButton(text = reference) }
            trailing()
            if (chevron) {
                Text(
                    text = CHEVRON,
                    color = HelmColors.Faint,
                    style = MaterialTheme.typography.titleLarge,
                )
            }
        }
        Hairline(color = HelmColors.Separator)
    }
}
