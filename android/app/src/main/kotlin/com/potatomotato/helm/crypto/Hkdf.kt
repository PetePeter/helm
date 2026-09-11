package com.potatomotato.helm.crypto

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * HKDF-SHA256 (RFC 5869), extract-then-expand.
 *
 * Written out rather than pulled from a library because this is the one function
 * that MUST agree with Node's `crypto.hkdfSync('sha256', ikm, salt, info, len)`
 * byte for byte. Every key the phone and the desktop share comes through here,
 * so it is pinned by the committed vectors rather than by trust.
 */
object Hkdf {
    private const val ALGORITHM = "HmacSHA256"
    private const val HASH_BYTES = 32

    fun sha256(ikm: ByteArray, salt: ByteArray, info: String, length: Int): ByteArray {
        require(length > 0 && length <= 255 * HASH_BYTES) { "HKDF length out of range" }

        // RFC 5869: an empty salt is treated as HashLen zero bytes, which is what
        // Node does too. Getting this wrong only shows up as a key mismatch.
        val extractKey = if (salt.isEmpty()) ByteArray(HASH_BYTES) else salt
        val prk = hmac(extractKey, ikm)

        val infoBytes = info.toByteArray(Charsets.UTF_8)
        val output = ByteArray(length)
        var previous = ByteArray(0)
        var written = 0
        var counter = 1

        while (written < length) {
            val block = hmac(prk, previous + infoBytes + byteArrayOf(counter.toByte()))
            val take = minOf(block.size, length - written)
            block.copyInto(output, written, 0, take)
            written += take
            previous = block
            counter++
        }
        return output
    }

    fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance(ALGORITHM).run {
            init(SecretKeySpec(key, ALGORITHM))
            doFinal(data)
        }
}
