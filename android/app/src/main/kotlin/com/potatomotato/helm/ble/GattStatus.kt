package com.potatomotato.helm.ble

/**
 * GattStatus — what Android's disconnect status code actually means.
 *
 * WHY this file exists: `BluetoothGattServerCallback.onConnectionStateChange`
 * carries a `status` int that says, with real precision, why a link ended — and
 * [GattServer] used to throw it away. The first end-to-end run dropped the link
 * every 13-40 seconds and nobody could say whether the phone hung up, Helm hung
 * up, or the two radios simply lost each other, because that int never left the
 * framework callback. That single discarded value is why the churn was
 * undiagnosable from both ends at once.
 *
 * The constants are the Android stack's own (`hci_err.h`, surfaced through
 * `BluetoothGatt`), spelled out here rather than imported because most of them
 * have no public constant — `BluetoothGatt` exposes `GATT_SUCCESS` and a handful
 * of others, and the interesting ones for a dropped link are not among them.
 * Keeping them as plain ints also keeps this class free of Android types, so it
 * is tested on the JVM like everything else that decides something.
 */
object GattStatus {

    /** A clean, requested teardown. Either side may have asked for it. */
    const val SUCCESS = 0

    /** The supervision timeout expired: the radios stopped hearing each other. */
    const val CONN_TIMEOUT = 8

    /** The remote end — for this app, Helm — deliberately hung up. */
    const val CONN_TERMINATE_PEER_USER = 19

    /** This phone's own stack tore the connection down. */
    const val CONN_TERMINATE_LOCAL_HOST = 22

    /** The connection was never actually established. */
    const val CONN_FAIL_ESTABLISH = 62

    /**
     * The notorious catch-all. It means "something went wrong in the stack" and
     * nothing more; treating it as a specific cause has misled people for years,
     * so it is reported as exactly what it is.
     */
    const val ERROR = 133

    /** `19 GATT_CONN_TERMINATE_PEER_USER`, or `41` for one with no name. */
    fun describe(status: Int): String = when (status) {
        SUCCESS -> "$status GATT_SUCCESS"
        CONN_TIMEOUT -> "$status GATT_CONN_TIMEOUT"
        CONN_TERMINATE_PEER_USER -> "$status GATT_CONN_TERMINATE_PEER_USER"
        CONN_TERMINATE_LOCAL_HOST -> "$status GATT_CONN_TERMINATE_LOCAL_HOST"
        CONN_FAIL_ESTABLISH -> "$status GATT_CONN_FAIL_ESTABLISH"
        ERROR -> "$status GATT_ERROR (the stack's catch-all; it names no cause)"
        else -> "$status"
    }

    /**
     * Who ended it, as far as the status code can say.
     *
     * [Closer.PHONE] is only ever reported when this session ASKED for the
     * disconnect — a status of `GATT_CONN_TERMINATE_LOCAL_HOST` says the local
     * stack did it, which includes Android killing the link on its own.
     */
    fun closerOf(status: Int): Closer = when (status) {
        CONN_TERMINATE_PEER_USER -> Closer.HELM
        CONN_TERMINATE_LOCAL_HOST -> Closer.ANDROID
        CONN_TIMEOUT -> Closer.RADIO
        CONN_FAIL_ESTABLISH -> Closer.RADIO
        else -> Closer.UNKNOWN
    }

    /** Which side of the link hung up. */
    enum class Closer {
        /** This session asked for it — a refused second central, or stop(). */
        PHONE,

        /** The central deliberately disconnected. */
        HELM,

        /** This phone's Bluetooth stack did it without this app asking. */
        ANDROID,

        /** Nobody hung up; the link simply failed. Range, interference, timeout. */
        RADIO,

        /** The status names no cause. */
        UNKNOWN,
    }
}
