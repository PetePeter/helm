package com.potatomotato.helm.crypto

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.security.SecureRandom

/**
 * Ephemeral X25519 keys and the SPKI-DER encoding that crosses the wire.
 *
 * WHY BOUNCY CASTLE AND NOT THE PLATFORM: the JCE gained XDH in API 33, and
 * minSdk is 26. Falling back to a weaker curve on old devices would be a silent
 * downgrade, so the scalar multiplication comes from a library that behaves
 * identically on every supported release. BC is used for X25519 ONLY — hashing,
 * HMAC and AES-GCM stay on the platform providers, which are hardware-backed.
 */
object X25519Keys {
    /**
     * RFC 8410 SPKI prefix for an X25519 public key:
     * SEQUENCE { SEQUENCE { OID 1.3.101.110 }, BIT STRING (32 bytes) }.
     *
     * Fixed-shape, so parsing is an exact-match check rather than a DER walk.
     * That is deliberate: it is shorter, it cannot be tricked by a re-encoded
     * length, and it refuses a key of any other algorithm by construction —
     * which is the type-confusion guard `computeSharedSecret` makes explicitly
     * on the desktop.
     */
    private val SPKI_PREFIX = byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
    )

    const val RAW_KEY_BYTES = 32
    val SPKI_BYTES = SPKI_PREFIX.size + RAW_KEY_BYTES

    fun generate(random: SecureRandom = SecureRandom()): EphemeralKeyPair {
        val privateKey = X25519PrivateKeyParameters(random)
        return EphemeralKeyPair(privateKey, spkiDer(privateKey.generatePublicKey().encoded))
    }

    /** Wrap a raw 32-byte public key as SPKI-DER. */
    fun spkiDer(raw: ByteArray): ByteArray {
        require(raw.size == RAW_KEY_BYTES) { "an X25519 public key is $RAW_KEY_BYTES bytes" }
        return SPKI_PREFIX + raw
    }

    /** Unwrap SPKI-DER. Throws on anything that is not an X25519 public key. */
    fun rawFromSpki(der: ByteArray): ByteArray {
        if (der.size != SPKI_BYTES || !der.copyOf(SPKI_PREFIX.size).contentEquals(SPKI_PREFIX)) {
            throw IllegalArgumentException("Peer key is not an X25519 SPKI public key")
        }
        return der.copyOfRange(SPKI_PREFIX.size, der.size)
    }

    /**
     * Raw X25519 shared secret from our private key and the peer's SPKI-DER.
     * A small-order peer key yields an all-zero secret, which BC refuses.
     */
    fun sharedSecret(own: EphemeralKeyPair, peerPublicDER: ByteArray): ByteArray {
        val peer = X25519PublicKeyParameters(rawFromSpki(peerPublicDER), 0)
        val secret = ByteArray(RAW_KEY_BYTES)
        X25519Agreement().apply { init(own.privateKey) }.calculateAgreement(peer, secret, 0)
        return secret
    }
}

class EphemeralKeyPair(
    internal val privateKey: X25519PrivateKeyParameters,
    /** SPKI-DER encoding of the public key, exchanged on the wire. */
    val publicKeyDER: ByteArray,
)
