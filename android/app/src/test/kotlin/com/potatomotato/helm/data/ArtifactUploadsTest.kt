package com.potatomotato.helm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The staged-create state machine, and the greying verdict that gates it.
 *
 * Both are pure — no Android, no link — which is the point: these are the
 * decisions the editor draws and the client acts on, and they must hold with
 * no radio attached.
 */
class ArtifactUploadsTest {

    private fun staged(
        key: String,
        sizeBytes: Long = 100,
    ) = StagedAttachment(
        key = key,
        source = "content://test/$key",
        localPath = "/cache/$key",
        filename = "$key.jpg",
        mimeType = "image/jpeg",
        sizeBytes = sizeBytes,
        sha256 = "ab".repeat(32),
    )

    @Test
    fun `staging adds a chip in order and refuses a duplicate key`() {
        val uploads = ArtifactUploads()
        assertTrue(uploads.stage(staged("a")))
        assertTrue(uploads.stage(staged("b")))
        assertFalse("the same key staged twice is one file, not two chips", uploads.stage(staged("a")))

        assertEquals(listOf("a", "b"), uploads.staged.value.map { it.key })
        assertEquals(
            listOf(AttachmentUploadState.Waiting, AttachmentUploadState.Waiting),
            uploads.states.value.values.toList(),
        )
    }

    @Test
    fun `unstaging removes the chip and its state with it`() {
        val uploads = ArtifactUploads()
        uploads.stage(staged("a"))
        uploads.stage(staged("b"))
        uploads.uploadStarted("a", 100)

        uploads.unstage("a")
        assertEquals(listOf("b"), uploads.staged.value.map { it.key })
        assertNull(uploads.states.value["a"])
        assertNull(uploads.stagedAttachment("a"))
    }

    @Test
    fun `progress advances only an uploading chip`() {
        val uploads = ArtifactUploads()
        uploads.stage(staged("a"))
        uploads.uploadStarted("a", 100)
        uploads.uploadProgress("a", 40)

        val state = uploads.states.value["a"]
        assertTrue(state is AttachmentUploadState.Uploading)
        assertEquals(40L, (state as AttachmentUploadState.Uploading).sent)
        assertEquals(100L, state.totalBytes)

        // Progress without a start (a stray slice answer) must not invent a
        // state: a Waiting chip with a byte count would be a lie drawn twice.
        uploads.uploadProgress("missing", 10)
        assertNull(uploads.states.value["missing"])
    }

    @Test
    fun `a failed chip stays pending and retries before a done one is skipped`() {
        val uploads = ArtifactUploads()
        uploads.stage(staged("a"))
        uploads.stage(staged("b"))
        uploads.stage(staged("c"))
        uploads.beginUploads("artifact-1", "session-1")
        uploads.uploadStarted("a", 100)
        uploads.uploadDone("a", "att-1")
        uploads.uploadStarted("b", 100)
        uploads.uploadFailed("b", "the link dropped")

        // Done is not pending; Failed is. Order is staged order, so the retry
        // resumes the file that failed, not the first one staged.
        assertEquals(listOf("b", "c"), uploads.pendingKeys())
        assertFalse(uploads.allDone())

        assertEquals("artifact-1", uploads.targetArtifactId)
        assertEquals("session-1", uploads.targetSessionId)
    }

    @Test
    fun `allDone is vacuously true with nothing staged`() {
        val uploads = ArtifactUploads()
        assertTrue(uploads.allDone())
        assertTrue(uploads.pendingKeys().isEmpty())
    }

    @Test
    fun `beginUploads replaces the target of a second create`() {
        val uploads = ArtifactUploads()
        uploads.beginUploads("artifact-1", "session-1")
        uploads.beginUploads("artifact-2", "session-2")
        assertEquals("artifact-2", uploads.targetArtifactId)
        assertEquals("session-2", uploads.targetSessionId)
    }

    @Test
    fun `clear empties the whole stage`() {
        val uploads = ArtifactUploads()
        uploads.stage(staged("a"))
        uploads.beginUploads("artifact-1", "session-1")

        uploads.clear()
        assertTrue(uploads.staged.value.isEmpty())
        assertTrue(uploads.states.value.isEmpty())
        assertNull(uploads.targetArtifactId)
        assertNull(uploads.targetSessionId)
    }

    // ------------------------------------------------------------ the greying

    @Test
    fun `the toolbar is available only when both gates open`() {
        assertEquals(UploadSupport.Available, uploadSupport(toolPermitted = true, negotiatedProtocol = 4, linked = true))
    }

    @Test
    fun `a protocol-3 desktop means the toolbar says why it is dark`() {
        // THE degradation the whole version bump exists for: an old desktop
        // links fine and simply has no upload half.
        assertEquals(
            UploadSupport.DesktopTooOld,
            uploadSupport(toolPermitted = true, negotiatedProtocol = UPLOAD_MIN_PROTOCOL - 1, linked = true),
        )
        // No link means no negotiated version at all — offline outranks it.
        assertEquals(
            UploadSupport.Offline,
            uploadSupport(toolPermitted = true, negotiatedProtocol = 0, linked = false),
        )
    }

    @Test
    fun `an unanswered or refused tool gate is not an offer`() {
        // Unknown is not a yes: the toolbar must not claim a permission verdict
        // the phone does not have.
        assertEquals(UploadSupport.NotPermitted, uploadSupport(toolPermitted = null, negotiatedProtocol = 4, linked = true))
        assertEquals(UploadSupport.NotPermitted, uploadSupport(toolPermitted = false, negotiatedProtocol = 4, linked = true))
    }

    // --------------------------------------------------------------- the guard

    @Test
    fun `the staging guard accepts a real file and refuses the extremes`() {
        assertTrue(stageVerdict(1L) is StageVerdict.Ok)
        assertTrue(stageVerdict(MAX_STAGED_BYTES.toLong()) is StageVerdict.Ok)
        assertTrue(stageVerdict(MAX_STAGED_BYTES + 1L) is StageVerdict.TooLarge)
        // An empty pick is not a file; the desktop would refuse it as a cap of
        // zero anyway, so the refusal happens before a chip exists.
        assertTrue(stageVerdict(0) is StageVerdict.TooLarge)
    }
}
