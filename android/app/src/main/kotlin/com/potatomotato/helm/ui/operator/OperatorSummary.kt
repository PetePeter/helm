package com.potatomotato.helm.ui.operator

import com.potatomotato.helm.data.ChatMessage
import com.potatomotato.helm.data.HelmSession
import com.potatomotato.helm.ui.components.SessionState
import com.potatomotato.helm.voice.OPERATOR_ROLE

/** What the front page's Helm section draws: the operator, or the fact there is none. */
sealed interface OperatorSummary {
    data object Off : OperatorSummary

    data class On(
        val id: String,
        val activity: SessionState,
        /** The operator's newest reply in its thread; null until it has said anything. */
        val lastReply: String?,
    ) : OperatorSummary
}

/** The operator's section reads the same session list and chat journal as everything else. */
fun operatorSummary(sessions: List<HelmSession>, threads: Map<String, List<ChatMessage>>): OperatorSummary {
    val operator = sessions.firstOrNull { it.role == OPERATOR_ROLE } ?: return OperatorSummary.Off
    val lastReply = threads[operator.id].orEmpty().filter { !it.fromPhone }.maxByOrNull { it.at }?.text
    return OperatorSummary.On(operator.id, operator.activity, lastReply)
}

/** The operator lives in its own section, so the session list never shows it twice. */
fun withoutOperator(sessions: List<HelmSession>): List<HelmSession> = sessions.filter { it.role != OPERATOR_ROLE }
