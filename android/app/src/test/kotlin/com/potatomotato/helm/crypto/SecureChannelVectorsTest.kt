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
        // The fixture pins ONE wire version forever (see VECTOR_PROTOCOL_VERSION
        // in src/mobile/test-vectors.ts) and describes the HANDSHAKE CRYPTO,
        // which protocol 3 did not touch — 3 changed the frame ceiling and made
        // download replies binary. So the vector stays at 2 while the supported
        // range moves on, and what must hold is that this build still speaks a
        // version at least as new as the crypto it is pinned to.
        assertEquals(2, vectors.getInt("version"))
        assertTrue(ProtocolVersion.MAX >= vectors.getInt("version"))
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

        forEachFrame { seq, nonceHex, plaintext, frameHex ->
            assertEquals("seq $seq nonce", nonceHex, Aead.nonce(seq).toHex())
            assertEquals("seq $seq frame", frameHex, sender.seal(plaintext.toByteArray()).toHex())
        }
    }

    @Test
    fun `every desktop AEAD frame carries its sequence as an authenticated prefix`() {
        forEachFrame { seq, _, _, frameHex ->
            assertEquals(
                "seq $seq prefix",
                java.lang.Long.toHexString(seq).padStart(16, '0'),
                frameHex.substring(0, AEAD_SEQ_BYTES * 2),
            )
        }
    }

    @Test
    fun `opening decrypts every desktop AEAD frame in order`() {
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val receiver = AeadReceiver(key)

        forEachFrame { seq, _, plaintext, frameHex ->
            assertEquals(
                "seq $seq",
                plaintext,
                String(receiver.open(frameHex.fromHex())),
            )
        }
    }

    @Test
    fun `a whole frame lost in flight is a gap, then delivery resumes`() {
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val gaps = mutableListOf<LongRange>()
        val receiver = AeadReceiver(key, { from, to -> gaps.add(from..to) })

        // First the three in-order frames, exactly as the guard above consumes them.
        forEachFrame { _, _, plaintext, frameHex ->
            assertEquals(plaintext, String(receiver.open(frameHex.fromHex())))
        }

        // Sequence 3 never arrives; 4 and 5 do. The receiver must report 3..3
        // and decrypt both post-gap frames — a lost message, not a dead link.
        val gapResync = vectors.getJSONObject("gapResync")
        val delivered = gapResync.getJSONArray("delivered")
        for (i in 0 until delivered.length()) {
            val frame = delivered.getJSONObject(i)
            assertEquals(
                "delivered seq ${frame.getInt("seq")}",
                frame.getString("plaintextUtf8"),
                String(receiver.open(frame.getString("frameHex").fromHex())),
            )
        }
        assertEquals(listOf(3L..3L), gaps)
    }

    @Test
    fun `the lost frame really would have decrypted at sequence 3`() {
        // Proves the fixture's gap is a genuine dropped frame, not made-up bytes.
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val gaps = mutableListOf<LongRange>()
        val receiver = AeadReceiver(key, { from, to -> gaps.add(from..to) })
        receiver.open(firstFrame().fromHex())

        val lost = vectors.getJSONObject("gapResync").getString("lostFrameHex").fromHex()
        assertEquals("lost in transit", String(receiver.open(lost)))
        assertEquals(listOf(1L..2L), gaps)
    }

    @Test
    fun `a PING sealed by the initiator and a PONG sealed by the responder both open empty`() {
        val pingPong = vectors.getJSONObject("pingPong")
        val i2r = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val r2i = vectors.getJSONObject("directionKeys").getString("responderToInitiatorHex").fromHex()

        val ping = pingPong.getJSONObject("initiatorToResponder")
        assertEquals(ping.getInt("seq").toLong(), java.lang.Long.parseUnsignedLong(ping.getString("frameHex").substring(0, 16), 16))
        assertTrue(AeadReceiver(i2r).open(ping.getString("frameHex").fromHex()).isEmpty())

        val pong = pingPong.getJSONObject("responderToInitiator")
        assertEquals(pong.getInt("seq").toLong(), java.lang.Long.parseUnsignedLong(pong.getString("frameHex").substring(0, 16), 16))
        assertTrue(AeadReceiver(r2i).open(pong.getString("frameHex").fromHex()).isEmpty())
    }

    @Test
    fun `a frame shorter than seq+tag is refused and burns the receiver`() {
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val short = vectors.getJSONObject("rejected").getString("shortFrameHex").fromHex()
        val receiver = AeadReceiver(key)

        assertThrows { receiver.open(short) }
        assertThrows { receiver.open(firstFrame().fromHex()) }
    }

    @Test
    fun `a frame with a flipped tag bit is refused and burns the receiver`() {
        val key = vectors.getJSONObject("directionKeys").getString("initiatorToResponderHex").fromHex()
        val tampered = vectors.getJSONObject("rejected").getString("tamperedFrameHex").fromHex()
        val receiver = AeadReceiver(key)

        assertThrows { receiver.open(tampered) }
        assertThrows { receiver.open(firstFrame().fromHex()) }
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
        body: (seq: Long, nonceHex: String, plaintext: String, frameHex: String) -> Unit,
    ) {
        val frames = vectors.getJSONArray("aeadFrames")
        assertTrue("the fixture must carry AEAD frames", frames.length() > 0)
        for (i in 0 until frames.length()) {
            val frame = frames.getJSONObject(i)
            body(
                frame.getLong("seq"),
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
