import { REQUIRED_PLAN_DESCRIPTION_SECTIONS } from './definitions.js';

export function getToolReminder(name: string): string {
  if (name === 'session_send_text') {
    return 'Reminder: for inter-LLM handoffs, submit must stay true/default. Now call session_read_terminal on the recipient and verify the tail shows the first words of the sent text, a new prompt, or a response starting; warn the user if no receipt evidence is visible.';
  }
  if (name === 'session_send_input') {
    return 'Reminder: session_send_input sends raw terminal keystrokes — no HELM_MSG envelope. Now call session_read_terminal on the recipient and verify the input was received.';
  }
  if (name === 'session_read_terminal') {
    return 'Reminder: after a handoff, inspect this terminal tail for receipt evidence. If the sent text or new recipient activity is not visible, report that uncertainty to the user.';
  }
  if (name === 'session_info') {
    return 'Reminder: now call session_set_aiagent_state for your current phase. If a Helm plan is assigned and you are implementing it, claim it by calling session_plan_claim with your sessionId and the planId.';
  }
  if (name === 'plan_create') {
    return `Reminder: creating a plan does not assign ownership. Plan descriptions should include: ${REQUIRED_PLAN_DESCRIPTION_SECTIONS.join(', ')}. For blocking questions, create a separate "QUESTION: ..." plan and link it to the original blocked plan with plan_nextplan_link. When you begin implementation, call session_plan_claim with your sessionId and planId to claim it.`;
  }
  if (name === 'plan_set_state') {
    return 'Reminder: to claim work and show the badge on the session row, call session_plan_claim after setting state.';
  }
  if (name === 'plan_complete') {
    return 'Reminder: fetch skill_get(type: "memorising") and record what you learned as durable memory. Tell the user exactly what to test, then inspect followUpPlans and continue with any ready autoFollowUpPlans.';
  }
  if (name === 'session_plan_claim') {
    return 'Reminder: before starting, fetch skill_get(type: "recalling") and search memory for what this project already knows about the work.';
  }
  if (name === 'notify_user') {
    return 'Reminder: after notifying, update your phase - call session_set_aiagent_state with "completed" if work is done, or "idle" if standing down.';
  }
  if (name === 'sequence_list' || name === 'sequence_update') {
    return 'Reminder: sequence.sharedMemory is shared by every plan in that sequence. Re-read the sequence and pass expectedUpdatedAt when updating or appending to avoid overwriting another LLM.';
  }
  return '';
}
