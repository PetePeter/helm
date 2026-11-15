package com.potatomotato.helm.data

import android.content.Context
import android.net.wifi.WifiManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ext.SdkExtensions
import java.util.ArrayDeque

/** Resolves the current Wireless debugging endpoint while the settings menu is visible. */
internal fun interface WirelessAdbPortResolver {
    fun discover(localIp: String, onPortChanged: (Int?) -> Unit): AutoCloseable
}

/** ADB advertises a dynamic TLS port over DNS-SD; only accept the service on this phone's IP. */
internal class AndroidWirelessAdbPortResolver(context: Context) : WirelessAdbPortResolver {
    private val appContext = context.applicationContext
    private val nsd = appContext.getSystemService(NsdManager::class.java)

    override fun discover(localIp: String, onPortChanged: (Int?) -> Unit): AutoCloseable {
        val manager = nsd ?: return AutoCloseable { }
        val multicastLock = createMulticastLockIfNeeded(appContext)
        return NsdDiscovery(manager, multicastLock, localIp, onPortChanged).also(NsdDiscovery::start)
    }

    private class NsdDiscovery(
        private val manager: NsdManager,
        private val multicastLock: WifiManager.MulticastLock?,
        private val localIp: String,
        private val onPortChanged: (Int?) -> Unit,
    ) : AutoCloseable {
        private val pending = ArrayDeque<NsdServiceInfo>()
        private val knownServices = mutableSetOf<String>()
        private var discovering = false
        private var resolving = false
        private var closed = false
        private var multicastLockHeld = false
        private val timeoutHandler = Handler(Looper.getMainLooper())
        private val timeout = Runnable {
            if (!closed) {
                onPortChanged(null)
                close()
            }
        }

        private val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                discovering = true
                if (closed) stopDiscovery()
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (closed || !knownServices.add(serviceInfo.serviceName)) return
                pending.addLast(serviceInfo)
                resolveNext()
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                if (closed) return
                knownServices.remove(serviceInfo.serviceName)
                pending.removeIf { it.serviceName == serviceInfo.serviceName }
                resolveNext()
            }

            override fun onDiscoveryStopped(serviceType: String) {
                discovering = false
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                if (closed) return
                onPortChanged(null)
                close()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                discovering = false
            }
        }

        fun start() {
            try {
                multicastLock?.acquire()
                multicastLockHeld = multicastLock?.isHeld == true
                timeoutHandler.postDelayed(timeout, DISCOVERY_TIMEOUT_MILLIS)
                @Suppress("DEPRECATION")
                manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
            } catch (_: RuntimeException) {
                onPortChanged(null)
                close()
            }
        }

        private fun resolveNext() {
            if (closed || resolving || pending.isEmpty()) return
            val candidate = pending.removeFirst()
            resolving = true
            try {
                @Suppress("DEPRECATION")
                manager.resolveService(candidate, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        resolving = false
                        resolveNext()
                    }

                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        resolving = false
                        if (closed) return
                        if (serviceInfo.serviceName !in knownServices) {
                            resolveNext()
                            return
                        }

                        val port = wirelessAdbPortFor(
                            localIp = localIp,
                            serviceHost = serviceInfo.host?.hostAddress,
                            port = serviceInfo.port,
                        )
                        if (port != null) {
                            onPortChanged(port)
                            close()
                            return
                        }
                        resolveNext()
                    }
                })
            } catch (_: RuntimeException) {
                resolving = false
                resolveNext()
            }
        }

        private fun stopDiscovery() {
            if (!discovering) return
            discovering = false
            runCatching { manager.stopServiceDiscovery(listener) }
        }

        override fun close() {
            if (closed) return
            closed = true
            timeoutHandler.removeCallbacks(timeout)
            pending.clear()
            knownServices.clear()
            stopDiscovery()
            if (multicastLockHeld) {
                multicastLockHeld = false
                runCatching { multicastLock?.release() }
            }
        }

        private companion object {
            const val SERVICE_TYPE = "_adb-tls-connect._tcp."
            const val DISCOVERY_TIMEOUT_MILLIS = 5_000L
        }
    }
}

internal fun wirelessAdbPortFor(localIp: String, serviceHost: String?, port: Int): Int? =
    port.takeIf { serviceHost == localIp && it in VALID_PORT_RANGE }

internal fun needsWifiMulticastLock(apiLevel: Int, tiramisuExtensionLevel: Int): Boolean =
    apiLevel < TIRAMISU || (apiLevel == TIRAMISU && tiramisuExtensionLevel < MULTICAST_LOCK_EXTENSION)

private fun createMulticastLockIfNeeded(context: Context): WifiManager.MulticastLock? {
    val apiLevel = Build.VERSION.SDK_INT
    val extensionLevel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        SdkExtensions.getExtensionVersion(Build.VERSION_CODES.TIRAMISU)
    } else {
        0
    }
    if (!needsWifiMulticastLock(apiLevel, extensionLevel)) return null

    val wifi = context.getSystemService(WifiManager::class.java) ?: return null
    return runCatching {
        wifi.createMulticastLock("helm-wireless-adb-port-discovery").apply {
            setReferenceCounted(false)
        }
    }.getOrNull()
}

private const val TIRAMISU = 33
private const val MULTICAST_LOCK_EXTENSION = 7
private val VALID_PORT_RANGE = 1..65535
