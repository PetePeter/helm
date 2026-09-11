package com.potatomotato.helm.crypto

/** Upper bound on a single wire frame, so a hostile length cannot exhaust memory. */
const val MAX_FRAME_BYTES = 128 * 1024

/** Frame = uint32be length | type byte | payload. Values match secure-channel.ts. */
enum class FrameType(val wire: Byte) {
    HELLO(0x01),
    RESPONSE(0x02),
    REVEAL(0x03),
    CONFIRM(0x04),
    DATA(0x05),
    REFUSE(0x06),
    ;

    companion object {
        fun fromWire(value: Byte): FrameType? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The handshake wire codec.
 *
 * The transport below already delivers whole messages, but the framing is still
 * parsed as a byte STREAM — exactly as the desktop does. Assuming one message
 * equals one frame would make the phone disagree with a peer that ever coalesced
 * or split a write, and that disagreement would surface as a dead link, not an
 * error.
 */
class FrameReader(
    private val onFrame: (type: FrameType, body: ByteArray) -> Unit,
) {
    private var buffer = ByteArray(0)

    /** Throws on anything malformed; the channel above turns that into a close. */
    fun push(chunk: ByteArray) {
        buffer += chunk
        while (buffer.size >= 4) {
            // THE TRAP: read the length through a Long. As an Int, 0xffffffff is
            // negative and walks straight past the cap check below.
            val length = readUint32(buffer, 0)
            if (length == 0L || length > MAX_FRAME_BYTES) {
                throw IllegalStateException("frame length out of range")
            }
            if (buffer.size < 4 + length) return

            val end = (4 + length).toInt()
            val type = FrameType.fromWire(buffer[4])
                ?: throw IllegalStateException("Unknown frame type ${buffer[4]}")
            val body = buffer.copyOfRange(5, end)
            buffer = buffer.copyOfRange(end, buffer.size)
            onFrame(type, body)
        }
    }
}

/** Build one complete frame ready for the transport. */
fun encodeFrame(type: FrameType, body: ByteArray): ByteArray {
    val payloadLength = 1 + body.size
    check(payloadLength <= MAX_FRAME_BYTES) { "Frame exceeds the maximum size" }
    return uint32(payloadLength) + byteArrayOf(type.wire) + body
}

/** 4-byte big-endian length prefix per field — injective, matching the transcript. */
fun encodeFields(fields: List<ByteArray>): ByteArray = lengthPrefixed(fields)

/** Decode exactly [expected] length-prefixed fields; anything else is hostile. */
fun decodeFields(body: ByteArray, expected: Int): List<ByteArray> {
    val fields = ArrayList<ByteArray>(expected)
    var offset = 0
    while (offset + 4 <= body.size) {
        val length = readUint32(body, offset)
        offset += 4
        if (length > body.size - offset) throw IllegalStateException("Malformed handshake frame")
        val end = offset + length.toInt()
        fields.add(body.copyOfRange(offset, end))
        offset = end
    }
    if (offset != body.size || fields.size != expected) {
        throw IllegalStateException("Malformed handshake frame")
    }
    return fields
}

/** Read a wire uint32, or null when the field is not exactly 4 bytes. */
fun fieldAsUint32(field: ByteArray): Long? = if (field.size == 4) readUint32(field, 0) else null

private fun readUint32(source: ByteArray, offset: Int): Long {
    var value = 0L
    for (i in 0 until 4) value = (value shl 8) or (source[offset + i].toLong() and 0xff)
    return value
}
