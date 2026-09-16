package com.potatomotato.helm.data

/**
 * Where a completed pairing lives between app launches.
 *
 * Keyed on the desktop's machineId, never on its BLE address: an address is a
 * scanning hint that the OS rotates, and keying on it would orphan the PSK the
 * first time it changed. The desktop's registry is keyed the same way.
 *
 * An interface because the real implementation needs the Android Keystore and
 * the tests need neither a device nor a filesystem.
 */
interface PskStore {
    fun save(machineId: String, psk: ByteArray)
    fun load(machineId: String): ByteArray?

    /** Drops the key AND the nickname: a forgotten desktop leaves nothing behind. */
    fun forget(machineId: String)
    fun pairedMachineIds(): Set<String>

    /**
     * The user's own name for a desktop, or null when they have not given one.
     *
     * WHY THE PHONE OWNS THIS: the desktop identifies itself with a random UUID
     * and the protocol carries no friendly name, so "Workshop PC" exists only
     * here. It is a label, not a secret, and is stored in the clear beside the
     * sealed PSK — encrypting it would buy nothing and could lose the name to a
     * Keystore invalidation that the pairing itself survived.
     */
    fun label(machineId: String): String?

    /** Blank clears the nickname, putting the row back on its derived default. */
    fun setLabel(machineId: String, label: String)
}
