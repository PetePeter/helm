package com.potatomotato.helm.ui.control

import com.potatomotato.helm.R
import com.potatomotato.helm.data.Capabilities
import com.potatomotato.helm.data.SessionAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionSheetActionsTest {
    private val allTools = Capabilities.Known(SessionAction.entries.map { it.tool }.toSet())

    @Test
    fun `phone sheet keeps its action groups and order`() {
        val model = sessionActions(keepWarm = false, frozen = false, capabilities = allTools)

        assertEquals(
            listOf(
                SessionActionCategory.CHAT to listOf(SessionAction.Call, SessionAction.Stop, SessionAction.Snapshot),
                SessionActionCategory.CONTEXT to
                    listOf(SessionAction.HelmCompact, SessionAction.Compact, SessionAction.Clear),
                SessionActionCategory.SESSION to listOf(
                    SessionAction.Rename,
                    SessionAction.SwitchCli,
                    SessionAction.KeepWarmOn,
                    SessionAction.Freeze,
                    SessionAction.Clone,
                    SessionAction.Spawn,
                    SessionAction.Close,
                ),
            ),
            model.phoneGroups.map { it.category to it.actions.map(SessionActionEntry::action) },
        )
    }

    @Test
    fun `tablet actions are flat in group order and reuse the phone Stop entry`() {
        val model = sessionActions(keepWarm = false, frozen = false, capabilities = allTools)

        assertEquals(
            listOf(
                SessionActionBarGroup.CONTEXT to
                    listOf(SessionAction.HelmCompact, SessionAction.Compact, SessionAction.Clear),
                SessionActionBarGroup.FLOW to listOf(SessionAction.Stop, SessionAction.KeepWarmOn, SessionAction.Freeze),
                SessionActionBarGroup.SESSION to listOf(
                    SessionAction.SwitchCli,
                    SessionAction.Clone,
                    SessionAction.Snapshot,
                    SessionAction.Rename,
                    SessionAction.Close,
                ),
            ),
            model.barGroups.map { it.group to it.actions.map(SessionActionEntry::action) },
        )
        assertEquals(
            listOf(
                SessionAction.HelmCompact,
                SessionAction.Compact,
                SessionAction.Clear,
                SessionAction.Stop,
                SessionAction.KeepWarmOn,
                SessionAction.Freeze,
                SessionAction.SwitchCli,
                SessionAction.Clone,
                SessionAction.Snapshot,
                SessionAction.Rename,
                SessionAction.Close,
            ),
            model.barActions.map(SessionActionEntry::action),
        )
        assertFalse(model.barActions.any { it.action == SessionAction.Call || it.action == SessionAction.Spawn })
        assertSame(
            model.phoneGroups.flatMap { it.actions }.single { it.action == SessionAction.Stop },
            model.barActions.single { it.action == SessionAction.Stop },
        )
    }

    @Test
    fun `keep-warm and freeze entries carry current state and inverse action labels`() {
        val idle = sessionActions(keepWarm = false, frozen = false, capabilities = allTools)
        val active = sessionActions(keepWarm = true, frozen = true, capabilities = allTools)

        assertEquals(SessionAction.KeepWarmOn, idle.entry(SessionAction.KeepWarmOn).action)
        assertEquals(false, idle.entry(SessionAction.KeepWarmOn).toggleEnabled)
        assertEquals(R.string.control_action_keep_warm, idle.entry(SessionAction.KeepWarmOn).labelRes)
        assertEquals(SessionAction.KeepWarmOff, active.entry(SessionAction.KeepWarmOff).action)
        assertEquals(true, active.entry(SessionAction.KeepWarmOff).toggleEnabled)
        assertEquals(R.string.control_action_stop_keep_warm, active.entry(SessionAction.KeepWarmOff).labelRes)

        assertEquals(SessionAction.Freeze, idle.entry(SessionAction.Freeze).action)
        assertEquals(false, idle.entry(SessionAction.Freeze).toggleEnabled)
        assertEquals(R.string.control_action_freeze, idle.entry(SessionAction.Freeze).labelRes)
        assertEquals(SessionAction.Unfreeze, active.entry(SessionAction.Unfreeze).action)
        assertEquals(true, active.entry(SessionAction.Unfreeze).toggleEnabled)
        assertEquals(R.string.control_action_unfreeze, active.entry(SessionAction.Unfreeze).labelRes)
    }

    @Test
    fun `entry permission distinguishes an unknown capability from a denial`() {
        val unknown = sessionActions(keepWarm = false, frozen = false, capabilities = Capabilities.Unknown)
            .entry(SessionAction.Stop)
        val denied = sessionActions(
            keepWarm = false,
            frozen = false,
            capabilities = Capabilities.Known(emptySet()),
        ).entry(SessionAction.Stop)
        val allowed = sessionActions(
            keepWarm = false,
            frozen = false,
            capabilities = Capabilities.Known(setOf(SessionAction.Stop.tool)),
        ).entry(SessionAction.Stop)

        assertFalse(unknown.permitted)
        assertFalse(unknown.capabilityAnswered)
        assertFalse(denied.permitted)
        assertTrue(denied.capabilityAnswered)
        assertTrue(allowed.permitted)
        assertTrue(allowed.capabilityAnswered)
    }

    @Test
    fun `model owns notice copy for each action shared by the bar and sheet`() {
        val model = sessionActions(keepWarm = false, frozen = false, capabilities = allTools)

        assertEquals(R.string.control_notice_done_stop, model.entry(SessionAction.Stop).noticeRes)
        assertEquals(R.string.control_notice_done_close, model.entry(SessionAction.Close).noticeRes)
        assertEquals(R.string.snapshot_title, model.entry(SessionAction.Snapshot).noticeRes)
    }
}
