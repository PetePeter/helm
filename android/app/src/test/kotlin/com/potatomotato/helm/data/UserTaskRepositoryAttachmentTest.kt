package com.potatomotato.helm.data

import com.potatomotato.helm.ui.tasks.attachmentFileName
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** Attachment bytes as user_task_get {attachmentId} sends them: utf8 text or base64. */
class UserTaskRepositoryAttachmentTest {
    private fun reply(encoding: String, content: String) = JSONObject("""
        {"attachment":{"id":"a1","kind":"file","title":"r.pdf","contentType":"application/pdf","sizeBytes":3},
         "encoding":"$encoding","content":"$content"}
    """.trimIndent())

    @Test
    fun `base64 binary decodes to bytes with the requested action`() {
        val repo = UserTaskRepository()
        repo.attachmentArrived(reply("base64", "AQID"), UserTaskAttachmentAction.Save)
        val got = repo.attachment.value!!
        assertArrayEquals(byteArrayOf(1, 2, 3), got.bytes)
        assertEquals(UserTaskAttachmentAction.Save, got.action)
        repo.attachmentHandled()
        assertNull(repo.attachment.value)
    }

    @Test
    fun `utf8 text becomes its bytes`() {
        val repo = UserTaskRepository()
        repo.attachmentArrived(reply("utf8", "hi"), UserTaskAttachmentAction.Open)
        assertArrayEquals("hi".toByteArray(), repo.attachment.value!!.bytes)
    }

    @Test
    fun `undecodable base64 is refused`() {
        assertFalse(UserTaskRepository().attachmentArrived(reply("base64", "!!"), UserTaskAttachmentAction.Open))
    }

    @Test
    fun `filename cannot carry a path`() {
        assertEquals(".._.._x.pdf", attachmentFileName("../../x.pdf"))
        assertEquals("attachment", attachmentFileName(""))
    }
}
