/**
 * Agent-facing guidance for retrieving durable memories. Cued when a plan is
 * claimed — before work starts, while prior knowledge can still change it.
 */
export function buildRecallGuide(): string {
  return `\
[recalling]
description = "How to find what this project already knows before starting work."
tools = ["memory_search", "memory_get", "memory_graph"]

[procedure]
step_1 = "memory_search the task with its most specific terms: file, function, error text, feature name."
step_2 = "Widen until your terminology is exhausted: drop terms, try synonyms and alternate spellings. Only then conclude nothing is stored."
step_3 = "memory_get the hits that matter with graphDepth to follow their links; the linked memories often carry the reason or the trap."

[rules]
rule_1 = "Memories reflect what was true when written. Verify a named file, function or flag still exists before acting on it."
rule_2 = "A foreign memory (another project's) is a hint, not a fact here; check it applies."
rule_3 = "If a memory turns out wrong or stale, fix it with memory_update so the next session is not misled."
`;
}
