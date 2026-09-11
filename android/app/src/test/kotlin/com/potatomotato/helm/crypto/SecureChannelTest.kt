package com.potatomotato.helm.crypto

import com.potatomotato.helm.fromHex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The responder state machine: order, refusal and the failure paths.
 *
 * The crypto itself is not what is under test here — [SecureChannelVectorsTest]
 * pins that to the desktop. What is under test is everything the vectors cannot
 * express: what the phone discloses and WHEN, what it refuses, and that every
 * failure ends in a closed channel with nothing kept.
 */
class SecureChannelTest {
    private val pipes = PipePair()
    private val scheduler = TestScheduler()
    private val listener = RecordingListener()

    private fun phone(psk: ByteArray? = null, range: ProtocolRange = ProtocolVersion.LOCAL_RANGE) =
        SecureChannel(
            pipe = pipes.phone,
            machineId = "phone-test",
            listener = listener,
            scheduler = scheduler,
            pskFor = { psk },
            range = range,
        ).also { it.start() }

    private fun helm(psk: ByteArray? = null, range: ProtocolRange = ProtocolVersion.LOCAL_RANGE) =
        HelmInitiator(pipes.helm, psk = psk, range = range)

    @Test
    fun `a first pairing completes and both ends derive the same six digits`() {
        val channel = phone()
        val desktop = helm().also { it.start() }

        assertNotNull("the handshake must complete", listener.established)
        assertTrue(desktop.established)
        assertEquals(6, channel.sas.length)
        assertEquals("the SAS must match on both screens", desktop.sas, channel.sas)
        assertEquals("desktop-test", channel.peerMachine)
        assertEquals("3.5.0", channel.peerProductVersion)
        assertEquals(ProtocolVersion.MAX, channel.negotiatedVersion)
    }

    @Test
    fun `a first pairing demands the SAS before any application data moves`() {
        val channel = phone()
        val desktop = helm().also { it.start() }

        assertTrue(channel.sasConfirmationRequired)
        assertThrows { channel.send("too early".toByteArray()) }

        // Data that arrives before the user has looked is held, not dropped.
        desktop.send("queued".toByteArray())
        assertTrue(listener.messages.isEmpty())

        channel.confirmSas(true)
        assertEquals(1, listener.messages.size)
        assertEquals("queued", String(listener.messages.single()))

        channel.send("now fine".toByteArray())
        assertEquals("now fine", String(desktop.received.single()))
    }

    @Test
    fun `rejecting the SAS closes the channel and leaves no key material behind`() {
        val channel = phone()
        helm().start()
        assertNotNull("the PSK exists right up until the verdict", channel.pairingPsk)

        channel.confirmSas(false)

        assertTrue(channel.isClosed)
        assertEquals("SAS rejected by the user", listener.closedReason)
        // Nothing survives for a caller to persist after the fact.
        assertThrows { channel.pairingPsk }
    }

    @Test
    fun `a stored PSK reconnects with no SAS prompt`() {
        val psk = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff".fromHex()
        val channel = phone(psk = psk)
        val desktop = helm(psk = psk).also { it.start() }

        assertNotNull(listener.established)
        assertFalse(channel.sasConfirmationRequired)

        channel.send("no prompt".toByteArray())
        assertEquals("no prompt", String(desktop.received.single()))
    }

    @Test
    fun `a peer that does not know the PSK cannot complete the handshake`() {
        val channel = phone(psk = ByteArray(32) { 1 })
        helm(psk = ByteArray(32) { 2 }).start()

        assertTrue(channel.isClosed)
        assertNull(listener.established)
        assertEquals("Peer confirmation MAC failed", listener.closedReason)
    }

    @Test
    fun `a revealed key that does not match the commitment is refused`() {
        val channel = phone()
        val desktop = helm()
        desktop.start()
        // Reveal a DIFFERENT key than the one committed to in HELLO.
        desktop.sendRaw(
            encodeFrame(
                FrameType.REVEAL,
                encodeFields(listOf(X25519Keys.generate().publicKeyDER, ByteArray(32))),
            ),
        )

        assertTrue(channel.isClosed)
        assertEquals("Commitment does not match the revealed key", listener.closedReason)
    }

    @Test
    fun `an incompatible peer is refused before anything is disclosed`() {
        val channel = phone(range = ProtocolRange(2, 2))
        val desktop = helm(range = ProtocolRange(1, 1)).also { it.start() }

        assertEquals(
            "only the refusal may reach an incompatible peer",
            listOf(FrameType.REFUSE),
            pipes.phone.frameTypes(),
        )
        assertEquals(RefusalCode.PEER_TOO_OLD, listener.refusal?.first)
        assertEquals(RefusalCode.PEER_TOO_NEW, desktop.refusal?.first)
        assertTrue(desktop.refusal!!.second.contains("Update Helm"))
        assertTrue(channel.isClosed)
        assertEquals("", channel.peerMachine)
    }

    @Test
    fun `a malformed protocol range is refused rather than defaulted`() {
        val channel = phone()
        // HELLO is hand-built: no conformant initiator would offer version 0.
        pipes.helm.write(
            encodeFrame(
                FrameType.HELLO,
                encodeFields(
                    listOf(
                        uint32(0), // version 0 is not a version
                        uint32(1),
                        "s".toByteArray(),
                        "m".toByteArray(),
                        ByteArray(32),
                        "".toByteArray(),
                        "".toByteArray(),
                    ),
                ),
            ),
        )

        assertEquals(listOf(FrameType.REFUSE), pipes.phone.frameTypes())
        assertEquals(RefusalCode.MALFORMED_RANGE, listener.refusal?.first)
        assertTrue(channel.isClosed)
    }

    @Test
    fun `a tampered data frame closes the channel instead of delivering plaintext`() {
        val channel = phone()
        val desktop = helm().also { it.start() }
        channel.confirmSas(true)

        desktop.sendTampered("payload".toByteArray())

        assertTrue(listener.messages.isEmpty())
        assertTrue(channel.isClosed)
        assertEquals("Frame authentication failed - closing channel", listener.closedReason)
    }

    @Test
    fun `an absurd frame length is refused rather than read as a negative int`() {
        val channel = phone()
        // 0xffffffff: an Int would make this negative and slip past the cap.
        pipes.helm.write("ffffffff01".fromHex())

        assertTrue(channel.isClosed)
        assertEquals("frame length out of range", listener.closedReason)
    }

    @Test
    fun `a handshake that stalls half way is closed by the timeout`() {
        val channel = phone()
        helm() // HELLO never sent: the phone waits.

        assertNull(listener.established)
        scheduler.fire()

        assertTrue(channel.isClosed)
        assertEquals("handshake timed out", listener.closedReason)
    }

    @Test
    fun `the timeout is cancelled once the handshake completes`() {
        phone()
        helm().start()

        assertTrue("a live channel must not be torn down later", scheduler.cancelled)
        assertNotNull(listener.established)
    }

    @Test
    fun `a write the link cannot carry closes the channel rather than stalling`() {
        val channel = phone()
        pipes.phone.writeFails = true
        helm().start()

        assertTrue(channel.isClosed)
        assertEquals("link write refused", listener.closedReason)
    }

    @Test
    fun `a frame split across arbitrary chunk boundaries still parses`() {
        val channel = phone()
        val desktop = helm().also { it.start() }
        channel.confirmSas(true)

        // The transport delivers whole messages today, but the framing is parsed
        // as a stream: a peer that ever split or coalesced a write must not
        // silently kill the link.
        desktop.sendByteAtATime("dribbled".toByteArray())

        assertFalse(channel.isClosed)
        assertEquals("dribbled", String(listener.messages.single()))
    }

    @Test
    fun `a RESPONSE frame aimed at the phone is refused - it is never the initiator`() {
        val channel = phone()
        pipes.helm.write(encodeFrame(FrameType.RESPONSE, encodeFields(listOf(ByteArray(0)))))

        assertTrue(channel.isClosed)
        assertEquals("RESPONSE received by the responder", listener.closedReason)
    }
}
