package com.potatomotato.helm.ble

/**
 * BleFraming — the only layer on the phone that knows a GATT attribute write is
 * not a stream. It is a byte-for-byte mirror of Helm's `src/mobile/ble/ble-framing.ts`.
 *
 * Wire format (identical on both ends):
 *
 *   chunk := seq:u8 | flags:u8 | [ totalLength:u32be if FIRST ] | payload
 *   flags := bit0 FIRST | bit1 LAST
 *
 * `seq` wraps at 256 and exists only to detect loss: a dropped notification
 * whose halves were silently concatenated would corrupt the AEAD frame above
 * with no error. The total length rides on the FIRST chunk so the cap is
 * enforced before a byte is buffered.
 *
 * This file deliberately contains NO Android framework types so it can be
 * tested on the JVM against the committed conformance vectors
 * (`tests/fixtures/ble-framing-vectors.json`). Do not re-derive the format from
 * this comment — assert against the fixture.
 */
object BleFraming {
    /** Bytes of chunk header present on every chunk: seq + flags. */
    const val CHUNK_HEADER_BYTES = 2

    /** The u32be total-message length that rides on the FIRST chunk only. */
    const val LENGTH_PREFIX_BYTES = 4

    /** Overhead of a FIRST chunk: header + length prefix. */
    const val CHUNK_OVERHEAD_FIRST = CHUNK_HEADER_BYTES + LENGTH_PREFIX_BYTES

    /**
     * Smallest chunk size a link may negotiate: the BLE 4.0 default ATT MTU of
     * 23 minus the 3-byte ATT notification header.
     */
    const val MIN_CHUNK_BYTES = 20

    /**
     * Hard ceiling on a single reassembled message. A peer that lies about its
     * length is refused at the FIRST chunk, so reassembly memory is bounded by
     * this value no matter what arrives.
     */
    const val MAX_MESSAGE_BYTES = 256 * 1024

    const val FLAG_FIRST = 0b01
    const val FLAG_LAST = 0b10

    /** ATT notification/write overhead: a payload is the MTU minus three bytes. */
    const val ATT_OVERHEAD_BYTES = 3

    /** Usable payload for a negotiated ATT MTU, never below the BLE 4.0 floor. */
    fun chunkSizeForMtu(mtu: Int): Int = maxOf(MIN_CHUNK_BYTES, mtu - ATT_OVERHEAD_BYTES)
}

/** Splits whole messages into MTU-sized chunks, carrying the sequence counter. */
class BleChunker(initialSeq: Int = 0) {
    private var seq: Int = initialSeq and 0xff

    /**
     * Chunk [message] for a link whose current writable payload is [chunkSize]
     * bytes. The size is passed per call, not stored, because the MTU can change
     * mid-connection.
     */
    fun chunk(message: ByteArray, chunkSize: Int): List<ByteArray> {
        require(chunkSize > BleFraming.CHUNK_OVERHEAD_FIRST) {
            "chunk size $chunkSize is too small to carry a first-chunk header"
        }
        require(message.size <= BleFraming.MAX_MESSAGE_BYTES) {
            "message of ${message.size} bytes exceeds the ${BleFraming.MAX_MESSAGE_BYTES}-byte cap"
        }

        val chunks = mutableListOf<ByteArray>()
        var offset = 0
        var first = true

        do {
            val overhead = if (first) BleFraming.CHUNK_OVERHEAD_FIRST else BleFraming.CHUNK_HEADER_BYTES
            val take = minOf(chunkSize - overhead, message.size - offset)
            val last = offset + take >= message.size
            val chunk = ByteArray(overhead + take)

            chunk[0] = nextSeq().toByte()
            chunk[1] = (
                (if (first) BleFraming.FLAG_FIRST else 0) or (if (last) BleFraming.FLAG_LAST else 0)
                ).toByte()
            if (first) writeUInt32BE(chunk, BleFraming.CHUNK_HEADER_BYTES, message.size)
            message.copyInto(chunk, overhead, offset, offset + take)

            chunks.add(chunk)
            offset += take
            first = false
        } while (offset < message.size)

        return chunks
    }

    private fun nextSeq(): Int {
        val value = seq
        seq = (seq + 1) and 0xff
        return value
    }

    private fun writeUInt32BE(target: ByteArray, at: Int, value: Int) {
        target[at] = (value ushr 24 and 0xff).toByte()
        target[at + 1] = (value ushr 16 and 0xff).toByte()
        target[at + 2] = (value ushr 8 and 0xff).toByte()
        target[at + 3] = (value and 0xff).toByte()
    }
}

/**
 * Reassembles chunks into whole messages.
 *
 * A drop is never fatal: the reassembler resynchronises on the next FIRST
 * chunk, so one lost notification costs one message rather than the link.
 */
class BleReassembler(
    private val onMessage: (ByteArray) -> Unit,
    private val onDrop: (String) -> Unit = {},
) {
    private var parts = mutableListOf<ByteArray>()
    private var assembled = 0
    private var expectedLength = 0
    private var inFlight = false
    private var expectedSeq: Int? = null

    /** Bytes currently held for an in-flight message. Bounded by MAX_MESSAGE_BYTES. */
    val bufferedBytes: Int get() = assembled

    fun push(chunk: ByteArray) {
        if (chunk.size < BleFraming.CHUNK_HEADER_BYTES) {
            onDrop("chunk too short to hold a header")
            return
        }

        val seq = chunk[0].toInt() and 0xff
        val flags = chunk[1].toInt() and 0xff
        val isFirst = (flags and BleFraming.FLAG_FIRST) != 0

        val expected = expectedSeq
        if (expected != null && seq != expected) {
            // A gap means at least one notification was lost. Whatever is in
            // flight is unrecoverable; resynchronise rather than concatenate
            // across the hole.
            reset()
            onDrop("sequence gap: expected $expected, got $seq")
            if (!isFirst) {
                expectedSeq = (seq + 1) and 0xff
                return
            }
        }
        expectedSeq = (seq + 1) and 0xff

        if (isFirst) {
            if (inFlight) {
                reset()
                onDrop("restart: a new message began before the previous one finished")
            }
            if (chunk.size < BleFraming.CHUNK_OVERHEAD_FIRST) {
                onDrop("first chunk too short to hold a length prefix")
                return
            }
            val declared = readUInt32BE(chunk, BleFraming.CHUNK_HEADER_BYTES)
            if (declared > BleFraming.MAX_MESSAGE_BYTES) {
                reset()
                onDrop("declared length $declared exceeds the ${BleFraming.MAX_MESSAGE_BYTES}-byte cap")
                return
            }
            inFlight = true
            expectedLength = declared.toInt()
            append(chunk.copyOfRange(BleFraming.CHUNK_OVERHEAD_FIRST, chunk.size), flags)
            return
        }

        if (!inFlight) {
            onDrop("continuation chunk with no message in flight")
            return
        }
        append(chunk.copyOfRange(BleFraming.CHUNK_HEADER_BYTES, chunk.size), flags)
    }

    private fun append(payload: ByteArray, flags: Int) {
        if (assembled + payload.size > expectedLength) {
            reset()
            onDrop("overrun: payload exceeds the declared message length")
            return
        }

        parts.add(payload)
        assembled += payload.size

        if ((flags and BleFraming.FLAG_LAST) == 0) return

        if (assembled != expectedLength) {
            val short = expectedLength - assembled
            reset()
            onDrop("truncated: $short bytes short of the declared length")
            return
        }

        val message = ByteArray(assembled)
        var at = 0
        for (part in parts) {
            part.copyInto(message, at)
            at += part.size
        }
        reset()
        onMessage(message)
    }

    private fun reset() {
        parts = mutableListOf()
        assembled = 0
        expectedLength = 0
        inFlight = false
    }

    /**
     * A u32be read widened through Long so a length with the high bit set
     * (0xffffffff in the reject vector) is compared as the huge number it is,
     * not as a negative Int that would slip past the cap.
     */
    private fun readUInt32BE(source: ByteArray, at: Int): Long =
        ((source[at].toLong() and 0xff) shl 24) or
            ((source[at + 1].toLong() and 0xff) shl 16) or
            ((source[at + 2].toLong() and 0xff) shl 8) or
            (source[at + 3].toLong() and 0xff)
}
