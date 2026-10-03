package com.potatomotato.helm.voice

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/** Filters ThinkPhone's KEY_SEARCH Red Key while a HELM voice call is in PTT mode. */
class RedKeyPttAccessibilityService : AccessibilityService() {
    private var redKeyCaptured = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        serviceInfo = serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS
        }
        connected = true
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode != KeyEvent.KEYCODE_SEARCH) return false
        if (event.action == KeyEvent.ACTION_DOWN && VoiceCallService.call.value?.state?.micMode == MicMode.PushToTalk) {
            redKeyCaptured = true
            VoiceCallService.setPttKeyHeld(this, true)
            return true
        }
        if (event.action == KeyEvent.ACTION_UP && redKeyCaptured) {
            redKeyCaptured = false
            VoiceCallService.setPttKeyHeld(this, false)
            return true
        }
        return false
    }

    override fun onInterrupt() = releaseCapturedKey()

    override fun onUnbind(intent: Intent?): Boolean {
        connected = false
        releaseCapturedKey()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        connected = false
        releaseCapturedKey()
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    private fun releaseCapturedKey() {
        if (!redKeyCaptured) return
        redKeyCaptured = false
        VoiceCallService.setPttKeyHeld(this, false)
    }

    companion object {
        @Volatile
        var connected: Boolean = false
            private set

    }
}
