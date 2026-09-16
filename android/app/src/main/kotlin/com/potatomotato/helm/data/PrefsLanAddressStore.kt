package com.potatomotato.helm.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray

/**
 * [LanAddressStore] over SharedPreferences, in the clear.
 *
 * Deliberately NOT wrapped by the Keystore the way [DeviceKeyStore] wraps a
 * PSK. An address is not a secret — it is public on the network it names — and
 * encrypting it would buy nothing while risking the same Keystore-invalidation
 * loss that a pairing can already survive. What makes a LAN link safe is the
 * PSK handshake at the far end, not the confidentiality of the address.
 */
class PrefsLanAddressStore(context: Context) : LanAddressStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun save(machineId: String, addresses: List<String>) {
        // Replace, never merge: the desktop sends its complete current list, so
        // an address it dropped must vanish rather than linger as a ghost to
        // dial. An empty list is stored as an empty list — it means something.
        prefs.edit().putString(key(machineId), JSONArray(addresses).toString()).apply()
    }

    override fun load(machineId: String): List<String> {
        val stored = prefs.getString(key(machineId), null) ?: return emptyList()
        return try {
            val array = JSONArray(stored)
            (0 until array.length()).mapNotNull { array.opt(it) as? String }
        } catch (_: Exception) {
            // Corrupt preferences are indistinguishable from "never pushed", and
            // the next link repairs both — the push is idempotent by design.
            emptyList()
        }
    }

    override fun forget(machineId: String) {
        prefs.edit().remove(key(machineId)).apply()
    }

    private fun key(machineId: String) = "$KEY_PREFIX$machineId"

    private companion object {
        const val PREFS_NAME = "helm_lan_addresses"
        const val KEY_PREFIX = "addresses_"
    }
}
