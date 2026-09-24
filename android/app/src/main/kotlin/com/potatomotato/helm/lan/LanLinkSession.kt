package com.potatomotato.helm.lan

import com.potatomotato.helm.data.parseLanAddress
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.SocketTimeoutException

/**
 * LanLinkSession — the phone dialling Helm over the network.
 *
 * THE DIRECTION IS INVERTED FROM BLE, and that is the whole shape of this file.
 * Over Bluetooth the phone advertises and Helm connects; over LAN Helm listens
 * and the phone dials. So this is the one place in the app that initiates a
 * connection, and the only place that needs an address at all.
 *
 * PAIRING NEVER HAPPENS HERE. A socket may only ever carry a handshake against
 * a PSK that Bluetooth already bootstrapped in the room (P-0752). This class
 * does not know what a PSK is, which is how it stays unable to violate that.
 *
 * It deals in RAW BYTES, not messages: SecureChannel accumulates and splits on
 * its own length prefix, so a TCP stream needs no chunker. The BLE side needs
 * one only because ATT imposes one.
 *
 * Every dependency on the network is behind [Dialer], so the whole policy —
 * which address wins, what happens when they all fail, who owns the link — is
 * testable on the JVM with no device and no sockets.
 */
class LanLinkSession(
    private val dialer: Dialer,
    private val onBytes: (ByteArray) -> Unit,
    private val onStateChange: (LanLinkState) -> Unit,
    private val log: (String) -> Unit = {},
) {
    /** One open connection, as this class needs it. */
    interface Connection {
        val input: InputStream
        val output: OutputStream
        fun close()
    }

    /** Opening a connection. Injected so the policy above is testable. */
    fun interface Dialer {
        /** Throws [IOException] when the address cannot be reached. */
        fun dial(host: String, port: Int): Connection
    }

    private var connection: Connection? = null
    @Volatile private var stopped = false

    val connected: Boolean get() = connection != null

    /**
     * The LAN half of the link's backpressure contract (see
     * [com.potatomotato.helm.ble.HelmLink.pendingBytes]). Always zero, and that
     * is the honest answer rather than a stub: [send] writes and FLUSHES before
     * it returns, so by the time a caller can ask, everything it handed over has
     * gone to the socket. Backpressure on this transport is the blocking write
     * itself — there is no queue of ours for anything to wait in.
     */
    val pendingBytes: Long get() = 0L

    /**
     * Try each address in turn and keep the first that answers.
     *
     * FIRST WINS, and the list is tried in the order the desktop sent it. There
     * is nothing to rank: every address in the list is the same desktop, and the
     * ones that do not answer are simply interfaces the phone cannot see from
     * where it is standing right now.
     *
     * Returns the connection, or null when nothing answered — which is the
     * ordinary case away from home and must not be treated as an error.
     */
    fun connect(addresses: List<String>): Connection? {
        stopped = false
        if (connection != null) return connection
        if (addresses.isEmpty()) {
            // An empty list is the desktop saying "stop dialling". Honour it
            // silently: it is a setting, not a failure.
            log("no LAN addresses are known; not dialling")
            onStateChange(LanLinkState.Idle)
            return null
        }

        onStateChange(LanLinkState.Dialling)
        for (raw in addresses) {
            if (stopped) break
            val address = parseLanAddress(raw)
            if (address == null) {
                // A malformed entry is dropped, never guessed at: the failure
                // mode of guessing is dialling a stranger.
                log("ignoring an unusable LAN address: $raw")
                continue
            }
            try {
                val opened = dialer.dial(address.host, address.port)
                connection = opened
                log("connected over LAN to $raw")
                onStateChange(LanLinkState.Connected)
                return opened
            } catch (error: Exception) {
                // Exception, not IOException: a missing INTERNET permission
                // raises SecurityException, and a dialler is injected so it may
                // fail in ways this file cannot enumerate. Per invariant 7's
                // spirit, every one of them is "try the next address", never a
                // throw into the layer above. Unreachable is the NORMAL answer
                // for an interface the phone cannot see from where it stands.
                log("could not reach $raw: ${error.javaClass.simpleName}: ${error.message}")
            }
        }

        onStateChange(LanLinkState.Idle)
        return null
    }

    /**
     * Pump the socket until it ends. Blocking: the caller supplies the thread.
     *
     * A read returning -1, or throwing, both mean the same thing — the link is
     * over — and both must land as a clean close rather than an exception
     * escaping into the layer above. Per invariant 7's spirit.
     */
    fun pump() {
        val open = connection ?: return
        val buffer = ByteArray(READ_BUFFER_BYTES)
        val startedMs = System.currentTimeMillis()
        var reason = "closed"
        try {
            while (!stopped) {
                val read = open.input.read(buffer)
                if (read < 0) {
                    reason = "eof"
                    break
                }
                if (read > 0) onBytes(buffer.copyOf(read))
            }
        } catch (error: SocketTimeoutException) {
            // Nothing heard for the read timeout. The desktop pings far more
            // often than that, so the socket is dead even if TCP has not noticed.
            reason = "timeout"
        } catch (error: IOException) {
            reason = if (stopped) "closed" else "reset (${error.message})"
        } finally {
            val lifetimeS = (System.currentTimeMillis() - startedMs) / 1_000
            log("the LAN link ended: reason=$reason lifetime=${lifetimeS}s")
            close()
        }
    }

    /** Write bytes to the desktop. False when the link cannot carry them. */
    fun send(data: ByteArray): Boolean {
        val open = connection ?: return false
        return try {
            open.output.write(data)
            open.output.flush()
            true
        } catch (error: IOException) {
            // A failed write means the link is gone; saying so now is what stops
            // the layer above waiting for an answer that can never arrive.
            log("a LAN write failed: ${error.message}")
            close()
            false
        }
    }

    /** Drop the connection. Idempotent, and safe to call from any thread. */
    fun close() {
        stopped = true
        val open = connection ?: return
        connection = null
        runCatching { open.close() }
        onStateChange(LanLinkState.Idle)
    }

    private companion object {
        /**
         * Sized for a terminal snapshot rather than a keystroke: the reason this
         * transport exists is that BLE's 20-to-511-byte chunks are too small.
         */
        const val READ_BUFFER_BYTES = 32 * 1024
    }
}

/** Where the LAN attempt has got to. Distinct from the BLE-shaped LinkState. */
enum class LanLinkState {
    /** Not dialling: no addresses, or nothing answered, or closed. */
    Idle,
    Dialling,
    Connected,
}
