package com.potatomotato.helm.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * DeviceKeyStore — pairing PSKs at rest, wrapped by the Android Keystore.
 *
 * WHY NOT "JUST PUT THE PSK IN THE KEYSTORE": the Keystore holds KEYS, and on
 * API 26 a raw 32-byte secret cannot be imported into it. So the Keystore holds
 * a key it GENERATED and never exports — hardware-backed on any device with a
 * TEE or StrongBox — and that key encrypts the PSK. What reaches SharedPreferences
 * is ciphertext only; the plan's rule is "never plaintext in preferences" and
 * this is the shape that actually honours it on the minimum supported release.
 *
 * A PSK that cannot be decrypted (the Keystore key was invalidated by a factory
 * reset or a lock-screen change) is treated as absent, not as an error: the phone
 * then simply pairs again, which is the only recovery that exists anyway.
 *
 * This class decides nothing. All the pairing logic lives in
 * `com.potatomotato.helm.link.PairingController`, against the [PskStore]
 * interface, so it is testable on the JVM.
 */
class DeviceKeyStore(context: Context) : PskStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun save(machineId: String, psk: ByteArray) {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, wrapKey()) }
        val sealed = cipher.iv + cipher.doFinal(psk)
        prefs.edit().putString(key(machineId), Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    override fun load(machineId: String): ByteArray? {
        val stored = prefs.getString(key(machineId), null) ?: return null
        return try {
            val sealed = Base64.decode(stored, Base64.NO_WRAP)
            Cipher.getInstance(TRANSFORMATION).apply {
                init(
                    Cipher.DECRYPT_MODE,
                    wrapKey(),
                    GCMParameterSpec(TAG_BITS, sealed, 0, GCM_IV_BYTES),
                )
            }.doFinal(sealed, GCM_IV_BYTES, sealed.size - GCM_IV_BYTES)
        } catch (_: Exception) {
            // Undecryptable is indistinguishable from unpaired, and pairing again
            // is the only cure either way.
            forget(machineId)
            null
        }
    }

    override fun forget(machineId: String) {
        prefs.edit().remove(key(machineId)).apply()
    }

    override fun pairedMachineIds(): Set<String> =
        prefs.all.keys.filter { it.startsWith(KEY_PREFIX) }.map { it.removePrefix(KEY_PREFIX) }.toSet()

    /** The Keystore-resident wrapping key, generated once on first use. */
    private fun wrapKey(): SecretKey {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (keyStore.getEntry(WRAP_KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).apply {
            init(
                KeyGenParameterSpec.Builder(
                    WRAP_KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
    }

    private fun key(machineId: String) = KEY_PREFIX + machineId

    private companion object {
        const val PREFS_NAME = "helm-pairings"
        const val KEY_PREFIX = "psk:"
        const val PROVIDER = "AndroidKeyStore"
        const val WRAP_KEY_ALIAS = "helm-psk-wrap-v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
