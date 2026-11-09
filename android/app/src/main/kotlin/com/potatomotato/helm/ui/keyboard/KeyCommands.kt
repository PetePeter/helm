package com.potatomotato.helm.ui.keyboard

import androidx.compose.ui.input.key.KeyEvent as ComposeKeyEvent
import android.view.KeyEvent as AndroidKeyEvent
import com.potatomotato.helm.ui.components.SessionTab

internal data class KeyStroke(
    val keyCode: Int,
    val down: Boolean,
    val repeatCount: Int = 0,
    val ctrl: Boolean = false,
    val shift: Boolean = false,
    val alt: Boolean = false,
    val meta: Boolean = false,
)

internal sealed interface KeyCommand {
    data class Ptt(val down: Boolean, val keyCode: Int) : KeyCommand
    data class CycleSessions(val direction: Int) : KeyCommand
    data class SelectSession(val index: Int) : KeyCommand
    data class RunAction(val index: Int) : KeyCommand
    data class SelectSessionTab(val tab: SessionTab) : KeyCommand
    data object FocusSessions : KeyCommand
    data object FocusTodos : KeyCommand
    data object NewSession : KeyCommand
    data object RenameSession : KeyCommand
    data object CloseSession : KeyCommand
    data object StopSession : KeyCommand
    data object SendComposer : KeyCommand
    data object Consume : KeyCommand
}

internal fun ComposeKeyEvent.toKeyStroke(): KeyStroke {
    val event = nativeKeyEvent
    return KeyStroke(
        keyCode = event.keyCode,
        down = event.action == android.view.KeyEvent.ACTION_DOWN,
        repeatCount = event.repeatCount,
        ctrl = event.isCtrlPressed,
        shift = event.isShiftPressed,
        alt = event.isAltPressed,
        meta = event.isMetaPressed,
    )
}

internal fun AndroidKeyEvent.toKeyStroke(): KeyStroke = KeyStroke(
    keyCode = keyCode,
    down = action == AndroidKeyEvent.ACTION_DOWN,
    repeatCount = repeatCount,
    ctrl = isCtrlPressed,
    shift = isShiftPressed,
    alt = isAltPressed,
    meta = isMetaPressed,
)
