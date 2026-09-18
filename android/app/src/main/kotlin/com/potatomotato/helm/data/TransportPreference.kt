package com.potatomotato.helm.data

/**
 * Which transport the user wants this phone to use.
 *
 * The ranking (LAN preempts Bluetooth — see `HelmLink`) is not a preference; it
 * is a fact about the two pipes, and [Auto] is that fact left alone. What this
 * adds is the ability to say "only this one", which is a different question:
 *
 *  - [LanOnly] stops the Bluetooth peripheral advertising. That is the battery
 *    win, and it is the ONLY version of the setting that has one — a preference
 *    that leaves both radios running saves nothing and merely hides which is in
 *    use. The cost is real and deliberate: off the desktop's network there is no
 *    link at all, because the advertised address is private to that network.
 *  - [BluetoothOnly] stops the phone dialling. For when the network is there but
 *    not worth trusting, or is dropping the socket repeatedly.
 *
 * A forced choice is honoured even when it leaves NO link. Silently falling back
 * would make the setting a lie, and the user would be reading a battery figure
 * that came from a radio they believed was off.
 */
enum class TransportPreference {
    Auto,
    LanOnly,
    BluetoothOnly,
    ;

    /** Whether the phone may dial the desktop over the network. */
    val allowsLan: Boolean get() = this != BluetoothOnly

    /** Whether the Bluetooth peripheral may advertise. */
    val allowsBluetooth: Boolean get() = this != LanOnly

    /** The stored spelling. The NAME, so a reordering of the enum cannot silently remap. */
    val stored: String get() = name

    companion object {
        /**
         * Read a stored value. Anything unrecognised — a missing key, a value
         * from a newer build, a corrupt preference — reads as [Auto].
         *
         * Auto rather than a refusal because this setting gates the RADIOS: a
         * value that failed to parse must never be the reason a phone cannot
         * reach its desktop at all.
         */
        fun fromStored(value: String?): TransportPreference =
            entries.firstOrNull { it.name == value } ?: Auto
    }
}

/**
 * Where the chosen transport lives across restarts.
 *
 * An interface with a preferences implementation beside it, the same shape as
 * [LanAddressStore] and for the same reason: the decisions that depend on this
 * value are worth testing, and none of them should need an Android runtime.
 */
interface TransportPreferenceStore {
    fun load(): TransportPreference
    fun save(preference: TransportPreference)
}
