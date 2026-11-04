package com.potatomotato.helm.ble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.potatomotato.helm.log.HelmLog

/**
 * BootReceiver — brings the peripheral back after a reboot or an app update.
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
        // An app update kills the service exactly as a reboot does, and is the same exemption.
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        HelmLog.i(HelmLog.BLE, "${intent.action}; starting the link service")
        HelmLinkService.start(context)
    }
}
