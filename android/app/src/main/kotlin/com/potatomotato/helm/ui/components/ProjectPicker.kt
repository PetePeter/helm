package com.potatomotato.helm.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.potatomotato.helm.R
import com.potatomotato.helm.data.HelmProject
import androidx.compose.foundation.shape.RoundedCornerShape
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * The project the top-level plan and context surfaces are about.
 *
 * It exists on the TOP-LEVEL surfaces only. An open session already has a
 * working directory, and offering a picker there would let the user point a
 * session's own plan list at another project's plans — a question nobody asked
 * that the screen would then have to answer.
 *
 * ONE CHOICE FEEDS TWO KEYS. A [HelmProject] carries both the `id` that context
 * calls need and the `canonicalPath` that plan and sequence calls take as their
 * dirPath, which is why the callback hands back the whole project rather than an
 * id: the caller decides which key its surface wants, and neither has to be
 * re-derived from the other.
 *
 * Stateless but for the menu's own open/closed flag, which is not state anyone
 * above needs and would be wrong to survive a rotation.
 */
@Composable
fun ProjectPicker(
    projects: LoadView<List<HelmProject>>,
    selected: HelmProject?,
    onSelect: (HelmProject) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth().background(HelmColors.Surface)) {
        when (projects) {
            LoadView.Loading -> PickerLine(stringResource(R.string.projects_loading), HelmColors.Faint)

            // A failure is offered as the retry itself: the row is the only thing
            // on screen that could bring the projects back.
            is LoadView.Failed -> PickerLine(
                text = projects.message,
                color = HelmColors.Danger,
                onClick = onRetry,
            )

            is LoadView.Ready -> if (projects.data.isEmpty()) {
                PickerLine(stringResource(R.string.projects_none), HelmColors.Faint)
            } else {
                // The row IS the anchor here — a full-width line rather than a
                // pill — but the menu itself comes from [HelmDropdown], so this
                // picker cannot drift from the rest of the app's dropdowns.
                HelmDropdown(
                    items = projects.data.map { project ->
                        HelmDropdownItem(
                            label = project.name,
                            selected = project.id == selected?.id,
                        )
                    },
                    onSelect = { index -> onSelect(projects.data[index]) },
                ) { expanded, open ->
                    PickerLine(
                        text = selected?.name ?: stringResource(R.string.projects_choose),
                        color = if (selected == null) HelmColors.Dim else HelmColors.Txt,
                        onClick = open,
                        expanded = expanded,
                    )
                }
            }
        }
        Hairline()
    }
}

/**
 * One line of the picker: the PROJECT caption, then the value.
 *
 * When it is a CONTROL ([expanded] is non-null) the value and its chevron sit
 * inside the shared dropdown skin — the same fill and hairline the pill anchors
 * wear. Before that they were bare text on the page, which is exactly what made
 * this row unreadable as a dropdown: the menu below had an edge and the thing
 * you tap did not. The caption stays outside the box; it labels the control
 * rather than being part of it.
 */
@Composable
private fun PickerLine(
    text: String,
    color: Color,
    onClick: (() -> Unit)? = null,
    expanded: Boolean? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = HelmSize.TouchTarget)
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.projects_label),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(end = HelmSpacing.Sm),
        )
        val shape = RoundedCornerShape(HelmRadius.Md)
        Row(
            modifier = Modifier
                .weight(1f)
                .then(if (expanded == null) Modifier else Modifier.dropdownAnchorSurface(shape))
                .then(if (onClick == null) Modifier else Modifier.clickable(onClick = onClick))
                .then(
                    if (expanded == null) Modifier
                    else Modifier.padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = text,
                color = color,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (expanded != null) HelmDropdownChevron(expanded = expanded)
        }
    }
}
