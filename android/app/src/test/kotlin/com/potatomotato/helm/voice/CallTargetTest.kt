package com.potatomotato.helm.voice

import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.components.SessionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallTargetTest {
    private fun session(id: String, role: String? = null) = HelmSession(
        id = id,
        name = id,
        projectPath = "x:/p",
        cliType = "claudecode",
        cliTypeName = "Claude Code",
        activity = SessionState.Idle,
        role = role,
    )

    @Test
    fun `the operator wins over a picked session`() {
        val sessions = listOf(session("a"), session("helm", role = "operator"))
        assertEquals("helm", resolveCallTarget(sessions, pickedId = "a"))
    }

    @Test
    fun `without an operator the picked session is called`() {
        val sessions = listOf(session("a"), session("b"))
        assertEquals("b", resolveCallTarget(sessions, pickedId = "b"))
    }

    @Test
    fun `no operator and nothing picked means nobody to call`() {
        assertNull(resolveCallTarget(listOf(session("a")), pickedId = null))
    }

    @Test
    fun `a picked session that has since closed is not called`() {
        assertNull(resolveCallTarget(listOf(session("a")), pickedId = "gone"))
    }
}
