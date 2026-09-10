/**
 * Agent-facing guidance for a dreaming run — the scheduled memory-maintenance
 * pass. The scheduled prompt only cues this skill; the procedure lives here so
 * it can be revised without touching the scheduler.
 */
export function buildDreamGuide(): string {
  return `\
[dreaming]
description = "Scheduled maintenance pass over one project's durable memories."
tools = ["memory_dream", "memory_list", "memory_get", "memory_search", "memory_update", "memory_link", "memory_set_dormant", "mess_check"]

[what_it_is]
line_1 = "A dream is housekeeping, not new work: you are curating what this project already knows so future sessions inherit a sharper memory instead of a bigger one."
line_2 = "Scope is the single project resolved from your own session. Never touch another project's memories."
line_3 = "You are trusted to use judgement here. There is no checklist that produces a good memory set; read the candidates and decide."

[procedure]
step_1 = "Call memory_dream. It returns FADED candidates (rarely read, weakly linked) and SALIENT candidates (frequently read or heavily linked), with the metrics behind each."
step_2 = "Read the actual memory before acting on it. memory_get with graphDepth shows what links into it — a memory that looks stale in isolation is often the hub of a cluster."
step_3 = "Retire what no longer earns its place with memory_set_dormant. Dormant is reversible and searchable; prefer it to memory_delete."
step_4 = "Consolidate duplicates and near-duplicates: fold the detail into the strongest memory with memory_update, link the survivors with memory_link, then set the absorbed ones dormant."
step_5 = "Sharpen salient memories whose tldr no longer matches their content, or that have drifted out of date."
step_6 = "Finish with mess_check so you pick up notes other sessions left for this project."

[rules]
rule_1 = "Age alone is never a reason to retire a memory. An old, correct, frequently-read fact is the most valuable thing in the store."
rule_2 = "Respect the candidate metrics: they are evidence, not instructions. A faded candidate you judge important stays."
rule_3 = "Prefer memory_set_dormant over memory_delete. Delete only a memory that is wrong or was never worth keeping."
rule_4 = "Consolidating means preserving the information in fewer places, not discarding it. If a merge would lose a fact, do not merge."
rule_5 = "Do not invent new memories during a dream. Record something new only if consolidation genuinely produces it."
rule_6 = "A dream that changes nothing is a valid outcome. Say so and stop; churn is worse than a no-op."
rule_7 = "Leave a brief account of what you retired, merged, or rewrote, so the next dream can see your reasoning."
`;
}
