package com.potatomotato.helm.data

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.provider.Settings
import java.net.Inet4Address

/** The value the local settings menu reads when it opens. */
internal data class WirelessAdbState(
    val supported: Boolean,
    val enabled: Boolean,
    val localIp: String?,
)

/** Result of a local toggle request; the UI owns the system-settings launch. */
internal sealed interface WirelessAdbToggleResult {
    data class Updated(val enabled: Boolean) : WirelessAdbToggleResult
    data object NeedsDeveloperOptions : WirelessAdbToggleResult
    data object Unsupported : WirelessAdbToggleResult
    data object Failed : WirelessAdbToggleResult
}

/** The small seam around the global setting and the device's current Wi-Fi address. */
internal interface WirelessAdbSettingsSink {
    fun readEnabled(): Boolean
    fun writeEnabled(enabled: Boolean): Boolean
    fun localWifiIp(): String?
}

/**
 * The only local UI path to Android's Wireless debugging setting.
 *
 * WHY: this capability changes device-wide developer settings, so it is kept
 * behind an Android UI action and has no link or wire dependency.
 */
internal class WirelessAdb(
    private val apiLevel: Int,
    private val hasWritePermission: () -> Boolean,
    private val settings: WirelessAdbSettingsSink,
) {
    constructor(context: Context) : this(
        apiLevel = Build.VERSION.SDK_INT,
        hasWritePermission = {
            context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED
        },
        settings = AndroidWirelessAdbSettingsSink(context.applicationContext),
    )

    fun readState(): WirelessAdbState {
        val supported = apiLevel >= Build.VERSION_CODES.R
        if (!supported) return WirelessAdbState(supported = false, enabled = false, localIp = null)

        val enabled = settings.readEnabled()
        return WirelessAdbState(
            supported = true,
            enabled = enabled,
            localIp = if (enabled) settings.localWifiIp() else null,
        )
    }

    fun toggle(): WirelessAdbToggleResult {
        if (apiLevel < Build.VERSION_CODES.R) return WirelessAdbToggleResult.Unsupported
        if (!hasWritePermission()) return WirelessAdbToggleResult.NeedsDeveloperOptions

        val enabled = !settings.readEnabled()
        return if (settings.writeEnabled(enabled)) {
            WirelessAdbToggleResult.Updated(enabled)
        } else {
            WirelessAdbToggleResult.Failed
        }
    }
}

private class AndroidWirelessAdbSettingsSink(context: Context) : WirelessAdbSettingsSink {
    private val resolver = context.contentResolver
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)

    override fun readEnabled(): Boolean =
        Settings.Global.getInt(resolver, ADB_WIFI_ENABLED, 0) == 1

    override fun writeEnabled(enabled: Boolean): Boolean =
        runCatching { Settings.Global.putInt(resolver, ADB_WIFI_ENABLED, if (enabled) 1 else 0) }
            .getOrDefault(false)

    @Suppress("DEPRECATION")
    override fun localWifiIp(): String? {
        val manager = connectivity ?: return null
        // WHY: inspect Wi-Fi even when VPN or another transport is the default route.
        return manager.allNetworks.asSequence()
            .filter { network ->
                manager.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            }
            .flatMap { network -> manager.getLinkProperties(network)?.linkAddresses.orEmpty().asSequence() }
            .mapNotNull { it.address as? Inet4Address }
            .firstOrNull { !it.isLoopbackAddress && !it.isLinkLocalAddress }
            ?.hostAddress
    }

    private companion object {
        const val ADB_WIFI_ENABLED = "adb_wifi_enabled"
    }
}
