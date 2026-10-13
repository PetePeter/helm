# Memory — a knowledge graph of small facts

Durable memories are meant to be **atoms**: one idea each, whose links add up
to more than the parts. Search finds the atoms; links carry the structure.

```mermaid
graph LR
    subgraph "project A (yours)"
        A1[RS485 needs 9600 baud] -- supports --> A2[Charger answers on Modbus id 1]
        A3[Wiring notes · summary] -- part-of --> A1
    end
    subgraph "project B (shared)"
        B1[Modbus timeout 200ms]
    end
    A2 -- example-of --> B1
```

## Why atoms

A 1–6 KB memory holds several ideas, so it matches too many searches and
links too vaguely. One idea per memory (soft cap ~300 chars, `ATOM_SOFT_LIMIT`)
makes each link say something precise. The cap is advisory: `memory_create`
returns an `atomHint` rather than refusing.

## Writing grows the graph

`memory_create` returns the new record plus `similar`: the 5 closest memories
the caller can find (any shared project), minus ones already linked. The AI is
told to link each related one with a type. Without this prompt nobody links,
and the graph stays a pile.

## Typed links

`memory_link { fromId, toId, type? }` — `supports`, `contradicts`, `part-of`,
`example-of`, `supersedes`; omitted = plain "related" (every pre-existing
edge). One edge per ordered pair: linking again retypes it. An unknown type
read from disk degrades to plain rather than failing the store.

## Search

`src/session/memory-search.ts` — MiniSearch BM25 over tldr (×2) and content,
any term matching, typo/prefix slack on longer words, stop words dropped
(`search-terms.ts`, shared with the prompt hint scorer). A literal substring
still matches, ranked last, so `deploy` finds `prepareDeploy`. `regex=true`
filters instead of ranking. The index is built per call: a store of tens to
hundreds of memories costs less to index than to keep a synced copy.

### Search is cheap, get is full

```mermaid
flowchart LR
    Q[memory_search] --> H["5 best hits · id + tldr<br/>matched = every match"]
    H -->|pick one| G[memory_get]
    G --> R[that memory in full]
    G --> N[its links · id + tldr]
    N -->|pick one| G
```

- **Why:** older memories run to several KB. Returning each hit in full, with
  its neighbours, let one search flood a small model's context and cost every
  caller tokens it did not ask to spend.
- **One shape for every caller.** A hit is `id`, `tldr`, `score`, `projectId`,
  `foreign`; never content. `MEMORY_SEARCH_LIMIT` (5) caps `memory_search`, and
  `matched` says how many matched so the caller knows to narrow the query.
  `regex=true` follows the same shape and cap.
- **`memory_get`** returns the asked-for memory whole and everything it reaches
  (`graphDepth` defaults to 1) as id + tldr, with the edge type on `via`.
- **Not capped:** the Memory pane's search. It highlights every match on the
  canvas and its hits carry no content, so there is nothing to protect.
  `memory_graph` and `memory_export` are explicit dumps and stay full.

## Cross-project

```mermaid
flowchart LR
    S[session in project A] -->|search / get / link target| F{findable}
    F --> O[A's memories · boost ×2]
    F --> X[other projects' memories<br/>unless memory_private]
    S -->|create / update / delete / list / link source| W[A's memories only]
```

- Search covers every project that shares; own-project matches score ×2 and
  each hit carries `projectId` and `foreign`. A foreign memory is another
  repo's knowledge — the AI must judge whether it applies.
- Writing stays fenced (`owns` unchanged). Links may point across projects;
  that is how two similar repos share.
- `project_memory_private { projectId, private }` keeps a project out of
  everyone else's search. Absent = shared. `MemoryManager` without an
  `isProjectShared` policy keeps the old full fence.

## Session-bound memories

A memory Helm saves unattended is not project knowledge yet. It carries
`sessionBound: true` and stays private to the session that produced it
(`sessionId`) until a dream has read it and released the binding.

```mermaid
flowchart LR
    A[auto-save<br/>sessionBound] --> B{who asks?}
    B -->|its own session| V[visible: get · search · similar · list]
    B -->|any other session<br/>same project · other project · operator| H[hidden]
    A -->|releaseBinding| P[ordinary project memory]
    M[memory_create] --> P
```

- **Why:** a small model writing on every turn would otherwise flood search,
  hints and `similar` for every session in the project.
- **One rule.** `MemoryManager.candidateRecords` drops other sessions' bound
  memories before project scope, read-all or cross-project sharing widen the
  set, so no read path can skip it. Hidden also means untouchable: update,
  delete, dormancy and link targets go through the same set.
- **Edges too.** `edgesFor` drops any edge touching a hidden memory, rather
  than keeping it as a `missing` marker that would disclose its id.
- **Not in the project's shared pool.** `listProjectRecords` and the dream's
  faded/salient lists leave bound memories out. Prompt hints add back only the
  asking session's own (`listBoundForSession`), see
  [auto-memory.md](auto-memory.md#auto-recall).
- **Lifetime.** A bound memory in a project outlives its session, so the next
  dream can still digest it. One written by a project-less session goes with
  that session, as any session-private memory does.
- `memory_create` never binds; only first-party code can.

## Dreaming

The dream guide now splits essays into linked atoms (candidates carry
`contentChars`), merges only true duplicates (`supersedes`), and links related
memories across projects. See [dreaming.md](dreaming.md).

## Memory skills across the plan lifecycle

Three system skills teach agents to use memory; each is cued by the tool reply
at the moment it matters, so the procedure lives in one place and can change
without touching callers.

```mermaid
graph LR
    C[session_plan_claim] -->|cues| R[recalling<br/>search before work]
    P[plan_complete] -->|cues| M[memorising<br/>record what was learned]
    S[scheduled dream] -->|cues| D[dreaming<br/>prune + consolidate]
```

- **recalling** (`sys-recall`) — search specific-to-broad, follow links, verify stale facts before acting.
- **memorising** (`sys-memorise`) — search first and update rather than duplicate, one atom per idea with why/how-to-apply, link it.
- **dreaming** (`sys-dream`) — see [dreaming.md](dreaming.md).

A user skill of the same type shadows the system one.
