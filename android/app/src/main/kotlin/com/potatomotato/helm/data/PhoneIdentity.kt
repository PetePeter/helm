package com.potatomotato.helm.data

import android.content.Context
import java.util.UUID

/**
 * The phone's own stable machine identity.
 *
 * Generated once and kept for the life of the install. It is NOT the BLE address:
 * Android rotates the advertised address, and Helm keys its entire device
 * registry on this value — so a fresh id on every connection would fork a
 * duplicate registry entry and orphan the pairing.
 *
 * A factory reset or a reinstall legitimately produces a new identity, and the
 * user pairs again. That is the intended behaviour, not a bug to work around.
 */
object PhoneIdentity {
    private const val PREFS_NAME = "helm-identity"
    private const val KEY = "machineId"

    fun machineId(context: Context): String {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.let { return it }
        return UUID.randomUUID().toString().also { prefs.edit().putString(KEY, it).apply() }
    }
}
