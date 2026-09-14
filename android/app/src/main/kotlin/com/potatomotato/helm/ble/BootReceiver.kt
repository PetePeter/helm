package com.potatomotato.helm.ble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.potatomotato.helm.log.HelmLog

/**
 * BootReceiver — brings the peripheral back after a reboot.
 *
 * WHY: being reachable without touching the phone is the whole point of the
 * app, and a reboot is the one event that silently kills the foreground
 * service. The receiver is deliberately dumb: it starts [HelmLinkService] and
 * lets the service's own recovery path handle a radio that is not up yet (the
 * STATE_ON broadcast can land after BOOT_COMPLETED).
 *
 * Android refuses to start a foreground service from the background in general,
 * but BOOT_COMPLETED is an explicit exemption. A force-stopped app gets nothing
 * at all — that is Android's design, not ours to work around.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        HelmLog.i(HelmLog.BLE, "boot completed; starting the link service")
        HelmLinkService.start(context)
    }
}
