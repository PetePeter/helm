export function buildStartupGuide(): string {
  return [
    'Call notify_user when work completes, blocked for input, or error stops progress — Helm routes automatically.',
    'Before implementing a plan: plan_get + plan_context_list just-in-time, context_get only for the current phase, and claim it with session_plan_claim before editing.',
    'Blocking questions: create QUESTION: plan, link to blocked plan via plan_nextplan_link, leave original intact.',
    'Use context_* for durable memory; link context to relevant plan or sequence.',
    'Noticed something odd, unexplained, or improvable? Save one kind=idea memory at stage seed with the observation, why it matters, and evidence. Do not act on it.',
    'Inter-LLM handoffs: session_send_text then verify receipt via session_read_terminal.',
    'Just-in-time guidance: skill_get(type:"session-send-text"/"agent-plan"/"notification"/"mess") only when needed.',
    'Call skill_list at task start; apply only matching skills; after applying one, submit feedback with skill_submit_feedback(stars, value_summary).',
  ].join('\n');
}
