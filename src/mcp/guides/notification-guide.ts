/**
 * Static data for the notification routing guide.
 * Extracted from session-info-guide.ts to keep that file under 100 lines.
 */

export function buildNotificationGuide(): string {
  return `\
[notification]
description = "MANDATORY: call notify_user on key events. Helm routes to desktop toast / taskbar flash / bubble based on screen state and independently sends an alert to the paired phone."
preferred_tool = "notify_user"

[when_to_notify]
rule_1 = "ALWAYS notify when work completes (session → completed): title \\"Work complete\\", 1-2 sentence TLDR of what changed."
rule_2 = "ALWAYS notify when blocked on a user decision before calling AskUserQuestion: title \\"Need your input\\", brief blocker summary."
rule_3 = "ALWAYS notify when an error stops progress: title \\"⚠️ Error during implementation\\", brief error + action needed."
rule_4 = "ALWAYS notify when a background event the user asked about has fired (build green, deploy done, watcher fired)."

[when_not_to_notify]
rule_1 = "Routine progress, intermediate logs, or low-priority updates."

[routing_outcomes]
toast = "Window hidden — Helm shows native OS toast."
taskbar_flash = "Window visible but not focused — OS toast + taskbar icon flashes."
bubble = "Window visible, focused, different session — in-app bubble."
phone = "If a paired phone is connected, the alert is pushed independently of desktop routing."
none = "No desktop channel was used; the paired phone alert is still attempted."

[examples]
long_task_finished = { tool = "notify_user", title = "Work complete", content = "Migrated auth middleware to JWT. 3 files changed, 12 tests pass." }
need_decision = { tool = "notify_user", title = "Need your input to continue", content = "Profile has two conflicting port configs - which one should win?" }
error_stops_progress = { tool = "notify_user", title = "Error during implementation", content = "TypeScript build failed - missing type export in session-manager.ts." }

[llm_triggers]
work_complete = "notify_user with title \\"Work complete\\" + 1-2 sentence TLDR of what was done."
blocking_question = "notify_user with title \\"Need your input to continue\\" + brief blocker summary, then call AskUserQuestion."
tests_failed = "notify_user with title \\"Tests failed, fixing now\\" + 1-line failure summary."
unexpected_error = "notify_user with title \\"⚠️ Error during implementation\\" + brief error + action needed."
`;
}
