package com.potatomotato.helm.ui.operator

import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.components.SessionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OperatorSummaryTest {
    private fun session(id: String, role: String? = null, activity: SessionState = SessionState.Idle) = HelmSession(
        id = id,
        name = id,
        projectPath = "x:/p",
        cliType = "claudecode",
        cliTypeName = "Claude Code",
        activity = activity,
        role = role,
    )

    private fun msg(key: String, text: String, at: Long, fromPhone: Boolean = false) =
        ChatMessage(key = key, text = text, at = at, fromPhone = fromPhone)

    @Test
    fun `the operator's latest reply is the snippet, not the phone's own send`() {
        val sessions = listOf(session("a"), session("helm", role = "operator", activity = SessionState.Active))
        val threads = mapOf(
            "helm" to listOf(msg("1", "older", 1), msg("2", "newest", 2), msg("3", "my question", 3, fromPhone = true)),
            "a" to listOf(msg("9", "not the operator", 9)),
        )
        assertEquals(
            OperatorSummary.On(id = "helm", activity = SessionState.Active, lastReply = "newest"),
            operatorSummary(sessions, threads),
        )
    }

    @Test
    fun `an operator with no replies yet has no snippet`() {
        val summary = operatorSummary(listOf(session("helm", role = "operator")), emptyMap())
        assertNull((summary as OperatorSummary.On).lastReply)
    }

    @Test
    fun `no operator session means the section is off`() {
        assertEquals(OperatorSummary.Off, operatorSummary(listOf(session("a")), emptyMap()))
    }

    @Test
    fun `the operator is excluded from the regular session list`() {
        val sessions = listOf(session("a"), session("helm", role = "operator"), session("b"))
        assertEquals(listOf("a", "b"), withoutOperator(sessions).map { it.id })
    }
}
