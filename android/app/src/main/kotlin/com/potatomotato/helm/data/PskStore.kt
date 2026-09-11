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
    fun forget(machineId: String)
    fun pairedMachineIds(): Set<String>
}
