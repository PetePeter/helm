package com.potatomotato.helm.ble

import android.Manifest
import android.content.Context
import android.os.Build
import com.potatomotato.helm.Permissions

/**
 * The runtime permissions the link needs, and nothing more.
 *
 * BLUETOOTH_SCAN is absent on purpose — a pure peripheral never scans, and it is
 * location-adjacent, so asking for it would cost the user a worse prompt for
 * nothing. See the manifest comment.
 *
 * Denial is not a crash: [MainActivity] shows an explanatory screen and the
 * service simply never comes up.
 */
object BlePermissions {
    /** Requested together, because the link needs all of them to be useful. */
    val required: List<String> = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_ADVERTISE)
            add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    fun missing(context: Context): List<String> = Permissions.missing(context, required)

    fun allGranted(context: Context): Boolean = Permissions.allGranted(context, required)
}
