package com.potatomotato.helm.ui.operator

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import com.potatomotato.helm.MainActivity
import com.potatomotato.helm.voice.VoiceCallService

/**
 * "Helm - Operator": the launcher entry and shortcut a hardware key launches.
 * A launcher launch into a running Helm only brings its task forward — no
 * intent reaches MainActivity — so the press is parked here, in an invisible
 * activity of its own task that always gets created, then Helm is brought up.
 * The lock screen is weighed here ([KeyPress.gate]); shown over it so the
 * system unlock prompt can be asked for.
 */
class CallOperatorActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // API 26 has no setShowWhenLocked; there the unlock prompt still appears over the keyguard.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) setShowWhenLocked(true)
        val keyguard = getSystemService(KeyguardManager::class.java)
        val press = KeyPress.gate(
            locked = keyguard.isKeyguardLocked,
            inCall = VoiceCallService.call.value != null,
            now = SystemClock.elapsedRealtime(),
            callEndedAt = OperatorKey.callEndedAt,
            screenOffAt = OperatorKey.screenOffAt,
        )
        when (press) {
            KeyPress.HangUp -> {
                VoiceCallService.hangUp(this)
                finish()
            }
            is KeyPress.Open -> open(press.overLockScreen)
            KeyPress.Unlock -> keyguard.requestDismissKeyguard(
                this,
                object : KeyguardManager.KeyguardDismissCallback() {
                    override fun onDismissSucceeded() = open(overLockScreen = false)
                    override fun onDismissCancelled() = finish()
                    override fun onDismissError() = finish()
                },
            )
        }
    }

    private fun open(overLockScreen: Boolean) {
        OperatorKey.request(overLockScreen)
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
        )
        finish()
    }
}
