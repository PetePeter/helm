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
    /**
     * Begin reporting. Both may fire from any thread, in bursts.
     *
     * [onChange] is every event a dial could be waiting on, an address arriving
     * included. [onAppeared] is only a NETWORK appearing — the narrower event
     * that is worth restarting a whole search for. They are kept apart because
     * some networks re-announce their properties every few minutes, and a
     * search re-armed by that would never be allowed to give up.
     */
    fun start(onChange: () -> Unit, onAppeared: () -> Unit = {})

    /** Stop reporting. Idempotent. */
    fun stop()
}

/**
 * The real watcher: Wi-Fi, Ethernet and VPN — the transports a desktop can be
 * reached over. Cellular changes alone never make it reachable; a VPN coming
 * up over cellular does, which is why VPN is watched in its own right.
 * ACCESS_NETWORK_STATE is a normal permission, granted at install.
 */
class AndroidNetworkWatcher(context: Context) : NetworkWatcher {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null

    override fun start(onChange: () -> Unit, onAppeared: () -> Unit) {
        val manager = connectivity ?: return
        if (callback != null) return
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .addTransportType(NetworkCapabilities.TRANSPORT_VPN)
            // A request asks for NOT_VPN unless told otherwise, which would
            // hide every VPN network from the transport just added.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        val registered = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                onAppeared()
                onChange()
            }

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
