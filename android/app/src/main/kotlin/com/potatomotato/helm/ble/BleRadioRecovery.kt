package com.potatomotato.helm.ble

import com.potatomotato.helm.log.HelmLog

/**
 * BleRadioRecovery — what the link does as Bluetooth itself turns on and off.
 *
 * WHY this exists: [GattServer.open] fails outright when the radio is off, and
 * before this the service just sat on a Disconnected notification forever until
 * the user opened the app. The three ways out, in order:
 *
 *  1. a BOUNDED retry for transient open failures while the radio is up;
 *  2. the service's ACTION_STATE_CHANGED receiver feeding [onBluetoothOn] /
 *     [onBluetoothOff] — a radio that comes back is a fresh chance, a radio
 *     that goes parks the link but never kills the service;
 *  3. when both fail, nothing — the honest notification says the link is down.
 *
 * The class knows no Android types. The receiver stays thin wiring in
 * [HelmLinkService]; every decision here is JVM-testable.
 */
class BleRadioRecovery(
    private val scheduler: LinkScheduler,
    private val log: (String) -> Unit = HelmLog.port(HelmLog.BLE),
) {
    private companion object {
        const val RETRY_MIN_MS = 1_000L
        const val RETRY_MAX_MS = 4_000L

        /** Bounded: a device that can never open must not retry forever. */
        const val RETRY_BUDGET = 3
    }

    /** Opens the GATT server and starts the session. True when the link is up. */
    var bringUp: () -> Boolean = { false }

    /** Parks the link gracefully — stop advertising, keep the service. */
    var standDown: () -> Unit = {}

    /** True while the GATT server is open and the session is running. */
    var up: Boolean = false
        private set

    /** The radio's last known state, reported by the service before starting. */
    private var radioOn = true

    private var retriesLeft = RETRY_BUDGET
    private var retryDelayMs = RETRY_MIN_MS

    /**
     * One retry in flight at a time, and a stale one must never fire: there is
     * no cancel on [LinkScheduler], so each generation change invalidates the
     * action already queued.
     */
    private var retryGeneration = 0

    /** The service reads the adapter once and reports it before the first try. */
    fun onBluetoothState(on: Boolean) {
        radioOn = on
    }

    fun start() = attempt("service start")

    fun onBluetoothOn() {
        if (radioOn && up) return
        radioOn = true
        // A fresh radio is a fresh chance, whatever the old budget said.
        retriesLeft = RETRY_BUDGET
        retryDelayMs = RETRY_MIN_MS
        attempt("bluetooth on")
    }

    fun onBluetoothOff() {
        if (!radioOn) return
        radioOn = false
        retryGeneration++
        if (!up) return
        log("bluetooth turned off; standing the link down but keeping the service")
        up = false
        standDown()
    }

    private fun attempt(why: String) {
        if (up) return
        if (bringUp()) {
            log("the link came up ($why)")
            up = true
            retriesLeft = RETRY_BUDGET
            retryDelayMs = RETRY_MIN_MS
            return
        }
        if (!radioOn) {
            // Retrying into a radio that is off is pure error spam; the
            // STATE_ON broadcast is the retry.
            log("the link stays down ($why); waiting for bluetooth to turn on")
            return
        }
        if (retriesLeft <= 0) {
            log("the link stays down ($why); giving up until bluetooth changes state")
            return
        }
        retriesLeft--
        val delay = retryDelayMs
        retryDelayMs = minOf(retryDelayMs * 2, RETRY_MAX_MS)
        val generation = retryGeneration
        scheduler.schedule(delay) {
            if (generation == retryGeneration && !up) attempt("retry")
        }
    }
}
