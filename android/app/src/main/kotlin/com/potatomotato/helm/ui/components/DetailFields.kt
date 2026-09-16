package com.potatomotato.helm.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSize
import com.potatomotato.helm.ui.theme.HelmSpacing

/**
 * What a detail screen may say about a thing, as a NAME rather than a sentence.
 *
 * An enum and not a string because every user-visible word lives in
 * `strings.xml`: the pure builders that decide WHICH fields a plan or a lane has
 * run on the JVM, where a resource id cannot be resolved, so they name the field
 * and the composable says it.
 *
 * The set is shared by the plan and sequence surfaces rather than split per
 * surface. They overlap (both have a directory, both carry prose), and one list
 * of labels is one place to keep the wording consistent.
 */
enum class DetailLabel {
    PlanId,
    Description,
    StateNote,
    CompletionNotes,
    Type,
    AutoImplement,
    CompletionRecap,
    Directory,
    Order,
    Mission,
    SharedMemory,
    Members,
    Contexts,
}

/**
 * One field's value.
 *
 * A boolean is NOT pre-rendered as "Yes"/"No" by the pure builder — that would
 * be an untranslated literal smuggled out of a unit-testable function and onto
 * the screen. It stays a boolean until the composable can reach the resources.
 */
sealed interface DetailValue {
    data class Text(val text: String) : DetailValue
    data class Flag(val on: Boolean) : DetailValue
}

/** One labelled fact of a detail screen, in the order the screen shows it. */
data class DetailField(val label: DetailLabel, val value: DetailValue)

/**
 * A field, when there is anything to say.
 *
 * Blank prose and absent flags are OMITTED rather than shown empty: a detail
 * screen listing "Completion notes: " for every unfinished plan is noise that
 * makes the fields that DO carry something harder to find.
 */
internal fun field(label: DetailLabel, text: String?): DetailField? =
    text?.takeIf { it.isNotBlank() }?.let { DetailField(label, DetailValue.Text(it.trim())) }

/** A flag, when the desktop actually answered one. */
internal fun flag(label: DetailLabel, on: Boolean?): DetailField? =
    on?.let { DetailField(label, DetailValue.Flag(it)) }

/** The eyebrow label and body of one field, drawn the way every detail draws it. */
@Composable
fun DetailFieldBlock(field: DetailField, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Sm),
    ) {
        Text(
            text = stringResource(field.label.labelRes),
            color = HelmColors.Faint,
            style = MaterialTheme.typography.labelSmall,
        )
        when (val value = field.value) {
            // Prose is AUTHORED, usually by an agent, and arrives written as
            // markdown — shown raw it reads as "## Problem Statement" and
            // "**bold**". It goes through the app's one contained renderer (see
            // MarkdownRender), never a second one, per invariant 9.
            is DetailValue.Text -> if (field.label.isProse) {
                MarkdownText(value.text, modifier = Modifier.padding(top = HelmSpacing.Xs))
            } else {
                FieldText(value.text)
            }

            is DetailValue.Flag -> FieldText(
                stringResource(if (value.on) R.string.detail_flag_yes else R.string.detail_flag_no),
            )
        }
    }
}

/** A field value that is a fact, not prose: an id, a path, a type, a yes/no. */
@Composable
private fun FieldText(text: String) {
    Text(
        text = text,
        color = HelmColors.Txt,
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.padding(top = HelmSpacing.Xs),
    )
}

/**
 * Which labels carry PROSE — free-form text a human or an agent wrote — as
 * opposed to a scalar fact.
 *
 * The distinction is per LABEL rather than sniffed from the value: whether a
 * field is prose is a property of what it means, and deciding it by looking for
 * markdown characters would render a directory path containing an asterisk as
 * italics.
 */
private val DetailLabel.isProse: Boolean
    get() = when (this) {
        DetailLabel.Description,
        DetailLabel.StateNote,
        DetailLabel.CompletionNotes,
        DetailLabel.Mission,
        DetailLabel.SharedMemory,
        -> true

        DetailLabel.PlanId,
        DetailLabel.Type,
        DetailLabel.AutoImplement,
        DetailLabel.CompletionRecap,
        DetailLabel.Directory,
        DetailLabel.Order,
        DetailLabel.Members,
        DetailLabel.Contexts,
        -> false
    }

private val DetailLabel.labelRes: Int
    get() = when (this) {
        DetailLabel.PlanId -> R.string.detail_label_plan_id
        DetailLabel.Description -> R.string.detail_label_description
        DetailLabel.StateNote -> R.string.detail_label_state_note
        DetailLabel.CompletionNotes -> R.string.detail_label_completion_notes
        DetailLabel.Type -> R.string.detail_label_type
        DetailLabel.AutoImplement -> R.string.detail_label_auto_implement
        DetailLabel.CompletionRecap -> R.string.detail_label_completion_recap
        DetailLabel.Directory -> R.string.detail_label_directory
        DetailLabel.Order -> R.string.detail_label_order
        DetailLabel.Mission -> R.string.detail_label_mission
        DetailLabel.SharedMemory -> R.string.detail_label_shared_memory
        DetailLabel.Members -> R.string.detail_label_members
        DetailLabel.Contexts -> R.string.detail_label_contexts
    }

/**
 * A small outlined chip — a plan's status, a context node's permission, the
 * startable marker.
 *
 * Outline and not a fill, for the reason the version chips and the tab underline
 * give: on true black a filled chip reads as a raised surface, and elevation
 * here is a hairline by contract (see [HelmColors]).
 */
@Composable
fun Pill(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text,
        color = color,
        style = MaterialTheme.typography.labelSmall,
        maxLines = 1,
        modifier = modifier
            .clip(RoundedCornerShape(HelmRadius.Pill))
            .background(HelmColors.Surface2)
            .border(HelmSize.Hairline, HelmColors.Line, RoundedCornerShape(HelmRadius.Pill))
            .padding(horizontal = HelmSpacing.Sm, vertical = HelmSpacing.Xs),
    )
}
