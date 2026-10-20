export function buildStartupGuide(): string {
  return [
    'Set session_set_aiagent_state on phase changes: planning (investigating), implementing (editing/testing), completed (done).',
    'Call notify_user when work completes, blocked for input, or error stops progress — Helm routes automatically.',
    'Before implementing a plan: plan_get + plan_context_list just-in-time; context_get only entries relevant to current phase.',
    'Claim assigned work before editing: session_plan_claim(sessionId, planId) transitions plan to coding.',
    'Blocking questions: create QUESTION: plan, link to blocked plan via plan_nextplan_link, leave original intact.',
    'Use context_* for durable memory; link context to relevant plan or sequence.',
    'Inter-LLM handoffs: session_send_text then verify receipt via session_read_terminal.',
    'Just-in-time guidance: skill_get(type:"session-send-text"/"agent-plan"/"notification"/"mess") only when needed.',
    'Call skill_list at task start; apply only skills whose description directly matches the task.',
    'After applying a skill: skill_submit_feedback(stars, value_summary).',
  ].join('\n');
}
