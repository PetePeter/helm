package com.potatomotato.helm.crypto

import java.security.SecureRandom

/** Nonce length used in the commit-then-reveal exchange. */
const val HANDSHAKE_NONCE_BYTES = 32

/**
 * BLE has no TLS certificate to bind, so the transcript's certificate-fingerprint
 * fields carry this fixed carrier label instead. Identity binding comes from the
 * machine ids, the commitment and the SAS comparison.
 */
const val CARRIER_FINGERPRINT = "helm-mobile-ble-v1"

/**
 * How long the handshake may stall before the phone gives up.
 *
 * This is not belt-and-braces. A GATT notification the central refuses discards
 * the remainder of that message and produces NO error frame, so a half-delivered
 * handshake looks exactly like a peer that went quiet. Silence is the only
 * symptom available, so it has to be the trigger.
 */
const val HANDSHAKE_TIMEOUT_MS = 20_000L

/** Minimal duplex byte pipe. A BLE GATT link and a test double both fit. */
interface BytePipe {
    /** Throws when the link cannot carry the bytes; the channel then closes. */
    fun write(data: ByteArray)
    fun onData(handler: (ByteArray) -> Unit)
    fun onClose(handler: () -> Unit)
    fun close()
}

/** Deferred work, injected so the handshake timeout is testable without waiting. */
fun interface ChannelScheduler {
    fun schedule(delayMs: Long, action: () -> Unit): Cancellable
}

fun interface Cancellable {
    fun cancel()
}

/** Everything the channel tells its owner. All calls arrive on the pipe's thread. */
interface SecureChannelListener {
    /** The handshake authenticated. Compare the SAS first if it is required. */
    fun onEstablished(channel: SecureChannel)

    /** One decrypted application message. */
    fun onMessage(plaintext: ByteArray)

    /** The peer is protocol-incompatible; [message] is fit to show the user. */
    fun onRefused(code: RefusalCode, message: String) {}

    /** Terminal, and always the last call. */
    fun onClosed(reason: String)
}

/**
 * SecureChannel — the phone's responder half of the app-layer handshake, a port
 * of `src/mobile/secure-channel.ts`.
 *
 * Helm is ALWAYS the initiator: it is the BLE central, so it is the end that
 * opens the link. The phone therefore only ever plays responder, and the
 * initiator half is deliberately absent rather than written and unused.
 *
 * ```mermaid
 * sequenceDiagram
 *     participant H as Helm (initiator)
 *     participant P as Phone (responder)
 *     H->>P: HELLO  protocol range, sessionId, machineId, commitment, versions
 *     Note over P: negotiate protocol version FIRST
 *     P--xH: REFUSE  code, human message (no capability disclosed)
 *     P->>H: RESPONSE  negotiated version, machineId, pubKey, nonce
 *     H->>P: REVEAL  pubKey, nonce
 *     Note over H,P: both derive shared secret, transcript, SAS, direction keys
 *     P->>H: CONFIRM  mac
 *     H->>P: CONFIRM  mac
 *     Note over H,P: user compares the 6-digit SAS (first pairing only)
 *     H-->>P: DATA  AES-256-GCM frames
 * ```
 *
 * SECURITY INVARIANTS (do not weaken):
 *  - No plaintext fallback exists. Every failure path closes the channel.
 *  - Nonce reuse is structurally impossible: per-direction keys, implicit
 *    monotonic counters (see [Aead]).
 *  - Keys live only in memory. Only the pairing PSK is ever persisted, by the
 *    caller, and only after the user confirms the SAS.
 *  - On a first pairing the user MUST compare the SAS; application data cannot
 *    be sent or delivered before `confirmSas(true)`.
 */
class SecureChannel(
    private val pipe: BytePipe,
    private val machineId: String,
    private val listener: SecureChannelListener,
    private val scheduler: ChannelScheduler,
    /**
     * The stored PSK for a given desktop, or null to pair afresh.
     *
     * Resolved at HELLO rather than at construction: the phone is the responder,
     * so it learns which desktop is calling BEFORE any key is derived, and can
     * pick the right PSK outright. The desktop has to guess a candidate and
     * retry, because it cannot know who answered until the handshake authenticates.
     */
    private val pskFor: (machineId: String) -> ByteArray? = { null },
    private val range: ProtocolRange = ProtocolVersion.LOCAL_RANGE,
    private val labels: ProtocolLabels = ProtocolLabels.PHONE,
    private val timeoutMs: Long = HANDSHAKE_TIMEOUT_MS,
    private val keyPair: EphemeralKeyPair = X25519Keys.generate(),
    private val nonce: ByteArray = randomNonce(),
) {
    private val reader = FrameReader(::handleFrame)
    private var timeout: Cancellable? = null

    private var closed = false
    private var started = false

    private var sessionId = ""
    private var version = 0
    private var peerMachineId = ""
    private var peerCommitment: ByteArray? = null
    private var psk: ByteArray? = null

    private var transcript: ByteArray? = null
    private var confirmSecret: ByteArray? = null
    private var sender: AeadSender? = null
    private var receiver: AeadReceiver? = null

    private var sasDigits = ""
    private var derivedPsk: ByteArray? = null
    private var sasConfirmed = false
    private var confirmSent = false
    private var peerConfirmed = false
    private var established = false

    /** Messages decrypted before the local user finished comparing the SAS. */
    private val pending = ArrayDeque<ByteArray>()

    /** Helm's product version, for display only. Never a compatibility gate. */
    var peerProductVersion: String = ""
        private set

    /** The Helm build the peer recommends. Display only. */
    var peerMinVersion: String = ""
        private set

    /** The agreed wire protocol version; 0 until negotiation succeeds. */
    val negotiatedVersion: Int get() = version

    /**
     * Helm's stable machine identity, as bound into the transcript. The pairing
     * record is keyed on this: a BLE address rotates, this does not.
     */
    val peerMachine: String get() = peerMachineId

    /** The 6 digits the user compares on both screens. */
    val sas: String get() = sasDigits

    /** True until the user has confirmed the SAS on a first pairing. */
    val sasConfirmationRequired: Boolean get() = psk == null && !sasConfirmed

    val isClosed: Boolean get() = closed

    /**
     * The PSK to persist so future connections skip the SAS comparison. Derived,
     * never transmitted, and only meaningful once the user has confirmed.
     */
    val pairingPsk: ByteArray
        get() = derivedPsk ?: throw IllegalStateException("Handshake has not completed")

    /** Attach to the pipe and wait for Helm's HELLO. Idempotent. */
    fun start() {
        if (started || closed) return
        started = true
        timeout = scheduler.schedule(timeoutMs) { close("handshake timed out") }
        pipe.onClose { close("pipe closed") }
        pipe.onData { chunk -> onPipeData(chunk) }
    }

    /**
     * Record the user's verdict on the SAS. `false` closes the channel; there is
     * no "continue anyway", and nothing has been persisted at this point.
     */
    fun confirmSas(matches: Boolean) {
        if (closed) return
        if (!matches) {
            close("SAS rejected by the user")
            return
        }
        sasConfirmed = true
        while (pending.isNotEmpty() && !closed) listener.onMessage(pending.removeFirst())
    }

    /** Encrypt and send one application message. */
    fun send(message: ByteArray) {
        check(!closed) { "SecureChannel is closed" }
        val aead = sender ?: throw IllegalStateException("Handshake has not completed")
        check(!sasConfirmationRequired) { "SAS must be confirmed before sending application data" }
        writeFrame(FrameType.DATA, aead.seal(message))
    }

    /** Close and drop all key material. Idempotent. */
    fun close(reason: String = "closed") {
        if (closed) return
        closed = true
        timeout?.cancel()
        timeout = null
        sender = null
        receiver = null
        confirmSecret = null
        derivedPsk = null
        pending.clear()
        try {
            pipe.close()
        } catch (_: Exception) {
            // A pipe that is already gone is not an error worth propagating.
        }
        listener.onClosed(reason)
    }

    // ---------------------------------------------------------------- handshake

    private fun onPipeData(chunk: ByteArray) {
        if (closed) return
        try {
            reader.push(chunk)
        } catch (error: Exception) {
            close(error.message ?: "malformed frame")
        }
    }

    private fun handleFrame(type: FrameType, body: ByteArray) {
        when (type) {
            FrameType.HELLO -> handleHello(body)
            FrameType.REVEAL -> handleReveal(body)
            FrameType.CONFIRM -> handleConfirm(body)
            FrameType.DATA -> handleData(body)
            FrameType.REFUSE -> handleRefuse(body)
            // Responder-only: a peer claiming our role is not a peer we can serve.
            FrameType.RESPONSE -> throw IllegalStateException("RESPONSE received by the responder")
        }
    }

    private fun handleHello(body: ByteArray) {
        val fields = decodeFields(body, 7)
        val min = fieldAsUint32(fields[0])
        val max = fieldAsUint32(fields[1])

        // Negotiation runs BEFORE anything is disclosed: on refusal the peer
        // learns only that it is incompatible — no machine id, no key, no nonce.
        val peerRange = if (min == null || max == null) null else ProtocolVersion.parseRange(min, max)
        if (peerRange == null) {
            refuse(RefusalCode.MALFORMED_RANGE, ProtocolVersion.malformedMessage(labels))
            return
        }
        when (val outcome = ProtocolVersion.negotiate(range, peerRange, labels)) {
            is Negotiation.Refused -> {
                refuse(outcome.code, outcome.message)
                return
            }

            is Negotiation.Agreed -> version = outcome.version
        }

        sessionId = fields[2].toString(Charsets.UTF_8)
        peerMachineId = fields[3].toString(Charsets.UTF_8)
        psk = pskFor(peerMachineId)
        peerCommitment = fields[4]
        peerProductVersion = fields[5].toString(Charsets.UTF_8)
        peerMinVersion = fields[6].toString(Charsets.UTF_8)

        writeFrame(
            FrameType.RESPONSE,
            encodeFields(
                listOf(
                    uint32(version),
                    machineId.toByteArray(Charsets.UTF_8),
                    keyPair.publicKeyDER,
                    nonce,
                ),
            ),
        )
    }

    private fun handleReveal(body: ByteArray) {
        val (peerPubDER, peerNonce) = decodeFields(body, 2)
        val commitment = peerCommitment
            ?: throw IllegalStateException("REVEAL received before HELLO")
        if (!PairingCrypto.verifyCommitment(commitment, peerPubDER, peerNonce)) {
            throw IllegalStateException("Commitment does not match the revealed key")
        }
        deriveSession(peerPubDER, peerNonce)
    }

    private fun handleConfirm(body: ByteArray) {
        val (mac) = decodeFields(body, 1)
        val secret = confirmSecret
        val script = transcript
        if (secret == null || script == null) {
            throw IllegalStateException("CONFIRM received before the key exchange completed")
        }
        if (!PairingCrypto.verifyConfirmMac(secret, script, mac)) {
            throw IllegalStateException("Peer confirmation MAC failed")
        }
        peerConfirmed = true
        maybeComplete()
    }

    private fun handleData(body: ByteArray) {
        val aead = receiver
            ?: throw IllegalStateException("Data frame received before the handshake completed")
        val plaintext = try {
            aead.open(body)
        } catch (_: Exception) {
            throw IllegalStateException("Frame authentication failed - closing channel")
        }
        if (sasConfirmationRequired) {
            pending.addLast(plaintext)
            return
        }
        listener.onMessage(plaintext)
    }

    private fun handleRefuse(body: ByteArray) {
        val (code, message) = decodeFields(body, 2)
        // The wire code is written from the REFUSER's point of view; invert it so
        // it always reads relative to whoever holds it. The human message names
        // both sides explicitly, so it needs no inversion.
        listener.onRefused(
            RefusalCode.fromWire(code.toString(Charsets.UTF_8)).inverted(),
            message.toString(Charsets.UTF_8),
        )
        close("protocol refused by ${labels.peer}")
    }

    /** Tell the peer why it is incompatible, then close. No capability exposed. */
    private fun refuse(code: RefusalCode, message: String) {
        writeFrame(
            FrameType.REFUSE,
            encodeFields(
                listOf(code.wire.toByteArray(Charsets.UTF_8), message.toByteArray(Charsets.UTF_8)),
            ),
        )
        listener.onRefused(code, message)
        close(message)
    }

    /**
     * Build the byte-identical transcript both peers see, derive the shared
     * secret, the SAS, the PSK and the two directional keys, then send our MAC.
     */
    private fun deriveSession(peerPubDER: ByteArray, peerNonce: ByteArray) {
        check(version != 0) { "Key exchange attempted before version negotiation" }
        val shared = X25519Keys.sharedSecret(keyPair, peerPubDER)
        val script = PairingCrypto.buildTranscript(
            TranscriptParts(
                version = version,
                sessionId = sessionId,
                initiatorMachineId = peerMachineId,
                responderMachineId = machineId,
                initiatorCertFp = CARRIER_FINGERPRINT,
                responderCertFp = CARRIER_FINGERPRINT,
                initiatorPubDER = peerPubDER,
                responderPubDER = keyPair.publicKeyDER,
                initiatorNonce = peerNonce,
                responderNonce = nonce,
            ),
        )
        transcript = script

        val bound = Aead.bindPsk(shared, psk)
        confirmSecret = bound
        sasDigits = PairingCrypto.deriveSas(shared, script)
        derivedPsk = PairingCrypto.derivePsk(shared, script)

        val keys = Aead.deriveDirectionKeys(shared, script, psk)
        sender = AeadSender(keys.responderToInitiator)
        receiver = AeadReceiver(keys.initiatorToResponder)

        writeFrame(
            FrameType.CONFIRM,
            encodeFields(listOf(PairingCrypto.computeConfirmMac(bound, script))),
        )
        confirmSent = true
        maybeComplete()
    }

    private fun maybeComplete() {
        if (established || !confirmSent || !peerConfirmed) return
        established = true
        timeout?.cancel()
        timeout = null
        listener.onEstablished(this)
    }

    private fun writeFrame(type: FrameType, body: ByteArray) {
        if (closed) return
        try {
            pipe.write(encodeFrame(type, body))
        } catch (error: Exception) {
            // A write the link could not carry leaves the peer waiting forever.
            // Closing here is what turns that silence into a reconnect.
            close(error.message ?: "link write failed")
        }
    }
}

private fun randomNonce(): ByteArray =
    ByteArray(HANDSHAKE_NONCE_BYTES).also { SecureRandom().nextBytes(it) }
