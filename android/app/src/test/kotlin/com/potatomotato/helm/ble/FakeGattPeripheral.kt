package com.potatomotato.helm.ble

/**
 * A fake radio, not a mock: it records what a real peripheral would have done
 * and lets a test decide whether the stack accepts a notification.
 */
class FakeGattPeripheral : GattPeripheral {
    val notified = mutableListOf<ByteArray>()
    val disconnected = mutableListOf<String>()
    var advertiseStarts = 0
        private set
    var advertiseStops = 0
        private set
    var advertising = false
        private set

    /** Set false to simulate a congested stack refusing a notification outright. */
    var acceptNotifications = true

    /** Set to make the radio throw, as a real one does when permission is gone. */
    var throwOnAdvertise: Exception? = null

    override fun startAdvertising() {
        advertiseStarts++
        throwOnAdvertise?.let { throw it }
        advertising = true
    }

    override fun stopAdvertising() {
        advertiseStops++
        advertising = false
    }

    override fun notifyTx(chunk: ByteArray): Boolean {
        if (!acceptNotifications) return false
        notified.add(chunk)
        return true
    }

    override fun disconnect(centralAddress: String) {
        disconnected.add(centralAddress)
    }
}

/** Collects deferred work so a test can run it without waiting on a clock. */
class FakeScheduler : LinkScheduler {
    val delays = mutableListOf<Long>()
    private val pending = mutableListOf<() -> Unit>()

    override fun schedule(delayMs: Long, action: () -> Unit) {
        delays.add(delayMs)
        pending.add(action)
    }

    /** Run everything scheduled so far, once. */
    fun runPending() {
        val due = pending.toList()
        pending.clear()
        due.forEach { it() }
    }
}
