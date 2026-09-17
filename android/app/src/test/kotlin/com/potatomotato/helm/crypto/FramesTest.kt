package com.potatomotato.helm.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The frame ceiling is half of a cross-language contract: the desktop's
 * `MAX_FRAME_BYTES` and this one must be the SAME number, or a slice one side
 * considers legal is a torn link on the other. These tests pin the boundary
 * exactly — the value, one byte under it, and one byte over.
 */
class FramesTest {

    @Test
    fun `the ceiling is 1 MiB, the number the desktop also ships`() {
        assertEquals(1024 * 1024, MAX_FRAME_BYTES)
    }

    @Test
    fun `a frame at the ceiling is carried whole`() {
        // The largest legal frame: the type byte is part of the payload length.
        val body = ByteArray(MAX_FRAME_BYTES - 1) { (it and 0xff).toByte() }
        val received = mutableListOf<Pair<FrameType, ByteArray>>()
        FrameReader { type, payload -> received += type to payload }
            .push(encodeFrame(FrameType.DATA, body))

        assertEquals(1, received.size)
        assertEquals(FrameType.DATA, received[0].first)
        assertArrayEquals(body, received[0].second)
    }

    @Test
    fun `a frame one byte past the ceiling is refused at both ends`() {
        assertThrows(IllegalStateException::class.java) {
            encodeFrame(FrameType.DATA, ByteArray(MAX_FRAME_BYTES))
        }
        // And on the way in: a hostile length prefix must never be allocated for.
        val hostile = byteArrayOf(0x00, 0x10, 0x00, 0x01, FrameType.DATA.wire)
        assertThrows(IllegalStateException::class.java) { FrameReader { _, _ -> }.push(hostile) }
    }

    @Test
    fun `a frame split across writes is reassembled, not misread`() {
        // The transport delivers whole messages, but the framing is a STREAM —
        // assuming one write is one frame is how a link dies silently.
        val body = ByteArray(200_000) { (it and 0x7f).toByte() }
        val frame = encodeFrame(FrameType.DATA, body)
        val received = mutableListOf<ByteArray>()
        val reader = FrameReader { _, payload -> received += payload }

        reader.push(frame.copyOfRange(0, 3))
        reader.push(frame.copyOfRange(3, 100_000))
        assertEquals(0, received.size)
        reader.push(frame.copyOfRange(100_000, frame.size))

        assertEquals(1, received.size)
        assertArrayEquals(body, received[0])
    }
}
