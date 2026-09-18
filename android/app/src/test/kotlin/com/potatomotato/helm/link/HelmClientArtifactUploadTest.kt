package com.potatomotato.helm.link

import com.potatomotato.helm.data.AttachmentUploadState
import com.potatomotato.helm.data.SessionAction
import com.potatomotato.helm.data.StagedAttachment
import com.potatomotato.helm.crypto.Cancellable
import com.potatomotato.helm.crypto.ChannelScheduler
import com.potatomotato.helm.wire.MobileEnvelope
import com.potatomotato.helm.wire.MobileRecord
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream

/**
 * The staged-create upload chain, end to end over a miniature link.
 *
 * The link is a lambda that either carries bytes or does not, exactly as in
 * [HelmClientTest]; the desktop is a hand-driven answerer. What the test buys
 * is the ORDER the phone actually speaks — one file at a time, slices raw,
 * commit before the next file, and the landing notice only after the last
 * commit — because every one of those orderings is a promise the UI relies on
 * and none of them is visible in any single class below [HelmClient].
 */
class HelmClientArtifactUploadTest {

    private val sent = mutableListOf<ByteArray>()
    private var linked = true
    private var clock = 1_700_000_000_000L
    private val scheduler = TestScheduler()
    private val files = mutableMapOf<String, ByteArray>()

    /**
     * The fake link's backlog: bytes it has taken but not yet put on the wire.
     * Zero is a transport that flushes as it sends — LAN — and is what the
     * ordering tests below want, because then the chain runs straight through.
     */
    private var pending = 0L
    private val client = HelmClient(
        send = { bytes -> if (linked) sent.add(bytes) else false },
        now = { clock },
        scheduler = scheduler,
        linkPending = { pending },
        // Unconfined, so a launched upload runs inline and the ORDER of the
        // chain stays assertable; the waiting is the scheduler's, not a clock's.
        uploadScope = CoroutineScope(Dispatchers.Unconfined),
    ).apply {
        openStagedAttachment = { staged -> files[staged.key]?.let { ByteArrayInputStream(it) } }
    }

    @Test
    fun `a create with staged files sends add, slices, commit per file, then lands`() {
        files["a"] = byteArrayOf(1, 2, 3, 4)
        files["b"] = byteArrayOf(5, 6)
        stage("a")
        stage("b")

        client.createArtifact("s1", "title", "body", client.uploads.pendingKeys())

        // The create went out first, and NOTHING navigated yet: the landing is
        // the deferred one.
        assertEquals("session_artifact_create", methodOf(sent.first()))
        assertNull(client.control.artifactLanding.value)

        // File a: slot open…
        client.onInbound(resultFor(callIdOf(sent[0]), """{"id":"artifact-9"}"""))
        assertEquals("session_artifact_attachment_add", methodOf(sent[1]))
        val addParams = paramsOf(sent[1])
        assertEquals("artifact-9", addParams.getString("artifactId"))
        assertEquals("a.jpg", addParams.getString("filename"))
        assertEquals(4L, addParams.getLong("sizeBytes"))
        client.onInbound(
            resultFor(callIdOf(sent[1]), """{"uploadId":"slot-a","maxSliceBytes":64,"total":4}"""),
        )

        // …raw slices, addressed to the slot, then the commit…
        val blob = MobileEnvelope.decode(sent[2])
        assertTrue(blob is MobileRecord.Blob)
        blob as MobileRecord.Blob
        assertEquals("slot-a", blob.id)
        assertEquals("01020304", blob.bytes.toHex())
        assertTrue(blob.eof)
        assertEquals("session_artifact_attachment_commit", methodOf(sent[3]))
        assertTrue(client.uploads.states.value["a"] is AttachmentUploadState.Uploading)

        // …file b, only after a's commit ANSWERED.
        client.onInbound(
            resultFor(
                callIdOf(sent[3]),
                """{"artifactId":"artifact-9","attachment":{"id":"att-a","filename":"a.jpg"}}""",
            ),
        )
        assertEquals(
            AttachmentUploadState.Done("att-a"),
            client.uploads.states.value["a"],
        )
        assertEquals("session_artifact_attachment_add", methodOf(sent.last()))
        assertEquals("b.jpg", paramsOf(sent.last()).getString("filename"))

        finishFile("b", "slot-b", "att-b")

        // Everything landed: NOW the create navigates, exactly like a bare one.
        val landing = client.control.artifactLanding.value
        assertNotNull("the deferred landing must arrive", landing)
        assertEquals(SessionAction.CreateArtifact, landing?.action)
        assertEquals("artifact-9", landing?.artifactId)
        assertTrue(client.uploads.allDone())
    }

    @Test
    fun `a failed commit fails its chip and a retry reopens a fresh slot`() {
        files["a"] = byteArrayOf(1, 2, 3)
        stage("a")
        client.createArtifact("s1", "t", "b", client.uploads.pendingKeys())
        client.onInbound(resultFor(callIdOf(sent[0]), """{"id":"artifact-9"}"""))
        client.onInbound(resultFor(callIdOf(sent[1]), """{"uploadId":"slot-a","maxSliceBytes":64,"total":3}"""))

        // The commit is refused — the desktop's hash did not match.
        client.onInbound(errorFor(callIdOf(sent[3]), "upload checksum mismatch"))

        assertEquals(
            "upload checksum mismatch",
            (client.uploads.states.value["a"] as AttachmentUploadState.Failed).message,
        )
        assertFalse(client.uploads.allDone())
        assertNull("a failed chain must not navigate", client.control.artifactLanding.value)

        // The retry opens a NEW slot and re-sends the WHOLE file — a retry that
        // appended into a slot of unknown depth would land plausible and wrong.
        assertTrue(client.retryArtifactUploads())
        assertEquals("session_artifact_attachment_add", methodOf(sent[4]))
        client.onInbound(resultFor(callIdOf(sent[4]), """{"uploadId":"slot-a2","maxSliceBytes":64,"total":3}"""))
        val blob = MobileEnvelope.decode(sent[5])
        assertTrue(blob is MobileRecord.Blob)
        assertEquals("slot-a2", (blob as MobileRecord.Blob).id)

        client.onInbound(
            resultFor(
                callIdOf(sent[6]),
                """{"artifactId":"artifact-9","attachment":{"id":"att-a"}}""",
            ),
        )
        assertEquals(SessionAction.CreateArtifact, client.control.artifactLanding.value?.action)
    }

    @Test
    fun `a staged copy that vanished fails its chip instead of stalling the chain`() {
        files["a"] = byteArrayOf(1, 2, 3)
        stage("a")
        client.createArtifact("s1", "t", "b", client.uploads.pendingKeys())
        client.onInbound(resultFor(callIdOf(sent[0]), """{"id":"artifact-9"}"""))
        assertEquals("session_artifact_attachment_add", methodOf(sent[1]))

        // The cache copy was swept between staging and the upload; the stream
        // port answers null.
        files.clear()
        client.onInbound(resultFor(callIdOf(sent[1]), """{"uploadId":"slot-a","maxSliceBytes":64,"total":3}"""))

        assertTrue(
            (client.uploads.states.value["a"] as AttachmentUploadState.Failed).message.contains("staged"),
        )
        assertNull("a failed chain must not navigate", client.control.artifactLanding.value)
    }

    // ------------------------------------------------------------- the harness

    private fun stage(key: String) {
        assertTrue(
            client.uploads.stage(
                StagedAttachment(
                    key = key,
                    source = "content://test/$key",
                    localPath = "/cache/$key",
                    filename = "$key.jpg",
                    mimeType = "image/jpeg",
                    sizeBytes = files.getValue(key).size.toLong(),
                    sha256 = "ab".repeat(32),
                ),
            ),
        )
    }

    /** Answer the last file's commit and let the chain finish. */
    private fun finishFile(key: String, slot: String, attachmentId: String) {
        val total = files.getValue(key).size.toLong()
        client.onInbound(resultFor(callIdOf(sent.last()), """{"uploadId":"$slot","maxSliceBytes":64,"total":$total}"""))
        client.onInbound(
            resultFor(
                callIdOf(sent.last()),
                """{"artifactId":"artifact-9","attachment":{"id":"$attachmentId"}}""",
            ),
        )
    }

    private fun methodOf(frame: ByteArray): String = JSONObject(String(frame, Charsets.UTF_8)).getString("method")

    private fun paramsOf(frame: ByteArray): JSONObject = JSONObject(String(frame, Charsets.UTF_8)).getJSONObject("params")

    private fun callIdOf(frame: ByteArray): String = JSONObject(String(frame, Charsets.UTF_8)).getString("id")

    private fun resultFor(id: String, resultJson: String): ByteArray =
        """{"v":1,"t":"result","id":"$id","result":$resultJson}""".toByteArray(Charsets.UTF_8)

    private fun errorFor(id: String, message: String): ByteArray =
        """{"v":1,"t":"error","id":"$id","error":{"code":-32000,"message":"$message"}}""".toByteArray(Charsets.UTF_8)

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    /** Timeout control stays deterministic: tests advance it, never wall time. */
    private class TestScheduler : ChannelScheduler {
        private val tasks = ArrayDeque<() -> Unit>()
        var cancelled = 0
            private set

        override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
            var active = true
            tasks.add { if (active) action() }
            return Cancellable {
                if (active) {
                    active = false
                    cancelled++
                }
            }
        }

        fun runNext() {
            tasks.removeFirstOrNull()?.invoke()
        }
    }
}
