/**
 * Agent-facing guidance for writing durable memories. Cued when a plan is
 * completed — the moment a session knows what it learned.
 */
export function buildMemoriseGuide(): string {
  return `\
[memorising]
description = "How to record what you learned as durable project memory."
tools = ["memory_search", "memory_get", "memory_create", "memory_update", "memory_link"]

[when]
line_1 = "Save what a future session could not cheaply rediscover: a surprising cause, a decision and its reason, a user preference or correction, a trap that cost you time."
line_2 = "Do not save what the repo already records (code structure, git history, docs) or what only mattered to this conversation."
line_3 = "Saving nothing is a valid outcome when you learned nothing durable."

[procedure]
step_1 = "memory_search the idea first, with specific terms. If a memory already covers it, memory_update that one instead of creating a duplicate; correct it if it is wrong."
step_2 = "memory_create one atom per idea: a tldr that states the fact itself, content that adds Why (the reason or incident) and How to apply (when it matters, what to do)."
step_3 = "memory_link the new atom to related memories you found, with a type that says why (supports, example-of, part-of, supersedes...), in any project."

[rules]
rule_1 = "One fact per memory. Several ideas means several memories, linked."
rule_2 = "Convert relative dates to absolute ones; name files, functions and errors exactly so search finds them."
rule_3 = "Never store secrets or credentials."
`;
}
