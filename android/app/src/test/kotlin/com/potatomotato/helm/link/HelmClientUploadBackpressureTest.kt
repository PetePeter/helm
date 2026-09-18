package com.potatomotato.helm.link

import com.potatomotato.helm.crypto.Cancellable
import com.potatomotato.helm.crypto.ChannelScheduler
import com.potatomotato.helm.data.AttachmentUploadState
import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.wire.MobileEnvelope
import com.potatomotato.helm.wire.MobileRecord
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream

/**
 * What an upload's percentage MEANS.
 *
 * The link this app really runs on takes bytes and returns immediately — a
 * Bluetooth send queues chunks that leave one notification at a time, minutes
 * later. A loop that measured itself by what it had handed over therefore read
 * 100% within milliseconds and then sat there for the whole transfer, which is
 * the bug these tests exist to keep fixed.
 *
 * The link here is a fake with a BACKLOG the test drains by hand: nothing moves
 * unless the test says it moved. That is the only way to assert the thing that
 * matters — that the number on screen is a fact about the radio and not about
 * this loop's own enthusiasm.
 */
class HelmClientUploadBackpressureTest {

    private val sent = mutableListOf<ByteArray>()
    private val scheduler = TestScheduler()

    /** Wire bytes the fake link is holding. Only the drain helpers reduce it. */
    private var backlog = 0L

    /** The backlog as it stood before the last frame, and that frame's size. */
    private var frameFloor = 0L
    private var frameSize = 0L
    private var linked = true

    private val file = ByteArray(8) { it.toByte() }

    private val client = HelmClient(
        send = { bytes ->
            if (!linked) {
                false
            } else {
                sent.add(bytes)
                // A queueing transport: taken, but not yet gone.
                frameFloor = backlog
                frameSize = bytes.size.toLong()
                backlog += frameSize
                true
            }
        },
        scheduler = scheduler,
        linkPending = { backlog },
        uploadScope = CoroutineScope(Dispatchers.Unconfined),
    ).apply {
        openStagedAttachment = { ByteArrayInputStream(file) }
    }

    @Test
    fun `slices wait for the link and the percentage tracks what has really gone`() {
        openSlot(maxSliceBytes = 4)

        // ONE slice went out, not the whole file: the second is not queued until
        // the first has actually left. Nothing is reported as sent yet.
        assertEquals(1, blobs().size)
        assertEquals(0L, sentBytes())

        // Half the first slice's wire bytes clear the radio.
        drainHalf()
        scheduler.runNext()
        assertEquals("still only one slice in flight", 1, blobs().size)
        assertTrue("some of the slice has gone", sentBytes() in 1 until 4)

        // The rest of it clears: the first slice is complete and the second goes.
        drainAll()
        scheduler.runNext()
        assertEquals(4L, sentBytes())
        assertEquals(2, blobs().size)

        drainAll()
        scheduler.runNext()
        assertEquals(8L, sentBytes())
        // Only now — after every byte is really gone — is the commit issued.
        assertEquals("session_artifact_attachment_commit", methodOf(sent.last()))
    }

    @Test
    fun `a link that drops mid-file fails the chip instead of waiting forever`() {
        openSlot(maxSliceBytes = 4)

        // A dropped link discards its queue, so the backlog vanishes without the
        // bytes ever arriving. The loop must notice by trying, not by waiting.
        linked = false
        backlog = 0
        scheduler.runNext()

        val state = client.uploads.states.value.getValue("a")
        assertTrue("a dead link must fail the chip, not hang it", state is AttachmentUploadState.Failed)
    }

    // ------------------------------------------------------------- the harness

    /** Stage one file, create the artifact, and answer through to the offer. */
    private fun openSlot(maxSliceBytes: Int) {
        assertTrue(
            client.uploads.stage(
                StagedAttachment(
                    key = "a",
                    source = "content://test/a",
                    localPath = "/cache/a",
                    filename = "a.bin",
                    mimeType = "application/octet-stream",
                    sizeBytes = file.size.toLong(),
                    sha256 = "ab".repeat(32),
                ),
            ),
        )
        client.createArtifact("s1", "t", "b", client.uploads.pendingKeys())
        client.onInbound(resultFor(callIdOf(sent[0]), """{"id":"artifact-9"}"""))
        client.onInbound(
            resultFor(
                callIdOf(sent[1]),
                """{"uploadId":"slot-a","maxSliceBytes":$maxSliceBytes,"total":${file.size}}""",
            ),
        )
    }

    /** Half of the last frame reaches the air; the rest is still queued. */
    private fun drainHalf() {
        backlog = frameFloor + frameSize / 2
    }

    /** The last frame is entirely on the air. */
    private fun drainAll() {
        backlog = frameFloor
    }

    private fun blobs(): List<MobileRecord.Blob> =
        sent.mapNotNull { MobileEnvelope.decode(it) as? MobileRecord.Blob }

    private fun sentBytes(): Long =
        (client.uploads.states.value.getValue("a") as AttachmentUploadState.Uploading).sent

    private fun methodOf(frame: ByteArray): String =
        JSONObject(String(frame, Charsets.UTF_8)).getString("method")

    private fun callIdOf(frame: ByteArray): String =
        JSONObject(String(frame, Charsets.UTF_8)).getString("id")

    private fun resultFor(id: String, resultJson: String): ByteArray =
        """{"v":1,"t":"result","id":"$id","result":$resultJson}""".toByteArray(Charsets.UTF_8)

    /** The pacing clock, driven a tick at a time so nothing depends on wall time. */
    private class TestScheduler : ChannelScheduler {
        private class Armed(val action: () -> Unit) {
            var active = true
        }

        private val tasks = ArrayDeque<Armed>()

        override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
            val armed = Armed(action)
            tasks.add(armed)
            return Cancellable { armed.active = false }
        }

        /**
         * Fire the next action still armed. Cancelled ones are skipped rather
         * than counted: every answered call cancels its own timeout, so the
         * queue is mostly dead entries by the time a wait needs resuming.
         */
        fun runNext() {
            while (true) {
                val next = tasks.removeFirstOrNull() ?: return
                if (next.active) {
                    next.action()
                    return
                }
            }
        }
    }
}
