package com.potatomotato.helm.ui.control

import androidx.compose.ui.graphics.Color
import com.potatomotato.helm.R
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.answered
import com.potatomotato.helm.data.permits
import com.potatomotato.helm.ui.theme.HelmColors

/**
 * The sheet's order, top to bottom: talking to it, what it remembers, the session itself.
 *
 * The mildest action is first inside a group; the one that loses the most sits last,
 * furthest from the reading position.
 */
internal enum class SessionActionCategory(val titleRes: Int) {
    CHAT(R.string.control_group_chat),
    CONTEXT(R.string.control_group_context),
    SESSION(R.string.control_group_session),
}

/** The tablet bar's three compact groups, in display and keyboard order. */
internal enum class SessionActionBarGroup(val titleRes: Int) {
    CONTEXT(R.string.control_group_context),
    FLOW(R.string.control_group_flow),
    SESSION(R.string.control_group_session),
}

internal data class SessionActionConfirmation(
    val messageRes: Int,
    val yesRes: Int,
    val noRes: Int,
    val confirmColor: Color,
)

internal data class SessionActionEntry(
    val action: SessionAction,
    val glyphRes: Int,
    val labelRes: Int,
    val phoneCategory: SessionActionCategory?,
    val barGroup: SessionActionBarGroup?,
    /** Current state; the action ID and label describe the next toggle operation. */
    val toggleEnabled: Boolean?,
    val confirmation: SessionActionConfirmation?,
    val noticeRes: Int,
    val permitted: Boolean,
    val capabilityAnswered: Boolean,
)

internal data class SessionActionGroup(
    val category: SessionActionCategory,
    val actions: List<SessionActionEntry>,
)

internal data class SessionActionBarGroupEntries(
    val group: SessionActionBarGroup,
    val actions: List<SessionActionEntry>,
)

/** One action catalogue projected into the existing phone groups and the flat tablet order. */
internal data class SessionActions(
    val entries: Map<SessionAction, SessionActionEntry>,
    val phoneGroups: List<SessionActionGroup>,
    val barGroups: List<SessionActionBarGroupEntries>,
) {
    /** Flat on purpose: keyboard shortcuts can address this same stable order. */
    val barActions: List<SessionActionEntry> get() = barGroups.flatMap { it.actions }

    fun entry(action: SessionAction): SessionActionEntry = entries.getValue(action)
}

internal fun sessionActions(
    keepWarm: Boolean,
    frozen: Boolean,
    capabilities: Capabilities,
): SessionActions {
    // These presentation sequences only reference the shared entries below; labels,
    // confirmations, notices, and permission decisions stay in one action model.
    val phoneDefinitions = listOf(
        SessionActionCategory.CHAT to listOf(SessionAction.Call, SessionAction.Stop, SessionAction.Snapshot),
        SessionActionCategory.CONTEXT to listOf(SessionAction.HelmCompact, SessionAction.Compact, SessionAction.Clear),
        SessionActionCategory.SESSION to listOf(
            SessionAction.Rename,
            SessionAction.SwitchCli,
            if (keepWarm) SessionAction.KeepWarmOff else SessionAction.KeepWarmOn,
            if (frozen) SessionAction.Unfreeze else SessionAction.Freeze,
            SessionAction.Clone,
            SessionAction.Spawn,
            SessionAction.Close,
        ),
    )
    val barDefinitions = listOf(
        SessionActionBarGroup.CONTEXT to listOf(SessionAction.HelmCompact, SessionAction.Compact, SessionAction.Clear),
        SessionActionBarGroup.FLOW to listOf(
            SessionAction.Stop,
            if (keepWarm) SessionAction.KeepWarmOff else SessionAction.KeepWarmOn,
            if (frozen) SessionAction.Unfreeze else SessionAction.Freeze,
        ),
        SessionActionBarGroup.SESSION to listOf(
            SessionAction.SwitchCli,
            SessionAction.Clone,
            SessionAction.Snapshot,
            SessionAction.Rename,
            SessionAction.Close,
        ),
    )
    val phoneCategoryByAction = phoneDefinitions.flatMap { (category, actions) -> actions.map { it to category } }.toMap()
    val barGroupByAction = barDefinitions.flatMap { (group, actions) -> actions.map { it to group } }.toMap()
    val actionIds = (phoneDefinitions.flatMap { it.second } + barDefinitions.flatMap { it.second }).distinct()
    val entries = actionIds.associateWith { action ->
        val toggleEnabled = when (action) {
            SessionAction.KeepWarmOn, SessionAction.KeepWarmOff -> keepWarm
            SessionAction.Freeze, SessionAction.Unfreeze -> frozen
            else -> null
        }
        SessionActionEntry(
            action = action,
            glyphRes = action.glyphRes,
            labelRes = action.labelRes,
            phoneCategory = phoneCategoryByAction[action],
            barGroup = barGroupByAction[action],
            toggleEnabled = toggleEnabled,
            confirmation = action.confirmation,
            noticeRes = action.noticeRes,
            permitted = capabilities.permits(action),
            capabilityAnswered = capabilities.answered,
        )
    }
    val phoneGroups = phoneDefinitions.map { (category, actions) ->
        SessionActionGroup(category, actions.map(entries::getValue))
    }
    val barGroups = barDefinitions.map { (group, actions) ->
        SessionActionBarGroupEntries(group, actions.map(entries::getValue))
    }
    return SessionActions(entries, phoneGroups, barGroups)
}

/**
 * Only what is hard to undo confirms, and each prompt names the session, because
 * "are you sure?" answers nothing. Prompting on every action trains people to
 * tap through the one that matters.
 */
internal fun requiresConfirmation(action: SessionAction): Boolean = action.confirmation != null

/** The prompt copy and its tone live beside the action definition consumed by both presenters. */
internal val SessionAction.confirmation: SessionActionConfirmation?
    get() = when (this) {
        SessionAction.Close -> SessionActionConfirmation(
            messageRes = R.string.control_confirm_close,
            yesRes = R.string.control_confirm_close_yes,
            noRes = R.string.control_confirm_close_no,
            confirmColor = HelmColors.Danger,
        )
        SessionAction.Compact -> SessionActionConfirmation(
            messageRes = R.string.control_confirm_compact,
            yesRes = R.string.control_confirm_compact_yes,
            noRes = R.string.control_confirm_compact_no,
            confirmColor = HelmColors.Accent,
        )
        SessionAction.HelmCompact -> SessionActionConfirmation(
            messageRes = R.string.control_confirm_helm_compact,
            yesRes = R.string.control_confirm_helm_compact_yes,
            noRes = R.string.control_confirm_compact_no,
            confirmColor = HelmColors.Accent,
        )
        // Danger, not Accent: unlike a compact, nothing of the conversation survives.
        SessionAction.Clear -> SessionActionConfirmation(
            messageRes = R.string.control_confirm_clear,
            yesRes = R.string.control_confirm_clear_yes,
            noRes = R.string.control_confirm_clear_no,
            confirmColor = HelmColors.Danger,
        )
        else -> null
    }

/** The label colour: dim when unavailable, danger for the ones that destroy. */
internal fun SessionAction.labelColor(permitted: Boolean): Color = when {
    !permitted -> HelmColors.Faint
    this == SessionAction.Close || this == SessionAction.DeleteArtifact -> HelmColors.Danger
    else -> HelmColors.Txt
}

/**
 * Shared with the artifacts screens, whose rows are the same action shape drawn
 * in a list rather than a sheet: one definition, so a label or glyph cannot
 * drift between the two surfaces.
 */
internal val SessionAction.labelRes: Int
    get() = when (this) {
        SessionAction.Snapshot -> R.string.control_action_snapshot
        SessionAction.Artifacts -> R.string.control_action_artifacts
        SessionAction.Rename -> R.string.control_action_rename
        SessionAction.Compact -> R.string.control_action_compact
        SessionAction.Clear -> R.string.control_action_clear
        SessionAction.HelmCompact -> R.string.control_action_helm_compact
        SessionAction.SwitchCli -> R.string.control_action_switch_cli
        SessionAction.Clone -> R.string.control_action_clone
        SessionAction.Stop -> R.string.control_action_stop
        SessionAction.KeepWarmOn -> R.string.control_action_keep_warm
        SessionAction.KeepWarmOff -> R.string.control_action_stop_keep_warm
        SessionAction.Freeze -> R.string.control_action_freeze
        SessionAction.Unfreeze -> R.string.control_action_unfreeze
        SessionAction.Spawn -> R.string.control_action_spawn
        SessionAction.Close -> R.string.control_action_close
        SessionAction.Call -> R.string.control_action_call
        SessionAction.CreateArtifact -> R.string.artifacts_action_new
        SessionAction.ReviseArtifact -> R.string.artifacts_action_revise
        SessionAction.SetArtifactIntent -> R.string.artifacts_action_revise
        SessionAction.SaveArtifact -> R.string.artifacts_action_save
        SessionAction.DeleteArtifact -> R.string.artifacts_action_delete
    }

internal val SessionAction.glyphRes: Int
    get() = when (this) {
        SessionAction.Snapshot -> R.string.control_glyph_snapshot
        SessionAction.Artifacts -> R.string.control_glyph_artifacts
        SessionAction.Rename -> R.string.control_glyph_rename
        SessionAction.Compact -> R.string.control_glyph_compact
        SessionAction.Clear -> R.string.control_glyph_clear
        SessionAction.HelmCompact -> R.string.control_glyph_helm_compact
        SessionAction.SwitchCli -> R.string.control_glyph_switch_cli
        SessionAction.Clone -> R.string.control_glyph_clone
        SessionAction.Stop -> R.string.control_glyph_stop
        SessionAction.KeepWarmOn, SessionAction.KeepWarmOff -> R.string.control_glyph_keep_warm
        SessionAction.Freeze, SessionAction.Unfreeze -> R.string.control_glyph_freeze
        SessionAction.Spawn -> R.string.control_glyph_spawn
        SessionAction.Close -> R.string.control_glyph_close
        SessionAction.Call -> R.string.control_glyph_call
        SessionAction.CreateArtifact -> R.string.artifacts_glyph_new
        SessionAction.ReviseArtifact -> R.string.artifacts_glyph_revise
        SessionAction.SetArtifactIntent -> R.string.artifacts_glyph_revise
        SessionAction.SaveArtifact -> R.string.artifacts_glyph_save
        SessionAction.DeleteArtifact -> R.string.artifacts_glyph_delete
    }

/** Success is stated in the past tense of the thing that happened, never "OK". */
internal val SessionAction.noticeRes: Int
    get() = when (this) {
        SessionAction.Rename -> R.string.control_notice_done_rename
        SessionAction.Compact -> R.string.control_notice_done_compact
        SessionAction.Clear -> R.string.control_notice_done_clear
        SessionAction.HelmCompact -> R.string.control_notice_done_helm_compact
        SessionAction.SwitchCli -> R.string.control_notice_done_switch_cli
        SessionAction.Clone -> R.string.control_notice_done_clone
        SessionAction.Stop -> R.string.control_notice_done_stop
        SessionAction.KeepWarmOn -> R.string.control_notice_done_keep_warm
        SessionAction.KeepWarmOff -> R.string.control_notice_done_stop_keep_warm
        SessionAction.Freeze -> R.string.control_notice_done_freeze
        SessionAction.Unfreeze -> R.string.control_notice_done_unfreeze
        SessionAction.Close -> R.string.control_notice_done_close
        SessionAction.Spawn -> R.string.control_notice_done_spawn
        // Snapshot and artifact rows report themselves on their own screens.
        SessionAction.CreateArtifact -> R.string.artifacts_notice_done_create
        SessionAction.ReviseArtifact -> R.string.artifacts_notice_done_revise
        SessionAction.SetArtifactIntent -> R.string.artifacts_notice_done_revise
        SessionAction.SaveArtifact -> R.string.artifacts_notice_done_save
        SessionAction.DeleteArtifact -> R.string.artifacts_notice_done_delete
        SessionAction.Snapshot -> R.string.snapshot_title
        SessionAction.Artifacts -> R.string.artifacts_title
        SessionAction.Call -> R.string.call_title
    }
