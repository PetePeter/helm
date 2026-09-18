package com.potatomotato.helm.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmSize

/**
 * The app's one dropdown.
 *
 * WHY IT EXISTS: every menu here was a Material [DropdownMenu] left at its
 * defaults, and the default container colour in this theme is `surface` —
 * #0B0B0D against a true-black page. The popup therefore had no edge of its own
 * and read as text floating over the screen rather than as a menu; the anchors
 * read as captions. Reported from a real phone, in daylight, as "not clear it's
 * a dropdown".
 *
 * So the affordance is stated three times over, and none of them is colour
 * alone:
 *  - the ANCHOR is a pill — inset fill plus a hairline — not bare text;
 *  - its CHEVRON is text-bright and flips when the menu opens, so the control
 *    visibly has two states;
 *  - the MENU gets its own inset fill and border, so it separates from whatever
 *    is behind it.
 *
 * Every dropdown in the app goes through here, which is the point: a fix
 * applied to one call site is a fix the next screen forgets.
 */

/**
 * One row of a menu.
 *
 * [glyph] leads the row where a family of choices has icons (the root's
 * surfaces); [selected] marks where you already are — with a check AND the
 * accent, because a colour alone cannot carry that for a colour-blind reader.
 * [separatorBefore] groups unlike things in one menu, such as a list of modes
 * followed by a way out to another screen.
 */
data class HelmDropdownItem(
    val label: String,
    val glyph: String? = null,
    val selected: Boolean = false,
    val separatorBefore: Boolean = false,
)

/**
 * A menu hung off [anchor].
 *
 * The anchor is a lambda rather than a fixed pill because two callers are not
 * pills: the app bar's link badge is itself the anchor, and making it one would
 * put a chip inside a bar that already has three. It receives the open state so
 * it can show it, and the opener so the whole anchor is one touch target.
 */
@Composable
fun HelmDropdown(
    items: List<HelmDropdownItem>,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    anchor: @Composable (expanded: Boolean, open: () -> Unit) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }

    Box(modifier = modifier) {
        anchor(expanded) { expanded = true }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            // The menu's own surface. Without this it inherits `surface`, which
            // in this theme is a shade off true black — a popup with no edge.
            modifier = Modifier
                .background(HelmColors.Surface2)
                .border(HelmSize.Hairline, HelmColors.Line, MenuShape)
                .widthIn(min = MenuMinWidth),
            shape = MenuShape,
            containerColor = HelmColors.Surface2,
        ) {
            items.forEachIndexed { index, item ->
                if (item.separatorBefore && index > 0) {
                    Hairline(
                        modifier = Modifier.padding(vertical = HelmSpacing.Xs),
                        color = HelmColors.Separator,
                    )
                }
                DropdownMenuItem(
                    text = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
                        ) {
                            if (item.glyph != null) {
                                Text(
                                    text = item.glyph,
                                    color = HelmColors.Dim,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            }
                            Text(
                                text = item.label,
                                color = if (item.selected) HelmColors.Accent else HelmColors.Txt,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            if (item.selected) {
                                Spacer(Modifier.weight(1f))
                                Text(
                                    text = stringResource(R.string.context_glyph_check),
                                    color = HelmColors.Accent,
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            }
                        }
                    },
                    onClick = {
                        expanded = false
                        onSelect(index)
                    },
                )
            }
        }
    }
}

/**
 * The standard anchor: a label in a pill, with a chevron that flips when open.
 *
 * Label and chevron share ONE touch target — on a control this small, two
 * adjacent targets ask "which did you mean". It runs shorter than a full
 * [HelmSize.TouchTarget] because a 48dp control inside the app bar dwarfs the
 * glyphs beside it; 32dp still finds a thumb.
 */
@Composable
fun HelmDropdownAnchor(
    label: String,
    expanded: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(HelmRadius.Pill)

    Row(
        modifier = modifier
            .heightIn(min = AnchorMinHeight)
            .dropdownAnchorSurface(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = HelmSpacing.Md, vertical = HelmSpacing.Sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(HelmSpacing.Xs),
    ) {
        Text(
            text = label,
            color = HelmColors.Txt,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
        )
        HelmDropdownChevron(expanded = expanded, style = MaterialTheme.typography.labelSmall)
    }
}

/**
 * The fill and hairline that say "this is a control, not a caption".
 *
 * A modifier rather than a wrapper so an anchor that is NOT a pill — the
 * project row is a full-width line — gets the same skin without inheriting the
 * pill's layout. One definition, so a new dropdown cannot be drawn half-right.
 */
@Composable
fun Modifier.dropdownAnchorSurface(shape: Shape): Modifier = this
    .clip(shape)
    .background(HelmColors.Surface2)
    .border(HelmSize.Hairline, HelmColors.Line, shape)

/**
 * The chevron, text-bright and flipping when open.
 *
 * Bright rather than [HelmColors.Dim] because the chevron IS the affordance: a
 * dim one was the main reason these did not read as controls. It turns rather
 * than swapping character, so the control visibly has two states.
 */
@Composable
fun HelmDropdownChevron(
    expanded: Boolean,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.labelMedium,
) {
    val turn by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        label = "chevron",
    )
    Text(
        text = stringResource(R.string.projects_expand_glyph),
        color = HelmColors.Txt,
        style = style,
        modifier = modifier.rotate(turn),
    )
}

/**
 * The anchor's floor. Below this one-handed taps start missing; above
 * [HelmSize.TouchTarget] the control outgrows the bar it lives in.
 */
private val AnchorMinHeight = 32.dp

/** Narrow menus read as accidents; this is the floor that keeps them deliberate. */
private val MenuMinWidth = 180.dp

private val MenuShape = RoundedCornerShape(HelmRadius.Md)
