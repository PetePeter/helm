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
step_1 = "memory_search once with the specific terms and their synonyms together: file, function, error text, feature name. A plain query matches any term, so one query covers them."
step_2 = "Too many hits? Narrow with an expression: a AND b, \"exact phrase\", a NEAR/5 b, -word."
step_3 = "A search returns the 5 best hits as id + tldr. memory_get the hits that matter: you get the memory in full and its links as id + tldr. memory_get a linked one too when its tldr looks relevant; it often carries the reason or the trap. If matched is above 5, narrow the query."

[rules]
rule_1 = "Memories reflect what was true when written. Verify a named file, function or flag still exists before acting on it."
rule_2 = "A foreign memory (another project's) is a hint, not a fact here; check it applies."
rule_3 = "If a memory turns out wrong or stale, fix it with memory_update so the next session is not misled."
`;
}
