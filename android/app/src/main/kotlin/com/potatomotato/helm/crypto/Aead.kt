package com.potatomotato.helm.crypto

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

const val AEAD_KEY_BYTES = 32
const val AEAD_NONCE_BYTES = 12
const val AEAD_TAG_BYTES = 16

/**
 * Wire sequence prefix on every sealed frame: 8 bytes, big-endian. It matches
 * the nonce's counter field exactly, so the sequence IS the nonce — nothing
 * second to keep in step.
 */
const val AEAD_SEQ_BYTES = 8

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
 *  - The nonce is a counter, never random. Every frame carries its sequence on
 *    the wire (an 8-byte big-endian prefix) and the sequence IS the nonce, bound
 *    into the tag as AAD. The sender never reuses a sequence, so nonce reuse
 *    stays structurally impossible even though the receiver resynchronises
 *    after a lost frame; a spliced or altered sequence fails the tag check like
 *    any other tamper.
 *  - An authentication failure burns the receiver permanently — no plaintext
 *    fallback, no recovery. The ONE exception, a whole frame that never arrived
 *    (sequence ahead of expectation but authentic), resynchronises: that is a
 *    lost message, not an attack, and the channel must survive it.
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

    /** Returns seq || ciphertext || tag. The sequence doubles as the nonce. */
    fun seal(plaintext: ByteArray): ByteArray {
        check(counter <= MAX_AEAD_COUNTER) { "AEAD send counter exhausted - rekey or close the channel" }
        val cipher = Aead.cipher(Cipher.ENCRYPT_MODE, key, counter)
        cipher.updateAAD(seqPrefix(counter))
        val sealed = cipher.doFinal(plaintext)
        val frame = seqPrefix(counter) + sealed
        counter++
        return frame
    }
}

/** Told when the receiver accepted a sequence ahead of expectation. */
fun interface AeadGapListener {
    fun onGap(lostFrom: Long, lostTo: Long)
}

/** One-directional opening side of the channel. */
class AeadReceiver(
    private val key: ByteArray,
    private val onGap: AeadGapListener? = null,
    startCounter: Long = 0L,
) {
    private var counter = startCounter
    private var burned = false

    init {
        requireKey(key)
    }

    /**
     * Authenticate and decrypt the next frame.
     *
     * A sequence AHEAD of expectation that authenticates is a frame lost in
     * flight: the gap is reported, the expectation resynchronises, and the
     * channel continues. Everything else that fails — tamper, replay, reorder
     * backwards, exhaustion — burns the receiver permanently.
     */
    fun open(frame: ByteArray): ByteArray {
        check(!burned) { "AEAD receiver closed by a previous failure" }
        if (counter > MAX_AEAD_COUNTER) {
            burned = true
            error("AEAD receive counter exhausted - rekey or close the channel")
        }
        if (frame.size < AEAD_SEQ_BYTES + AEAD_TAG_BYTES) {
            burned = true
            error("AEAD frame shorter than its sequence number and authentication tag")
        }
        val sequence = readUint64(frame, 0)
        if (sequence < counter) {
            burned = true
            error("AEAD sequence regressed - replay refused")
        }

        val body = frame.copyOfRange(AEAD_SEQ_BYTES, frame.size)
        val plaintext = try {
            val cipher = Aead.cipher(Cipher.DECRYPT_MODE, key, sequence)
            cipher.updateAAD(frame.copyOfRange(0, AEAD_SEQ_BYTES))
            cipher.doFinal(body)
        } catch (_: Exception) {
            burned = true
            throw IllegalStateException("AEAD authentication failed")
        }

        if (sequence > counter) onGap?.onGap(counter, sequence - 1)
        counter = sequence + 1
        return plaintext
    }
}

private fun seqPrefix(counter: Long): ByteArray =
    ByteArray(AEAD_SEQ_BYTES).apply {
        for (i in 0 until AEAD_SEQ_BYTES) this[i] = (counter ushr (8 * (AEAD_SEQ_BYTES - 1 - i))).toByte()
    }

private fun readUint64(source: ByteArray, offset: Int): Long {
    var value = 0L
    for (i in 0 until 8) value = (value shl 8) or (source[offset + i].toLong() and 0xff)
    return value
}

private fun requireKey(key: ByteArray) {
    require(key.size == AEAD_KEY_BYTES) { "AEAD key must be $AEAD_KEY_BYTES bytes" }
}
