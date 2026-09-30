/**
 * Agent-facing guidance for a dreaming run — the scheduled memory-maintenance
 * pass. The scheduled prompt only cues this skill; the procedure lives here so
 * it can be revised without touching the scheduler.
 */
export function buildDreamGuide(): string {
  return `\
[dreaming]
description = "Scheduled maintenance pass over one project's durable memories."
tools = ["memory_dream", "memory_list", "memory_get", "memory_search", "memory_create", "memory_update", "memory_link", "memory_set_dormant", "mess_check"]

[what_it_is]
line_1 = "A dream is housekeeping, not new work: you are curating what this project already knows so future sessions inherit a sharper memory instead of a bigger one."
line_2 = "Scope is the single project resolved from your own session. You may LINK to another project's memories when they relate, but never edit them."
line_3 = "You are trusted to use judgement here. There is no checklist that produces a good memory set; read the candidates and decide."

[procedure]
step_1 = "Call memory_dream. It returns FADED candidates (rarely read, weakly linked) and SALIENT candidates (frequently read or heavily linked), with the metrics behind each. contentChars over ~300 usually means several ideas to split."
step_2 = "Read the actual memory before acting on it. memory_get with graphDepth shows what links into it — a memory that looks stale in isolation is often the hub of a cluster."
step_3 = "Retire what no longer earns its place with memory_set_dormant. Dormant is reversible and searchable; prefer it to memory_delete."
step_4 = "Split essays into atoms: a memory holding several ideas becomes one memory per idea (memory_create), each tldr stating its idea, linked with a type (part-of, supports, example-of...). Keep the original as a short summary pointing at the atoms, or set it dormant once nothing is lost."
step_4b = "Merge only true duplicates (the same idea twice): keep the sharper one, link the other to it as supersedes, set it dormant."
step_4c = "Link what relates: memory_search each atom's idea, and memory_link it to the related memories you find, in any project, with the type that says why."
step_5 = "Sharpen salient memories whose tldr no longer matches their content, or that have drifted out of date."
step_6 = "Finish with mess_check so you pick up notes other sessions left for this project."

[rules]
rule_1 = "Age alone is never a reason to retire a memory. An old, correct, frequently-read fact is the most valuable thing in the store."
rule_2 = "Respect the candidate metrics: they are evidence, not instructions. A faded candidate you judge important stays."
rule_3 = "Prefer memory_set_dormant over memory_delete. Delete only a memory that is wrong or was never worth keeping."
rule_4 = "The goal is small memories that add up through their links, not fewer bigger ones. Never lose a fact while splitting or merging."
rule_5 = "Do not invent knowledge during a dream. New memories come only from splitting existing ones, or from a link revealing a fact worth stating."
rule_6 = "A dream that changes nothing is a valid outcome. Say so and stop; churn is worse than a no-op."
rule_7 = "Leave a brief account of what you retired, merged, or rewrote, so the next dream can see your reasoning."
`;
}
