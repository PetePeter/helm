package com.potatomotato.helm.ui.keyboard

import android.view.KeyEvent
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.voice.PttKeyBinding
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class KeyMapTest {
    @Test
    fun `desktop chords map to session navigation tabs and actions`() {
        assertEquals(KeyCommand.CycleSessions(1), command(KeyEvent.KEYCODE_TAB, ctrl = true))
        assertEquals(KeyCommand.CycleSessions(-1), command(KeyEvent.KEYCODE_TAB, ctrl = true, shift = true))
        assertEquals(KeyCommand.SelectSession(0), command(KeyEvent.KEYCODE_1, ctrl = true))
        assertEquals(KeyCommand.SelectSession(9), command(KeyEvent.KEYCODE_0, ctrl = true))
        assertEquals(KeyCommand.RunAction(0), command(KeyEvent.KEYCODE_1, alt = true))
        assertEquals(KeyCommand.RunAction(9), command(KeyEvent.KEYCODE_0, alt = true))
        assertEquals(KeyCommand.SelectSessionTab(SessionTab.Chat), command(KeyEvent.KEYCODE_J, ctrl = true, shift = true))
        assertEquals(KeyCommand.SelectSessionTab(SessionTab.Artifacts), command(KeyEvent.KEYCODE_A, ctrl = true, shift = true))
        assertEquals(KeyCommand.SelectSessionTab(SessionTab.Plans), command(KeyEvent.KEYCODE_P, ctrl = true, shift = true))
        assertEquals(KeyCommand.FocusSessions, command(KeyEvent.KEYCODE_S, ctrl = true, shift = true))
        assertEquals(KeyCommand.FocusTodos, command(KeyEvent.KEYCODE_K, ctrl = true, shift = true))
        assertEquals(KeyCommand.NewSession, command(KeyEvent.KEYCODE_N, ctrl = true, shift = true))
        assertEquals(KeyCommand.RenameSession, command(KeyEvent.KEYCODE_R, ctrl = true, shift = true))
        assertEquals(KeyCommand.CloseSession, command(KeyEvent.KEYCODE_W, ctrl = true, shift = true))
    }

    @Test
    fun `composer send differs from normal Enter`() {
        assertNull(command(KeyEvent.KEYCODE_ENTER, ctrl = true))
        assertEquals(KeyCommand.SendComposer, command(KeyEvent.KEYCODE_ENTER, ctrl = true, composerFocused = true))
        assertNull(command(KeyEvent.KEYCODE_ENTER, composerFocused = true))
    }

    @Test
    fun `PTT key down ignores repeats and release passes through a modal`() {
        val binding = PttKeyBinding.AltSpace
        assertEquals(KeyCommand.Ptt(true, KeyEvent.KEYCODE_SPACE), command(KeyEvent.KEYCODE_SPACE, alt = true, binding = binding))
        assertEquals(KeyCommand.Consume, command(KeyEvent.KEYCODE_SPACE, alt = true, repeatCount = 1, binding = binding))
        assertEquals(
            KeyCommand.Ptt(false, KeyEvent.KEYCODE_SPACE),
            KeyMap.command(stroke(KeyEvent.KEYCODE_SPACE, down = false), binding, pttHeld = true, workspaceBlocked = true),
        )
        assertEquals(
            KeyCommand.Ptt(true, KeyEvent.KEYCODE_CTRL_RIGHT),
            command(KeyEvent.KEYCODE_CTRL_RIGHT, binding = PttKeyBinding.RightControl),
        )
        assertEquals(
            KeyCommand.Ptt(true, KeyEvent.KEYCODE_GRAVE),
            command(KeyEvent.KEYCODE_GRAVE, binding = PttKeyBinding.Backtick),
        )
    }

    @Test
    fun `reserved keys and unrelated text keys are unmapped`() {
        assertNull(command(KeyEvent.KEYCODE_SPACE, ctrl = true))
        assertNull(command(KeyEvent.KEYCODE_SPACE, ctrl = true, shift = true))
        assertNull(command(KeyEvent.KEYCODE_N, meta = true))
        assertNull(command(KeyEvent.KEYCODE_B, ctrl = true))
        assertEquals(KeyCommand.Consume, command(KeyEvent.KEYCODE_N, ctrl = true, shift = true, repeatCount = 1))
    }

    @Test
    fun `workspace shortcuts are blocked in a modal and Escape only stops a session view`() {
        assertNull(command(KeyEvent.KEYCODE_N, ctrl = true, shift = true, workspaceBlocked = true))
        assertNull(command(KeyEvent.KEYCODE_ESCAPE, sessionViewFocused = false))
        assertEquals(KeyCommand.StopSession, command(KeyEvent.KEYCODE_ESCAPE, sessionViewFocused = true))
        assertNull(command(KeyEvent.KEYCODE_ESCAPE, workspaceBlocked = true, sessionViewFocused = true))
    }

    private fun command(
        keyCode: Int,
        ctrl: Boolean = false,
        shift: Boolean = false,
        alt: Boolean = false,
        meta: Boolean = false,
        repeatCount: Int = 0,
        binding: PttKeyBinding = PttKeyBinding.AltSpace,
        workspaceBlocked: Boolean = false,
        sessionViewFocused: Boolean = false,
        composerFocused: Boolean = false,
    ) = KeyMap.command(
        stroke(keyCode, ctrl, shift, alt, meta, repeatCount),
        binding,
        workspaceBlocked = workspaceBlocked,
        sessionViewFocused = sessionViewFocused,
        composerFocused = composerFocused,
    )

    private fun stroke(
        keyCode: Int,
        ctrl: Boolean = false,
        shift: Boolean = false,
        alt: Boolean = false,
        meta: Boolean = false,
        repeatCount: Int = 0,
        down: Boolean = true,
    ) = KeyStroke(keyCode, down, repeatCount, ctrl, shift, alt, meta)
}
