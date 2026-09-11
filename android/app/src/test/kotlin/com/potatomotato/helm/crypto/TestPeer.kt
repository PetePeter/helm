package com.potatomotato.helm.crypto

import java.security.SecureRandom

/**
 * The desktop end, as the phone's tests need it.
 *
 * This is NOT a second implementation of the protocol: every byte it produces
 * comes from the same production [PairingCrypto], [Aead] and [Frames] the phone
 * uses, and those are pinned to the TypeScript side by
 * [SecureChannelVectorsTest]. What lives here is only the initiator's ORDER of
 * operations — the half the phone never plays, and therefore the half that would
 * otherwise be unwritten and untestable.
 */
class HelmInitiator(
    private val pipe: BytePipe,
    private val machineId: String = "desktop-test",
    private val sessionId: String = "mobile-test-session",
    private val psk: ByteArray? = null,
    private val range: ProtocolRange = ProtocolVersion.LOCAL_RANGE,
    private val keyPair: EphemeralKeyPair = X25519Keys.generate(),
    private val nonce: ByteArray = ByteArray(HANDSHAKE_NONCE_BYTES).also { SecureRandom().nextBytes(it) },
) {
    private val reader = FrameReader(::onFrame)

    var sas: String = ""
        private set
    var established = false
        private set
    var refusal: Pair<RefusalCode, String>? = null
        private set
    val received = mutableListOf<ByteArray>()

    private var transcript: ByteArray? = null
    private var sender: AeadSender? = null
    private var receiver: AeadReceiver? = null

    fun start() {
        pipe.onData(reader::push)
        pipe.write(
            encodeFrame(
                FrameType.HELLO,
                encodeFields(
                    listOf(
                        uint32(range.min),
                        uint32(range.max),
                        sessionId.toByteArray(),
                        machineId.toByteArray(),
                        PairingCrypto.computeCommitment(keyPair.publicKeyDER, nonce),
                        "3.5.0".toByteArray(),
                        "".toByteArray(),
                    ),
                ),
            ),
        )
    }

    fun send(message: ByteArray) {
        pipe.write(encodeFrame(FrameType.DATA, requireNotNull(sender).seal(message)))
    }

    /** Send a DATA frame whose ciphertext has been altered in flight. */
    fun sendTampered(message: ByteArray) {
        val frame = requireNotNull(sender).seal(message)
        frame[0] = (frame[0].toInt() xor 0x01).toByte()
        pipe.write(encodeFrame(FrameType.DATA, frame))
    }

    /** Dribble one frame out a byte at a time, to prove the reader buffers. */
    fun sendByteAtATime(message: ByteArray) {
        encodeFrame(FrameType.DATA, requireNotNull(sender).seal(message))
            .forEach { pipe.write(byteArrayOf(it)) }
    }

    fun sendRaw(bytes: ByteArray) = pipe.write(bytes)

    private fun onFrame(type: FrameType, body: ByteArray) {
        when (type) {
            FrameType.RESPONSE -> onResponse(body)
            FrameType.CONFIRM -> onConfirm(body)
            FrameType.DATA -> received.add(requireNotNull(receiver).open(body))
            FrameType.REFUSE -> {
                val (code, message) = decodeFields(body, 2)
                refusal = RefusalCode.fromWire(code.toString(Charsets.UTF_8)).inverted() to
                    message.toString(Charsets.UTF_8)
            }

            else -> throw IllegalStateException("initiator received $type")
        }
    }

    private fun onResponse(body: ByteArray) {
        val (version, peerMachineId, peerPubDER, peerNonce) = decodeFields(body, 4)
        pipe.write(encodeFrame(FrameType.REVEAL, encodeFields(listOf(keyPair.publicKeyDER, nonce))))

        val shared = X25519Keys.sharedSecret(keyPair, peerPubDER)
        val script = PairingCrypto.buildTranscript(
            TranscriptParts(
                version = requireNotNull(fieldAsUint32(version)).toInt(),
                sessionId = sessionId,
                initiatorMachineId = machineId,
                responderMachineId = peerMachineId.toString(Charsets.UTF_8),
                initiatorCertFp = CARRIER_FINGERPRINT,
                responderCertFp = CARRIER_FINGERPRINT,
                initiatorPubDER = keyPair.publicKeyDER,
                responderPubDER = peerPubDER,
                initiatorNonce = nonce,
                responderNonce = peerNonce,
            ),
        )
        transcript = script
        sas = PairingCrypto.deriveSas(shared, script)

        val keys = Aead.deriveDirectionKeys(shared, script, psk)
        sender = AeadSender(keys.initiatorToResponder)
        receiver = AeadReceiver(keys.responderToInitiator)

        pipe.write(
            encodeFrame(
                FrameType.CONFIRM,
                encodeFields(
                    listOf(PairingCrypto.computeConfirmMac(Aead.bindPsk(shared, psk), script)),
                ),
            ),
        )
    }

    private fun onConfirm(body: ByteArray) {
        val (mac) = decodeFields(body, 1)
        check(mac.isNotEmpty()) { "empty confirmation MAC" }
        established = true
    }
}

/**
 * Two pipes wired mouth to ear. Delivery is synchronous and immediate, which
 * makes the handshake a straight-line call chain in a test.
 */
class PipePair {
    val helm: TestPipe = TestPipe()
    val phone: TestPipe = TestPipe()

    init {
        helm.peer = phone
        phone.peer = helm
    }
}

class TestPipe : BytePipe {
    internal var peer: TestPipe? = null
    private var onData: ((ByteArray) -> Unit)? = null
    private var onClose: (() -> Unit)? = null

    var closed = false
        private set

    /** Set to make the next write fail, as a refused GATT notification does. */
    var writeFails = false

    /** Everything this end put on the wire, for asserting on frame types. */
    val written = mutableListOf<ByteArray>()

    override fun write(data: ByteArray) {
        check(!writeFails) { "link write refused" }
        written.add(data)
        peer?.deliver(data)
    }

    override fun onData(handler: (ByteArray) -> Unit) {
        onData = handler
    }

    override fun onClose(handler: () -> Unit) {
        onClose = handler
    }

    override fun close() {
        if (closed) return
        closed = true
        peer?.let { if (!it.closed) it.remoteClosed() }
    }

    private fun remoteClosed() {
        closed = true
        onClose?.invoke()
    }

    private fun deliver(data: ByteArray) {
        if (closed) return
        onData?.invoke(data)
    }

    /** The frame types this end emitted, in order. */
    fun frameTypes(): List<FrameType> = written.mapNotNull { FrameType.fromWire(it[4]) }
}

/** Deferred work the test fires by hand, so a timeout costs no wall time. */
class TestScheduler : ChannelScheduler {
    private var pending: (() -> Unit)? = null

    var cancelled = false
        private set

    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
        pending = action
        return Cancellable {
            cancelled = true
            pending = null
        }
    }

    fun fire() {
        val action = pending ?: error("nothing is scheduled")
        pending = null
        action()
    }
}

/** Collects everything the channel reports, so assertions read as a transcript. */
class RecordingListener : SecureChannelListener {
    var established: SecureChannel? = null
    val messages = mutableListOf<ByteArray>()
    var refusal: Pair<RefusalCode, String>? = null
    var closedReason: String? = null

    override fun onEstablished(channel: SecureChannel) {
        established = channel
    }

    override fun onMessage(plaintext: ByteArray) {
        messages.add(plaintext)
    }

    override fun onRefused(code: RefusalCode, message: String) {
        refusal = code to message
    }

    override fun onClosed(reason: String) {
        closedReason = reason
    }
}
