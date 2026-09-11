package com.potatomotato.helm.crypto

import com.potatomotato.helm.fromHex
import com.potatomotato.helm.loadFixture
import com.potatomotato.helm.toHex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The test that stops the two halves from silently disagreeing.
 *
 * Every derivation below is a place where an endianness slip, a UTF-8 slip or a
 * missing length prefix would produce a DIFFERENT key on the phone than on the
 * desktop — and the symptom of that is not an exception, it is "pairing just
 * never works". So nothing here is hand-copied: the expected values come from
 * the committed vectors the TypeScript suite asserts against
 * (tests/fixtures/secure-channel-vectors.json, emitted by P-0735).
 *
 * Regenerating that file is a wire break.
 */
class SecureChannelVectorsTest {
    private val vectors: JSONObject = loadFixture("secure-channel-vectors.json")
    private val inputs: JSONObject = vectors.getJSONObject("inputs")

    private val shared = inputs.getString("sharedSecretHex").fromHex()
    private val psk = inputs.getString("pskHex").fromHex()
    private val initiatorPub = inputs.getString("initiatorPubDERHex").fromHex()
    private val responderPub = inputs.getString("responderPubDERHex").fromHex()
    private val initiatorNonce = inputs.getString("initiatorNonceHex").fromHex()
    private val responderNonce = inputs.getString("responderNonceHex").fromHex()

    private val transcript: ByteArray = PairingCrypto.buildTranscript(
        TranscriptParts(
            version = vectors.getInt("version"),
            sessionId = inputs.getString("sessionId"),
            initiatorMachineId = inputs.getString("initiatorMachineId"),
            responderMachineId = inputs.getString("responderMachineId"),
            initiatorCertFp = vectors.getString("carrierFingerprint"),
            responderCertFp = vectors.getString("carrierFingerprint"),
            initiatorPubDER = initiatorPub,
            responderPubDER = responderPub,
            initiatorNonce = initiatorNonce,
            responderNonce = responderNonce,
        ),
    )

    @Test
    fun `the carrier fingerprint and protocol version match the desktop`() {
        assertEquals(vectors.getString("carrierFingerprint"), CARRIER_FINGERPRINT)
        assertEquals(vectors.getInt("version"), ProtocolVersion.MAX)
    }

    @Test
    fun `the transcript is byte-identical to the desktop transcript`() {
        assertEquals(vectors.getString("transcriptHex"), transcript.toHex())
    }

    @Test
    fun `the commitment matches`() {
        assertEquals(
            vectors.getString("commitmentHex"),
            PairingCrypto.computeCommitment(initiatorPub, initiatorNonce).toHex(),
        )
        assertTrue(
            PairingCrypto.verifyCommitment(
                vectors.getString("commitmentHex").fromHex(),
                initiatorPub,
                initiatorNonce,
            ),
        )
    }

    @Test
    fun `the six SAS digits match the desktop`() {
        assertEquals(vectors.getString("sas"), PairingCrypto.deriveSas(shared, transcript))
    }

    @Test
    fun `the pairing PSK matches the desktop`() {
        assertEquals(
            vectors.getString("pairingPskHex"),
            PairingCrypto.derivePsk(shared, transcript).toHex(),
        )
    }

    @Test
    fun `the confirm MAC matches, with and without a bound PSK`() {
        assertEquals(
            vectors.getString("confirmMacHex"),
            PairingCrypto.computeConfirmMac(shared, transcript).toHex(),
        )
        assertEquals(
            vectors.getString("confirmMacWithPskHex"),
            PairingCrypto.computeConfirmMac(Aead.bindPsk(shared, psk), transcript).toHex(),
        )
        assertTrue(
            PairingCrypto.verifyConfirmMac(
                shared,
                transcript,
                vectors.getString("confirmMacHex").fromHex(),
            ),
        )
    }

    @Test
    fun `a peer that does not know the PSK produces a different confirm MAC`() {
        assertFalse(
            PairingCrypto.verifyConfirmMac(
                shared,
                transcript,
                vectors.getString("confirmMacWithPskHex").fromHex(),
            ),
        )
    }

    @Test
    fun `both direction keys match, with and without a bound PSK`() {
        val plain = Aead.deriveDirectionKeys(shared, transcript, null)
        val bound = Aead.deriveDirectionKeys(shared, transcript, psk)
        val expectedPlain = vectors.getJSONObject("directionKeys")
        val expectedBound = vectors.getJSONObject("directionKeysWithPsk")

        assertEquals(expectedPlain.getString("initiatorToResponderHex"), plain.initiatorToResponder.toHex())
        assertEquals(expectedPlain.getString("responderToInitiatorHex"), plain.responderToInitiator.toHex())
        assertEquals(expectedBound.getString("initiatorToResponderHex"), bound.initiatorToResponder.toHex())
        assertEquals(expectedBound.getString("responderToInitiatorHex"), bound.responderToInitiator.toHex())
    }

    @Test
    fun `the two directions never share a key`() {
        val keys = Aead.deriveDirectionKeys(shared, transcript, null)
        assertNotEquals(keys.initiatorToResponder.toHex(), keys.responderToInitiator.toHex())
    }

    @Test
    fun `sealing reproduces every desktop AEAD frame byte for byte`() {
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val sender = AeadSender(key)

        forEachFrame { counter, nonceHex, plaintext, frameHex ->
            assertEquals("counter $counter nonce", nonceHex, Aead.nonce(counter).toHex())
            assertEquals("counter $counter frame", frameHex, sender.seal(plaintext.toByteArray()).toHex())
        }
    }

    @Test
    fun `opening decrypts every desktop AEAD frame in order`() {
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val receiver = AeadReceiver(key)

        forEachFrame { counter, _, plaintext, frameHex ->
            assertEquals(
                "counter $counter",
                plaintext,
                String(receiver.open(frameHex.fromHex())),
            )
        }
    }

    @Test
    fun `a tampered ciphertext fails authentication and burns the receiver`() {
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val receiver = AeadReceiver(key)
        val frame = firstFrame().fromHex()
        frame[0] = (frame[0].toInt() xor 0x01).toByte()

        assertThrows { receiver.open(frame) }
        // No resynchronisation path: even the genuine frame is refused afterwards.
        assertThrows { receiver.open(firstFrame().fromHex()) }
    }

    @Test
    fun `a replayed frame is rejected because the counter has already moved on`() {
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val receiver = AeadReceiver(key)

        receiver.open(firstFrame().fromHex())
        assertThrows { receiver.open(firstFrame().fromHex()) }
    }

    @Test
    fun `a frame reflected back at its sender fails, because each direction has its own key`() {
        val keys = Aead.deriveDirectionKeys(shared, transcript, null)
        val frame = AeadSender(keys.initiatorToResponder).seal("hello".toByteArray())

        // The initiator receives under r2i, so its own i2r frame cannot authenticate.
        assertThrows { AeadReceiver(keys.responderToInitiator).open(frame) }
    }

    @Test
    fun `a frame shorter than its tag is refused`() {
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        assertThrows { AeadReceiver(key).open(ByteArray(AEAD_TAG_BYTES - 1)) }
    }

    private fun firstFrame(): String =
        vectors.getJSONArray("aeadFrames").getJSONObject(0).getString("frameHex")

    private fun forEachFrame(
        body: (counter: Long, nonceHex: String, plaintext: String, frameHex: String) -> Unit,
    ) {
        val frames = vectors.getJSONArray("aeadFrames")
        assertTrue("the fixture must carry AEAD frames", frames.length() > 0)
        for (i in 0 until frames.length()) {
            val frame = frames.getJSONObject(i)
            body(
                frame.getLong("counter"),
                frame.getString("nonceHex"),
                frame.getString("plaintextUtf8"),
                frame.getString("frameHex"),
            )
        }
    }
}

/** JUnit 4's assertThrows without pinning an exception class we do not promise. */
internal fun assertThrows(body: () -> Unit): Exception {
    try {
        body()
    } catch (error: Exception) {
        return error
    }
    throw AssertionError("expected the call to fail, but it returned")
}
