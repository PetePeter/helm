package com.potatomotato.helm.lan

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

/**
 * The seam between [LanLinkController] and Android's connectivity callbacks.
 *
 * WHY: the Bluetooth-triggered dial usually runs before wifi has an address,
 * and the redial timer alone reacts up to a minute late. A network coming up is
 * the exact moment a dial can first succeed. Kept to two calls so the
 * controller's policy stays testable on the JVM with a hand-fired fake.
 */
interface NetworkWatcher {
    /** Begin reporting. [onChange] may fire from any thread, in bursts. */
    fun start(onChange: () -> Unit)

    /** Stop reporting. Idempotent. */
    fun stop()
}

/**
 * The real watcher: Wi-Fi and Ethernet only, the transports a desktop on the
 * home network can be reached over. Cellular changes never make LAN reachable.
 * ACCESS_NETWORK_STATE is a normal permission, granted at install.
 */
class AndroidNetworkWatcher(context: Context) : NetworkWatcher {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null

    override fun start(onChange: () -> Unit) {
        val manager = connectivity ?: return
        if (callback != null) return
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .build()
        val registered = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = onChange()

            // An address arriving after onAvailable (DHCP) is when a dial can work.
            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) = onChange()
        }
        runCatching { manager.registerNetworkCallback(request, registered) }
            .onSuccess { callback = registered }
    }

    override fun stop() {
        val registered = callback ?: return
        callback = null
        runCatching { connectivity?.unregisterNetworkCallback(registered) }
    }
}
