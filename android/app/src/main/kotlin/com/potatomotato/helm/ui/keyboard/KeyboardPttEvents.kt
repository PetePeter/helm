package com.potatomotato.helm.ui.keyboard

import android.content.Context
import android.view.KeyEvent
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.remember
import com.potatomotato.helm.voice.PttKey
import com.potatomotato.helm.voice.PttKeyBindingStore
import com.potatomotato.helm.voice.sharedPttKeyBindingStore

/** One held-key tracker and dispatch path for Activity, workspace, and popup windows. */
internal object KeyboardPttEvents {
    private var heldKeyCode: Int? = null

    fun handle(context: Context, event: KeyEvent, bindingStore: PttKeyBindingStore): Boolean {
        val command = KeyMap.pttCommand(
            stroke = event.toKeyStroke(),
            binding = bindingStore.read(),
            heldPttKeyCode = heldKeyCode,
        ) ?: return false

        when (command) {
            is KeyCommand.Ptt -> {
                heldKeyCode = command.keyCode.takeIf { command.down }
                PttKey.press(context, command.down)
            }
            KeyCommand.Consume -> Unit
            else -> return false
        }
        return true
    }

    fun clearHeldKey() {
        heldKeyCode = null
    }
}

/** Installs the same PTT path on Compose popup/dialog windows as on the Activity. */
internal fun Modifier.keyboardPttEvents(bindingStore: PttKeyBindingStore? = null): Modifier = composed {
    val context = LocalContext.current
    val store = bindingStore ?: remember(context) { sharedPttKeyBindingStore(context) }
    onPreviewKeyEvent { event ->
        KeyboardPttEvents.handle(context, event.nativeKeyEvent, store)
    }
}
