package com.potatomotato.helm.crypto

import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * pairing-crypto — the phone's half of the SAS pairing primitives. A direct port
 * of `src/mcp/peer/pairing-crypto.ts`; the two are pinned together by
 * tests/fixtures/secure-channel-vectors.json.
 *
 * NO Android types, NO I/O, NO randomness beyond key generation. Everything here
 * is a pure function of its arguments so it can be tested on the JVM, without a
 * device, against the desktop's committed output.
 *
 * SECURITY INVARIANTS (do not weaken — they mirror the desktop's):
 *  - The 6-digit SAS is an OUTPUT of a KDF over the ECDH shared secret and is
 *    NEVER an input to any MAC or KDF. A MITM with its own keys yields a
 *    DIFFERENT SAS on each end, which is the whole point of the user comparing.
 *  - SAS, confirm-MAC and PSK come from the SAME secret and transcript but under
 *    DISTINCT HKDF `info` labels, so the three outputs are independent.
 *  - Every transcript field is length-prefixed in FIXED role order, so the
 *    encoding is injective and identical on both peers regardless of send order.
 */
object PairingCrypto {
    /** HKDF `info` labels — must match pairing-crypto.ts exactly. */
    private const val SAS_LABEL = "helm-pair-sas-v1"
    private const val CONFIRM_LABEL = "helm-pair-confirm-v1"
    private const val PSK_LABEL = "helm-peer-psk-v1"

    /** Length-prefixed SHA-256 commitment over (pubkeyDER, nonce). */
    fun computeCommitment(pubkeyDER: ByteArray, nonce: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(lengthPrefixed(listOf(pubkeyDER, nonce)))

    /** Constant-time check that `commitment` matches SHA256(lp(pubkey, nonce)). */
    fun verifyCommitment(commitment: ByteArray, pubkeyDER: ByteArray, nonce: ByteArray): Boolean =
        constantTimeEquals(commitment, computeCommitment(pubkeyDER, nonce))

    /**
     * The canonical transcript. Version is a fixed-width 4-byte big-endian field
     * (no decimal-string ambiguity); every other field is a 4-byte length prefix
     * plus raw bytes, in fixed role order.
     */
    fun buildTranscript(parts: TranscriptParts): ByteArray = lengthPrefixed(
        listOf(
            uint32(parts.version),
            parts.sessionId.toByteArray(Charsets.UTF_8),
            parts.initiatorMachineId.toByteArray(Charsets.UTF_8),
            parts.responderMachineId.toByteArray(Charsets.UTF_8),
            parts.initiatorCertFp.toByteArray(Charsets.UTF_8),
            parts.responderCertFp.toByteArray(Charsets.UTF_8),
            parts.initiatorPubDER,
            parts.responderPubDER,
            parts.initiatorNonce,
            parts.responderNonce,
        ),
    )

    /**
     * The 6 digits the USER compares: HKDF(shared, salt=transcript, info=SAS,
     * 4 bytes) -> uint32 -> mod 1e6 -> zero-padded.
     */
    fun deriveSas(shared: ByteArray, transcript: ByteArray): String {
        val out = Hkdf.sha256(shared, transcript, SAS_LABEL, 4)
        var value = 0L
        for (byte in out) value = (value shl 8) or (byte.toLong() and 0xff)
        return (value % 1_000_000L).toString().padStart(6, '0')
    }

    /**
     * Confirm-MAC = HMAC(confirmKey, transcript), confirmKey =
     * HKDF(shared, salt=transcript, info=CONFIRM, 32). The key comes from the
     * ECDH secret — NEVER from the SAS.
     */
    fun computeConfirmMac(shared: ByteArray, transcript: ByteArray): ByteArray =
        Hkdf.hmac(Hkdf.sha256(shared, transcript, CONFIRM_LABEL, 32), transcript)

    /** Constant-time verify of a peer's confirm-MAC; never throws on bad input. */
    fun verifyConfirmMac(shared: ByteArray, transcript: ByteArray, providedMac: ByteArray): Boolean =
        constantTimeEquals(providedMac, computeConfirmMac(shared, transcript))

    /** Final pre-shared key: HKDF(shared, salt=transcript, info=PSK, 32). */
    fun derivePsk(shared: ByteArray, transcript: ByteArray): ByteArray =
        Hkdf.sha256(shared, transcript, PSK_LABEL, 32)
}

/**
 * Transcript fields in FIXED role order (initiator then responder), NOT send
 * order. Helm is always the initiator; the phone is always the responder.
 */
data class TranscriptParts(
    val version: Int,
    val sessionId: String,
    val initiatorMachineId: String,
    val responderMachineId: String,
    val initiatorCertFp: String,
    val responderCertFp: String,
    val initiatorPubDER: ByteArray,
    val responderPubDER: ByteArray,
    val initiatorNonce: ByteArray,
    val responderNonce: ByteArray,
) {
    // Identity is what matters here; the generated array-by-reference equals would
    // be a quiet lie if anything ever compared two of these.
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

/** 4-byte big-endian length prefix per field, concatenated — injective. */
internal fun lengthPrefixed(fields: List<ByteArray>): ByteArray {
    val out = ByteArrayOutputStream()
    for (field in fields) {
        out.write(uint32(field.size))
        out.write(field)
    }
    return out.toByteArray()
}

/** Big-endian uint32. */
internal fun uint32(value: Int): ByteArray = byteArrayOf(
    (value ushr 24).toByte(),
    (value ushr 16).toByte(),
    (value ushr 8).toByte(),
    value.toByte(),
)

/** Length-checked constant-time compare; false, never an exception, on mismatch. */
internal fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
    if (a.size != b.size) return false
    var diff = 0
    for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
    return diff == 0
}
