package com.potatomotato.helm.ui.keyboard

import android.view.KeyEvent
import com.potatomotato.helm.ui.components.SessionTab
import com.potatomotato.helm.voice.PttKeyBinding

/** The one shortcut map shared by the root workspace and the focused composer. */
internal object KeyMap {
    fun command(
        stroke: KeyStroke,
        binding: PttKeyBinding,
        pttHeld: Boolean = false,
        heldPttKeyCode: Int? = null,
        workspaceBlocked: Boolean = false,
        sessionViewFocused: Boolean = false,
        composerFocused: Boolean = false,
    ): KeyCommand? {
        pttCommand(stroke, binding, heldPttKeyCode ?: binding.keyCode.takeIf { pttHeld })?.let { return it }
        return workspaceCommand(stroke, sessionViewFocused, composerFocused, workspaceBlocked)
    }

    fun pttCommand(stroke: KeyStroke, binding: PttKeyBinding, heldPttKeyCode: Int? = null): KeyCommand? {
        if (!stroke.down && heldPttKeyCode != null && stroke.keyCode == heldPttKeyCode) {
            return KeyCommand.Ptt(down = false, keyCode = stroke.keyCode)
        }
        if (stroke.down && stroke.keyCode == binding.keyCode && binding.matchesPress(stroke)) {
            return if (stroke.repeatCount == 0) {
                KeyCommand.Ptt(down = true, keyCode = stroke.keyCode)
            } else {
                KeyCommand.Consume
            }
        }
        return null
    }

    fun workspaceCommand(
        stroke: KeyStroke,
        sessionViewFocused: Boolean,
        composerFocused: Boolean,
        workspaceBlocked: Boolean = false,
    ): KeyCommand? {
        if (!stroke.down || workspaceBlocked) return null
        val command = workspaceMapping(stroke, sessionViewFocused, composerFocused) ?: return null
        return if (stroke.repeatCount == 0) command else KeyCommand.Consume
    }

    private fun workspaceMapping(
        stroke: KeyStroke,
        sessionViewFocused: Boolean,
        composerFocused: Boolean,
    ): KeyCommand? {
        val plain = !stroke.ctrl && !stroke.shift && !stroke.alt && !stroke.meta
        if (plain && stroke.keyCode == KeyEvent.KEYCODE_ESCAPE && sessionViewFocused) return KeyCommand.StopSession

        val ctrlOnly = stroke.ctrl && !stroke.alt && !stroke.meta
        if (composerFocused && ctrlOnly && !stroke.shift && stroke.keyCode == KeyEvent.KEYCODE_ENTER) {
            return KeyCommand.SendComposer
        }
        if (ctrlOnly && stroke.keyCode == KeyEvent.KEYCODE_TAB) {
            return KeyCommand.CycleSessions(if (stroke.shift) -1 else 1)
        }
        if (ctrlOnly && !stroke.shift) {
            digitIndex(stroke.keyCode)?.let { return KeyCommand.SelectSession(it) }
        }
        if (stroke.alt && !stroke.ctrl && !stroke.shift && !stroke.meta) {
            digitIndex(stroke.keyCode)?.let { return KeyCommand.RunAction(it) }
        }
        if (ctrlOnly && stroke.shift) {
            return when (stroke.keyCode) {
                KeyEvent.KEYCODE_J -> KeyCommand.SelectSessionTab(SessionTab.Chat)
                KeyEvent.KEYCODE_A -> KeyCommand.SelectSessionTab(SessionTab.Artifacts)
                KeyEvent.KEYCODE_P -> KeyCommand.SelectSessionTab(SessionTab.Plans)
                KeyEvent.KEYCODE_S -> KeyCommand.FocusSessions
                KeyEvent.KEYCODE_K -> KeyCommand.FocusTodos
                KeyEvent.KEYCODE_N -> KeyCommand.NewSession
                KeyEvent.KEYCODE_R -> KeyCommand.RenameSession
                KeyEvent.KEYCODE_W -> KeyCommand.CloseSession
                else -> null
            }
        }
        return null
    }

    private fun digitIndex(keyCode: Int): Int? = when (keyCode) {
        KeyEvent.KEYCODE_0 -> 9
        in KeyEvent.KEYCODE_1..KeyEvent.KEYCODE_9 -> keyCode - KeyEvent.KEYCODE_1
        else -> null
    }

    private fun PttKeyBinding.matchesPress(stroke: KeyStroke): Boolean = when (this) {
        PttKeyBinding.AltSpace -> stroke.alt && !stroke.ctrl && !stroke.shift && !stroke.meta
        PttKeyBinding.RightControl -> !stroke.alt && !stroke.shift && !stroke.meta
        PttKeyBinding.Backtick -> !stroke.ctrl && !stroke.shift && !stroke.alt && !stroke.meta
    }
}
