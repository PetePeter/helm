package com.potatomotato.helm.ui.keyboard

import android.view.KeyEvent
import com.potatomotato.helm.ui.Destination
import com.potatomotato.helm.voice.PttKeyBinding
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyboardWorkspaceGateTest {
    @Test
    fun `an active in-window modal blocks workspace shortcuts`() {
        val blocked = workspaceShortcutsBlocked(
            activeInWindowModalCount = 1,
            todosSheetOpen = false,
            destination = Destination.Thread,
            actionDialogOpen = false,
        )

        assertTrue(blocked)
        assertNull(
            KeyMap.workspaceCommand(
                stroke = KeyStroke(KeyEvent.KEYCODE_N, down = true, repeatCount = 0, ctrl = true, shift = true),
                sessionViewFocused = true,
                composerFocused = false,
                workspaceBlocked = blocked,
            ),
        )
    }

    @Test
    fun `PTT down and up still pass through the modal gate`() {
        val blocked = workspaceShortcutsBlocked(
            activeInWindowModalCount = 1,
            todosSheetOpen = false,
            destination = Destination.Thread,
            actionDialogOpen = false,
        )
        val binding = PttKeyBinding.AltSpace

        assertEquals(
            KeyCommand.Ptt(down = true, keyCode = KeyEvent.KEYCODE_SPACE),
            KeyMap.command(
                stroke = KeyStroke(KeyEvent.KEYCODE_SPACE, true, 0, ctrl = false, shift = false, alt = true, meta = false),
                binding = binding,
                workspaceBlocked = blocked,
            ),
        )
        assertEquals(
            KeyCommand.Ptt(down = false, keyCode = KeyEvent.KEYCODE_SPACE),
            KeyMap.command(
                stroke = KeyStroke(KeyEvent.KEYCODE_SPACE, false, 0, ctrl = false, shift = false, alt = true, meta = false),
                binding = binding,
                pttHeld = true,
                workspaceBlocked = blocked,
            ),
        )
    }
}
