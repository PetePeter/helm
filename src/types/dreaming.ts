/**
 * Dreaming: the scheduled memory-maintenance pass. One prompt, edited in
 * Settings -> Dreaming, drives every project's dream; each project's row adds
 * its own addendum. See docs/dreaming.md.
 */
export interface DreamingSettings {
  /** The dream prompt as edited in Settings. Empty = use DEFAULT_DREAM_PROMPT. */
  prompt: string;
}

export type DreamingConfigResult =
  | { success: true; settings: DreamingSettings }
  | { success: false; error: string };

export const DEFAULT_DREAM_PROMPT = `Time to dream: review and maintain this project's durable memories.

Tools: memory_dream, memory_list, memory_get, memory_search, memory_create, memory_update, memory_delete, memory_link, memory_set_dormant, mess_check

## What it is
A dream is housekeeping, not new work: you are curating what this project already knows so future sessions inherit a sharper memory instead of a bigger one.
Scope is the single project resolved from your own session. You may LINK to another project's memories when they relate, but never edit them.
You are trusted to use judgement here. There is no checklist that produces a good memory set; read the candidates and decide.

## Procedure
- Call memory_dream. It returns FADED candidates (rarely read, weakly linked) and SALIENT candidates (frequently read or heavily linked), with the metrics behind each. contentChars over ~300 usually means several ideas to split. It also returns BOUND memories; digest those first, as [bound_memories] says.
- Read the actual memory before acting on it. memory_get returns it in full with its links as id + tldr — a memory that looks stale in isolation is often the hub of a cluster.
- Retire what no longer earns its place with memory_set_dormant. Dormant is reversible and searchable; prefer it to memory_delete.
- Split essays into atoms: a memory holding several ideas becomes one memory per idea (memory_create), each tldr stating its idea, linked with a type (part-of, supports, example-of...). Keep the original as a short summary pointing at the atoms, or set it dormant once nothing is lost.
- Merge only true duplicates (the same idea twice): keep the sharper one, link the other to it as supersedes, set it dormant.
- Link what relates: memory_search each atom's idea (hits are id + tldr; memory_get one before judging it), and memory_link it to the related memories you find, in any project, with the type that says why.
- Sharpen salient memories whose tldr no longer matches their content, or that have drifted out of date.

## Bound memories
memory_dream.bound lists memories Helm auto-saved while sessions worked: grouped by session, each group with that session's mission (null once the session is gone), each memory in full. A small model wrote them unattended and only their own session can see them. They become project knowledge only if you promote them.
Leave none unexamined: every listed memory ends this dream deleted, merged or promoted. totals.bound above the number listed means the next dream gets the rest.
- Read the memory against its session's mission. Is it true beyond that session and useful to a later one? If not (a passing state, a guess, a restatement of the task, something wrong), memory_delete it.
- memory_search project memory for the same idea, and memory_get a hit before judging it. Check the other bound memories too: two sessions often save the same fact.
- Already known: merge, never keep two memories of one idea. Usually the project atom stays: fold anything new into it (memory_update) and memory_delete the bound one. If the bound one is the sharper statement, promote it as in the next point, memory_link it to the old atom as supersedes, and set the old atom dormant.
- New and worth keeping: memory_update it with promote=true, bringing the tldr to the atom standard in the same call (it states the idea, one idea only). Then memory_link it to what it relates to, with a type.
- Never promote unread, and never promote in bulk. A promoted memory is hinted to every session of the project.
- When unsure whether a bound memory is true, delete it. A missing fact gets re-learned; a wrong one misleads every later session.

## Rules
- Age alone is never a reason to retire a memory. An old, correct, frequently-read fact is the most valuable thing in the store.
- Respect the candidate metrics: they are evidence, not instructions. A faded candidate you judge important stays.
- Prefer memory_set_dormant over memory_delete. Delete only a memory that is wrong or was never worth keeping.
- The goal is small memories that add up through their links, not fewer bigger ones. Never lose a fact while splitting or merging.
- Do not invent knowledge during a dream. New memories come only from splitting existing ones, or from a link revealing a fact worth stating.
- A dream that changes nothing is a valid outcome. Say so and stop; churn is worse than a no-op.
- Leave a brief account of what you retired, merged, or rewrote, so the next dream can see your reasoning.
`;
