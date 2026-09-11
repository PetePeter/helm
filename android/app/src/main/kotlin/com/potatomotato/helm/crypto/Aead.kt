package com.potatomotato.helm.crypto

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

const val AEAD_KEY_BYTES = 32
const val AEAD_NONCE_BYTES = 12
const val AEAD_TAG_BYTES = 16

/**
 * Last usable counter value, matching `MAX_AEAD_COUNTER` on the desktop. Capped
 * well below 2^64 so the limit is reachable in a test and can never silently
 * wrap in production.
 */
const val MAX_AEAD_COUNTER = (1L shl 48) - 1L

/**
 * aead — AES-256-GCM framing for the mobile link, a port of `src/mobile/aead.ts`.
 *
 * SECURITY INVARIANTS (do not weaken):
 *  - Each direction has its OWN key under a distinct HKDF `info` label, so a
 *    frame reflected back at its sender fails authentication.
 *  - The nonce is a counter, never random and never transmitted. There is no
 *    sequence number on the wire for an attacker to steer, so a replayed or
 *    reordered frame is opened under the wrong nonce and fails the tag check.
 *  - One authentication failure burns the receiver permanently. No
 *    resynchronisation, no plaintext fallback.
 *  - The counter is refused at exhaustion rather than wrapped: wrapping would
 *    reuse a (key, nonce) pair, which is catastrophic for GCM.
 */
object Aead {
    /** HKDF `info` labels — must match aead.ts exactly. */
    private const val I2R_LABEL = "helm-mobile-aead-i2r-v1"
    private const val R2I_LABEL = "helm-mobile-aead-r2i-v1"

    /**
     * Mix an established pairing PSK into a secret. The single place this binding
     * is defined, so the confirm-MAC and the AEAD keys agree on what "knowing the
     * PSK" means: a peer without it derives different values and the handshake
     * fails rather than silently downgrading to an unpaired link.
     */
    fun bindPsk(secret: ByteArray, psk: ByteArray?): ByteArray =
        if (psk == null) secret else secret + psk

    fun deriveDirectionKeys(
        sharedSecret: ByteArray,
        transcript: ByteArray,
        psk: ByteArray?,
    ): DirectionKeys {
        val ikm = bindPsk(sharedSecret, psk)
        return DirectionKeys(
            initiatorToResponder = Hkdf.sha256(ikm, transcript, I2R_LABEL, AEAD_KEY_BYTES),
            responderToInitiator = Hkdf.sha256(ikm, transcript, R2I_LABEL, AEAD_KEY_BYTES),
        )
    }

    /** Four zero bytes followed by the big-endian counter. */
    fun nonce(counter: Long): ByteArray {
        val out = ByteArray(AEAD_NONCE_BYTES)
        for (i in 0 until 8) out[AEAD_NONCE_BYTES - 1 - i] = (counter ushr (8 * i)).toByte()
        return out
    }

    internal fun cipher(mode: Int, key: ByteArray, counter: Long): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(
                mode,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(AEAD_TAG_BYTES * 8, nonce(counter)),
            )
        }
}

class DirectionKeys(
    /** Seals traffic flowing initiator (Helm) -> responder (the phone). */
    val initiatorToResponder: ByteArray,
    /** Seals traffic flowing responder (the phone) -> initiator (Helm). */
    val responderToInitiator: ByteArray,
)

/** One-directional sealing side of the channel. */
class AeadSender(private val key: ByteArray, startCounter: Long = 0L) {
    private var counter = startCounter

    init {
        requireKey(key)
    }

    /** Returns ciphertext || tag. The nonce is implicit in the counter. */
    fun seal(plaintext: ByteArray): ByteArray {
        check(counter <= MAX_AEAD_COUNTER) { "AEAD send counter exhausted - rekey or close the channel" }
        val sealed = Aead.cipher(Cipher.ENCRYPT_MODE, key, counter).doFinal(plaintext)
        counter++
        return sealed
    }
}

/** One-directional opening side of the channel. */
class AeadReceiver(private val key: ByteArray, startCounter: Long = 0L) {
    private var counter = startCounter
    private var burned = false

    init {
        requireKey(key)
    }

    /**
     * Authenticate and decrypt the next frame. Any failure — tamper, replay,
     * reorder, exhaustion — burns the receiver: there is no way back to plaintext.
     */
    fun open(frame: ByteArray): ByteArray {
        check(!burned) { "AEAD receiver closed by a previous failure" }
        if (counter > MAX_AEAD_COUNTER || frame.size < AEAD_TAG_BYTES) {
            burned = true
            error("AEAD frame refused")
        }
        val plaintext = try {
            Aead.cipher(Cipher.DECRYPT_MODE, key, counter).doFinal(frame)
        } catch (error: Exception) {
            burned = true
            throw IllegalStateException("AEAD authentication failed")
        }
        counter++
        return plaintext
    }
}

private fun requireKey(key: ByteArray) {
    require(key.size == AEAD_KEY_BYTES) { "AEAD key must be $AEAD_KEY_BYTES bytes" }
}
