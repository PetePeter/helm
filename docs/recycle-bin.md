# Recycle Bin (closed recoverable sessions)

Closing a session that carried a `cliSessionName` (its CLI-internal resume UUID)
snapshots it into a rolling **7-day** bin instead of losing it. Restoring reuses the
normal spawn-with-resume flow, so a recovered session is indistinguishable from one
resumed at startup.

## Why this exists

A hub session is a thin wrapper around a CLI conversation. When it carries a
`cliSessionName`, the *conversation still exists on disk* inside the CLI — closing
the hub session only throws away the handle. Before the bin, an accidental close (or
a close-and-then-changed-my-mind) meant that handle was gone and the conversation was
effectively unreachable, even though nothing had actually been deleted.

Ephemeral sessions (no `cliSessionName`) have nothing to come back to, so they are
**never** recorded — a bin full of unrestorable rows is worse than no bin.

The visible list is limited to the 7-day window. Expired entries remain in the
persisted state until startup maintenance has queued their cleanup. Startup
orphan retention includes every persisted bin entry and pending purge job, so
recoverable data stays protected until its owning profile queue cleans it.

## Architecture

```mermaid
graph TB
    subgraph Main["Main process"]
        SR["session:removed<br/>(handlers.ts)"]
        RRS["recordRemovedSession()<br/>bookmark dir + append entry"]
        RBM["RecycleBinManager<br/>EventEmitter · injectable clock<br/>append/list/count/peek/forget/empty"]
        RBP["recycle-bin-persistence<br/>recycle-bin.yaml · 7d prune"]
        RBQ["RecycleBinPurgeMaintenance<br/>one fixed-store queue per profile"]
        RBH["recycle-bin-handlers<br/>4 IPC channels"]
        RBR["profile-runtime-routing<br/>shared atomic restorer"]
        AM["ArtifactManager"]
        SR -->|"resolve project + runtime group"| RRS --> RBM --> RBP
        RBH --> RBM --> RBQ
        RBH --> RBR
        RBR --> RBM
        RBQ -->|"forget / empty / expiry<br/>one session per setImmediate turn"| AM
    end
    subgraph MCP["MCP"]
        MCPC["Local / phone / peer caller"]
        RBS["HelmRecycleBinService<br/>profile-scoped search + restore"]
        MCPC --> RBS --> RBM
        RBS -->|"explicit profile id + expected name"| RBR
    end
    subgraph Renderer
        URB["useRecycleBin<br/>(module-singleton refs)"]
        BADGE["🗑️ Recycle Bin button + badge<br/>(Project Planner section)"]
        MODAL["RecycleBinModal.vue<br/>nested collapsible searchable tree"]
        TREE["buildRecycleTree()<br/>pure · unit-tested"]
        URB --> BADGE & MODAL
        MODAL --> TREE
    end
    RBH -. "recycle-bin:changed" .-> URB
    URB -->|"recycleBin:*"| RBH
    URB -->|"restore → owning profile runtime<br/>+ sessionRename + runtimeGroupReattach"| RBH
```

## MCP tools

`recycle_bin_search` reads only the caller's profile and returns entries from the
rolling 7-day window. It can match name, working directory, project, and mission
text, with optional exact directory and CLI filters. Results include the saved
name and grouping metadata but never the CLI resume credentials.

`recycle_bin_restore` takes a search result's `id` and optional `name`. The name is
an expected-name guard; the saved display name is restored through the same atomic
main-process path as the desktop. Success returns the original `sessionId`. Unknown,
expired, mismatched, duplicate, or failed restores return an error; a failed spawn
keeps the entry available for retry. Phone tool grants and peer inbound access use
their existing data-driven gates.

## What gets recorded

`recordRemovedSession(event, recycleBin, bookmarkDir, runtimeGroup?, project?)`
(`src/session/recycle-bin-manager.ts`) is the single wiring helper for the
`session:removed` event. It keeps two side effects together and unit-testable:

1. **Auto-bookmark** the working directory (so the group header persists with 0
   active sessions), and
2. **Append the bin entry** — under exactly the same condition: the session had both
   a `cliSessionName` **and** a `workingDir`. Otherwise it returns `null`.

`RecycleBinEntry` (`src/types/recycle-bin.ts`):

| Field | Why it is captured |
|---|---|
| `id` | The bin entry's own UUID — distinct from the session id |
| `sessionId` | The original hub session id — **reused on restore** (see below) |
| `name`, `cliType`, `workingDir` | Enough to re-spawn |
| `cliSessionName` | Passed as `resumeSessionName` — the actual recovery key |
| `closedAt` | Retention key + "closed Xm ago" display |
| `projectId?` / `projectName?` | Snapshotted at close so the tree renders without re-resolving, and survives a later project rename |
| `runtimeGroupId?` / `runtimeGroupName?` | So restore can re-attach, recreating the group by id+name if it was closed meanwhile |

**Project resolution uses `findByPath` / `getById`, never `resolveForPath`.** The
comment in `handlers.ts` states the reason plainly: `resolveForPath` would *create* a
project, so a close event could spawn a phantom project. Closing a session must never
have that effect.

After recording, the session is evicted from its runtime group via
`runtimeGroupManager.removeSessionEverywhere(sessionId)` — the tag on the bin entry
is what remembers the association.

## Restore is one main-process transaction

The main process resolves the runtime that owns the entry and keeps the whole
operation on it, even if the desktop switches profiles while the IPC request is
in flight:

1. `recycleBin:restore(id)` reserves the entry before awaiting spawn and runs the
   standard configured spawn with that runtime's session manager and config loader.
   The normal profile cwd assertion rejects directories outside that profile's projects.
2. Spawn failed → **the entry stays in the bin**, retryable.
3. The same runtime restores the mission, display name, and tagged runtime group.
   `session:rename(entry.sessionId, entry.name)` re-applies the **display name the
   session was closed under** (see below). `runtimeGroupReattach` recreates a missing
   group before adding the session.
4. The entry is durably removed only after spawn and metadata restoration succeed.
   If that save fails, the PTY and live session row are rolled back while the bin
   entry and its saved session data remain available for retry.

Forget or Empty attempted during an active restore returns `{ ok: false, error }`;
the operation leaves the row and cleanup queue untouched.

A renderer and main-process in-flight guard prevent duplicate restores.

### Name reuse

`pty:spawn` names every new session after its `cliType`, so a restored session would
otherwise come back as "claude-code" and lose whatever the user called it. Step 5
re-applies `entry.name` — skipped when the name is blank or is just the `cliType`
(nothing was ever customised). The rename is non-fatal: the session is already back,
so a failure logs and lets the group re-attach proceed. This mirrors startup
auto-resume, which renames the same way after `doSpawn`.

The main-process transaction keeps failed restores retryable without a separate
commit channel.

### Session id reuse

Restore deliberately reuses the **original session id**. Anything keyed by session id
— most importantly the session's preserved **artifacts** — comes back attached with
no re-keying. This is the same thing startup auto-resume does.

## Artifact lifecycle coupling

Artifacts are ephemeral per-session reports, and their lifetime is bound to the bin:

| Event | Artifacts |
|---|---|
| Recoverable close (entry created) | **Kept**, under the same session id |
| Non-recoverable / ephemeral close | Cleared immediately (`if (!binned) artifactManager.clearSession(...)`) |
| Restore | Kept — the reused id owns them again |
| `recycleBin:forget` | Hidden immediately; per-session cleanup runs from the durable queue |
| `recycleBin:empty` | All entries hidden immediately; each cleanup runs from the durable queue |
| Entry ages out at runtime | Hidden and queued as `expired` cleanup |
| Startup | Orphan pruning retains every on-disk bin entry and pending job; the deferred per-profile queue owns expiry cleanup |

The session's [draft](draft.md) follows the same table: kept while the
session is in the bin, deleted on Forget, Empty and expiry, reclaimed at startup.

Runtime expiry uses the same durable queue as Forget and Empty, so preserved data
is eventually reclaimed even if the app exits while a purge is pending.

## Persistence

| Aspect | Detail |
|---|---|
| File | `RECYCLE_BIN_FILE` — `%APPDATA%/Helm/config/recycle-bin.yaml` |
| Shape | `{ entries: [...], pendingPurges: [{ entry, kind }] }` (legacy `{ entries }` remains readable) |
| Write | Small synchronous `atomicWriteFileSync`; expiry queue intent and restore removal must save before memory changes |
| Load | Validates entries and pending jobs; expired entries stay available for startup pruning |
| Retention | `RECYCLE_BIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000` |
| Ordering | In-memory newest-first (`unshift`); `list()` re-sorts by `closedAt` descending |
| Clock | Injectable `now: () => number` for deterministic retention tests |

## Purge queue

Forget, Empty, and expiry move entries into `pendingPurges` and update the visible
list before cleanup begins. The queue processes one session on each
`setImmediate` turn. A successful cleanup removes its job; a failed cleanup is
logged and stays pending for the next startup, without another attempt in the
same process. Startup expiry pruning and queue draining begin after the main
window first shows.

Each concrete profile runtime owns a queue bound to its own managers. All queues
start after the main window first shows; a profile created later starts its queue
immediately. Switching the active profile cannot retarget a queued job.

Per-session store cleanup remains synchronous. The queue yields between sessions
to avoid one N-session loop monopolizing the main process. The recycle-bin YAML
write also remains synchronous and atomic because the durable job record is small.
Cleanup persistence sinks report failure to the worker, which keeps the durable
job for the next startup.

Profile deletion is blocked while any session remains retained in that profile's
recycle-bin state, including expired rows whose prune save failed and queued purge
jobs. This keeps failed cleanup and shared chat-journal work attached to the owning
runtime until it finishes.

## IPC channels

| Channel | Purpose |
|---|---|
| `recycleBin:list` | All entries, newest close first (returns `[]` on error) |
| `recycleBin:restore(id)` | Returns `{ ok, entry }` or `{ ok: false, error }`; spawns on the owning profile, then durably removes the row |
| `recycleBin:forget(id)` | Returns `{ ok: true }` or `{ ok: false, error }`; hides the entry and queues cleanup |
| `recycleBin:empty` | Returns `{ ok: true }` or `{ ok: false, error }`; hides all entries and queues cleanup |
| `recycle-bin:changed` | Main → renderer event, broadcast to every live window |

Exposed to the renderer through a `recycleBin` preload domain.

## UI

A **🗑️ Recycle Bin** button with a live badge count sits in the Project Planner
section (bottom-left) and opens `RecycleBinModal.vue`.

The modal is a **nested, collapsible, searchable tree** —
`Project ▸ Runtime Group ▸ Folder ▸ sessions`, with ungrouped folders sitting at
project level with no group wrapper. It is built by the pure, unit-tested
`renderer/recycle-bin-tree.ts`:

```
buildRecycleTree(entries, resolveProject, query)
  → RecycleProjectNode[] → RecycleGroupNode[] → RecycleFolderNode[] → RecycleBinEntry[]
```

- `resolveProject` prefers the entry's **stored** project, falling back to a
  `state.projects` working-dir lookup for legacy entries (written before
  `projectId`/`projectName` existed), else the synthetic `(no project)` bucket
  (`NO_PROJECT_ID` / `NO_PROJECT_NAME`).
- Ordering is deterministic, newest-first at every level.
- Every level folds independently with a live descendant count. Nodes start
  **collapsed** and their fold state is remembered across modal visits and app
  restarts (`renderer/tree-collapse-state.ts` — expanded ids only, in
  `localStorage`, namespaced per level so a project and a folder can share a key).
- The search box filters across name / CLI / path and auto-hides emptied levels; the
  header count switches to **"N shown · last 7 days"**.
- Rows show name + a plain-text CLI badge, the full working-dir path (tooltip +
  ellipsis), an optional runtime-group chip, and
  `closed Xm ago · yyyy/mm/dd HH:mm`.
- Per-folder **↺ Restore all** / **🗑 Forget all** simply loop the single-entry IPC.
- **Empty bin** is gated behind a confirmation
  (`renderer/components/modals/EmptyRecycleBinModal.vue`, built on the shared
  `ConfirmDialog`) — it destroys every entry *and* its artifacts with no way back.
  The confirm states the count; confirming empties and closes the bin. It is reset
  whenever the bin's visibility changes, so it never floats over a closed bin or
  reappears stale.
- Empty state: "No closed sessions to restore".

**Expiry is deliberately not surfaced.** No countdown, no colour bars. Retention is
the manager's concern; showing a ticking clock would turn a safety net into a
deadline the user feels obliged to manage.

Reactive state lives in `renderer/composables/useRecycleBin.ts` — module-singleton
refs shared by the badge and the modal, so the count is never stale relative to the
list.

## Key modules

| File | Role |
|------|------|
| `src/types/recycle-bin.ts` | `RecycleBinEntry` |
| `src/session/recycle-bin-manager.ts` | `RecycleBinManager` + `recordRemovedSession` |
| `src/session/recycle-bin-persistence.ts` | YAML load/save, `RECYCLE_BIN_WINDOW_MS` |
| `src/session/recycle-bin-purge-queue.ts` | Durable-job scheduler, one session per event-loop turn |
| `src/session/recycle-bin-manager.test.ts`, `recycle-bin-persistence.test.ts` | Retention, recording condition, serialisation |
| `src/electron/ipc/recycle-bin-handlers.ts` | 5 IPC channels + artifact coupling |
| `src/electron/ipc/handlers.ts` | `session:removed` wiring (project + runtime-group resolution) |
| `src/session/artifact-orphan-prune.ts` | `pruneOrphanArtifacts` at startup |
| `renderer/recycle-bin-tree.ts` | Pure tree builder |
| `renderer/tree-collapse-state.ts` | Persisted expand/collapse memory (reusable by any tree) |
| `renderer/composables/useRecycleBin.ts` | Reactive state + the restore transaction |
| `renderer/components/sidebar/RecycleBinModal.vue` | The tree UI |
| `renderer/screens/sessions-spawn.ts` | `doSpawn` — shared with startup resume |

## Distinct from

- **Runtime Groups** — the bin *tags* entries with a group so restore can re-attach,
  but grouping is a separate concern.
- **Scheduled Task History** — 7-day, read-only evidence; nothing is restorable.
