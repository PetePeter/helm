# Directory Plans

Per-directory acyclic directed graph of work items with dependency arrows and a 6-state lifecycle. Plans are folder-level (not session-level like drafts) and persist to individual JSON files under `config/plans/` with dependencies in `config/plan-dependencies.json` (not per-profile).

## Overview

```mermaid
graph LR
    subgraph "Plan Lifecycle"
        P[⚪ Planning<br/>grey #555]
        S[🔵 Ready<br/>blue #4488ff]
        D[🟢 Coding<br/>green #44cc44]
        R[🟣 Review<br/>purple #9b59ff]
        B[🟠 Blocked<br/>orange #ff9f1a]
        DN[✓ Done<br/>grey + strikethrough]
    end

    P -->|"deps completed<br/>(auto)"| S
    S -->|"plan_set_state coding<br/>(claim)"| D
    D -->|"plan_set_state review"| R
    D -->|"plan_set_state blocked"| B
    R -->|"plan_complete"| DN
    D -->|"plan_complete"| DN
    DN -.->|"cascades<br/>ready recompute"| P
```

### Status Colors

| Status | Color | Hex | Meaning |
|--------|-------|-----|---------|
| `planning` | Grey | `#555555` | Initial or dependency-blocked planning state |
| `ready` | Blue | `#4488ff` | All dependencies done, ready to pick up |
| `coding` | Green | `#44cc44` | Actively being worked on by a session |
| `review` | Purple | `#9b59ff` | Awaiting review before completion |
| `blocked` | Orange | `#ff9f1a` | Cannot proceed; `stateInfo` should explain why |
| `done` | Grey + strikethrough | `#555555` | Completed (dashed border on node) |

## Architecture

```mermaid
graph TB
    subgraph "Main Process"
        PM[PlanManager<br/>EventEmitter]
        PH[plan-handlers.ts<br/>12 IPC channels]
        SP[persistence.ts<br/>plan file I/O]
        PY[config/plans/*.json]
    end

    subgraph "Renderer Process"
        PS[plan-screen.ts<br/>SVG canvas]
        PE[DraftEditor.vue<br/>Plan edit panel]
        PL[plan-layout.ts<br/>Sugiyama layout]
        PC[plan-chips.ts<br/>Badges + chips]
        SR[SessionList.vue / PlansGrid.vue<br/>🗺️ button + badges]
        DS[draft-strip.ts<br/>Plan chips]
    end

    SR -->|"click 🗺️"| PS
    PS -->|"IPC"| PH
    PH --> PM
    PM -->|"plan:changed"| SP
    SP --> PY
    PS --> PL
    PS --> PE
    PC --> DS
    PC --> SR
```

## Data Model

### PlanItem

```typescript
interface PlanItem {
  id: string;           // UUID v4
  dirPath: string;      // Directory this plan belongs to
  title: string;        // Short title displayed on the node
  description: string;  // Longer description / prompt content
  status: PlanStatus;   // 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done'
  sessionId?: string;   // Set when status is 'coding' or 'review'
  stateInfo?: string;   // Required context for blocked/question states
  completionNotes?: string;
  autoImplement?: boolean;
  sequenceId?: string;
  createdAt: number;    // Creation timestamp
  updatedAt: number;    // Last update timestamp
}
```

### PlanDependency

```typescript
interface PlanDependency {
  fromId: string;  // The blocker item ID (must be done first)
  toId: string;    // The blocked item ID (can't start until blocker is done)
}
```

### DirectoryPlan

```typescript
interface DirectoryPlan {
  dirPath: string;
  items: PlanItem[];
  dependencies: PlanDependency[];
}
```

## PlanManager (Main Process)

EventEmitter in `src/session/plan-manager.ts`. Stores items in a `Map<string, PlanItem>` and dependencies as a flat `PlanDependency[]` array.

### Operations

| Method | Description |
|--------|-------------|
| `create(dirPath, title, description)` | Create new item. No-dep items become `ready`. |
| `update(id, { title?, description? })` | Update title and/or description. |
| `delete(id)` | Delete item + all its edges. Recomputes ready state. |
| `getItem(id)` | Get a single item by ID. |
| `getForDirectory(dirPath)` | Get all items for a directory. |
| `getStartableForDirectory(dirPath)` | Legacy IPC name for ready items in a directory. |
| `getDoingForSession(sessionId)` | Legacy IPC name for coding/review items owned by a session. |
| `addDependency(fromId, toId)` | Add edge. Rejects self-loops, cross-dir, duplicates, cycles. |
| `removeDependency(fromId, toId)` | Remove edge. Recomputes ready state. |
| `setState(id, 'coding', sessionId)` | Claim ready work. Associates with session. |
| `completeItem(id)` | `coding`/`review` → `done`. Cascades ready recompute. |
| `exportAll()` / `importAll(data)` | Persistence serialization. |

### DAG Validation

Cycle prevention uses DFS: before adding edge `fromId → toId`, checks whether `toId` can already reach `fromId` through existing edges. Also rejects:
- Self-loops (`fromId === toId`)
- Cross-directory edges (items must share `dirPath`)
- Duplicate edges

### Ready Computation

`recomputeStartable(dirPath)` is the legacy-named ready recomputation pass. It runs after every dependency or completion change:
1. For each item in the directory that is not `coding`, `review`, `blocked`, or `done`:
2. Find all incoming dependency edges (blockers)
3. If all blockers are `done` (or no blockers exist) -> status = `ready`
4. Otherwise -> status = `planning`

### Events

Emits `plan:changed` with `dirPath` on every mutation. PlanManager self-saves to disk on every mutation — no external save listener needed.

## IPC Channels

Core IPC channels registered in `src/electron/ipc/plan-handlers.ts`:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `plan:list` | invoke | Get all items for a directory |
| `plan:create` | invoke | Create a new plan item |
| `plan:update` | invoke | Update item title/description |
| `plan:delete` | invoke | Delete an item and its edges |
| `plan:addDep` | invoke | Add a dependency edge |
| `plan:removeDep` | invoke | Remove a dependency edge |
| `plan:apply` | invoke | Legacy IPC name that claims a ready item for a session |
| `plan:complete` | invoke | Mark a coding/review item as done |
| `plan:startableForDir` | invoke | Legacy IPC name for ready items in a directory |
| `plan:doingForSession` | invoke | Legacy IPC name for coding/review items owned by a session |
| `plan:deps` | invoke | Get dependencies for a directory |
| `plan:getItem` | invoke | Get a single item by ID |
| `plan:clearCompleted` | invoke | Delete the directory's done plans |
| `plan:cleanup-counts` | invoke | Preview counts for the bulk cleanups below |
| `plan:clear-empty-sequences` | invoke | Delete the project's sequences with no member plans |
| `plan:clear-unreferenced-contexts` | invoke | Delete the project's contexts with no plan or sequence binding |

All channels exposed via `contextBridge` in `preload.ts` as `window.gamepadCli.plan*` methods.

## Auto-Layout Algorithm

`renderer/plans/plan-layout.ts` implements a Sugiyama-style left-to-right layered layout:

```mermaid
graph LR
    A[1. Topological Sort<br/>Kahn's algorithm] --> B[2. Layer Assignment<br/>Longest path from roots]
    B --> C[3. Within-Layer Ordering<br/>Barycenter heuristic<br/>2-pass]
    C --> D[4. Coordinate Assignment<br/>layer × hSpacing<br/>order × vSpacing]
```

### Layout Pipeline

1. **Topological Sort** — Kahn's algorithm with alphabetical tie-breaking for deterministic output
2. **Layer Assignment** — Longest path from roots (0-indexed). Roots (no incoming edges) go to layer 0.
3. **Within-Layer Ordering** — Barycenter heuristic: forward pass (order by average position of parents) then backward pass (order by average position of children). Minimizes edge crossings.
4. **Coordinate Assignment** — `x = paddingX + layer × horizontalSpacing`, `y = paddingY + order × verticalSpacing`

### Layout Options

| Option | Default | Description |
|--------|---------|-------------|
| `horizontalSpacing` | 280px | Space between layers (left-to-right) |
| `verticalSpacing` | 140px | Space between nodes within a layer |
| `paddingX` | 60px | Horizontal padding from canvas edge |
| `paddingY` | 60px | Vertical padding from canvas edge |
| `nodeWidth` | 200px | Node width for centering |
| `nodeHeight` | 80px | Node height for centering |

### Output

```typescript
interface LayoutResult {
  nodes: LayoutNode[];  // { id, x, y, layer, order }
  width: number;        // Total canvas width
  height: number;       // Total canvas height
}
```

## SVG Canvas (Plan Screen)

`renderer/plans/plan-screen.ts` renders the plan DAG as an SVG overlay inside `#mainArea`. It is **not** a separate screen — it's a `.plan-screen` overlay checked via `isPlanScreenVisible()` within the sessions case of the screen router.

### Entry / Exit

- **Entry:** 🗺️ Plans button on group headers (column 1, click only — D-pad Right at col 0 opens the group overview)
- **Exit:** B button (gamepad) or ← Back button in plan header

### Bulk Cleanup

The header's **Clear unused** split button deletes stale records in the current project, always behind a confirmation that lists what will go:

- **Primary — Clear unused:** empty sequences first, then unreferenced contexts. Order matters: deleting a sequence releases its context bindings, so a context bound only to empty sequences is counted and cleared in the same pass.
- **▾ menu:** *Clear done plans*, *Clear empty sequences*, *Clear unreferenced contexts* — each on its own.

```mermaid
flowchart LR
    A[Clear unused] --> B[plan:cleanup-counts] --> C{anything?}
    C -- no --> N[Nothing to clear notice]
    C -- yes --> D[BulkCleanupModal] -- Clear --> E[clear-empty-sequences] --> F[clear-unreferenced-contexts] --> G[refresh canvas]
```

### Canvas Features

- **Pan:** Mouse drag on empty canvas area (viewBox-based)
- **Zoom:** Mouse wheel (scale factor 0.9/1.1 per step, focal-point zoom)
- **Nodes:** SVG `<g>` elements with rounded rect (8px radius), status dot, title text, description text, right-edge connector circle
- **Arrows:** Quadratic bezier `<path>` elements with `#arrowhead` marker. Click to remove dependency.
- **Selection:** Click a node to select it (blue highlight border) and open the bottom editor panel

### Node Rendering

Each node is a 200×80px SVG group with:
- Rounded rectangle with status-colored stroke (1.5px)
- Status dot (circle, r=5, filled with status color)
- Title text (13px, bold, truncated at 22 chars)
- Description text (11px, grey, truncated at 30 chars)
- Right-edge connector circle (r=6, for dependency arrows)
- Done nodes: dashed stroke (`stroke-dasharray: 6 3`)

### Arrow Rendering

Dependency arrows use quadratic bezier curves:
- Start: right edge of source node (`fromNode.x + NODE_W, fromNode.y + NODE_H/2`)
- End: left edge of target node (`toNode.x, toNode.y + NODE_H/2`)
- Control point: midpoint X, S-curve through midpoint Y
- Stroke: `#555`, 1.5px, with `marker-end="url(#arrowhead)"`

## Editor Panel

`renderer/components/panels/DraftEditor.vue` — Vue editor panel used for plan edits when a node is selected.

### Components

| Element | Behaviour |
|---------|-----------|
| Status indicator | Shows the current lifecycle label (`planning`, `ready`, `coding`, `review`, `blocked`, `done`) |
| Title input | Text field, saves on blur or Enter |
| Description textarea | Multi-line text area, saves on blur |
| 🗑 Delete button | Deletes item after `window.confirm()` confirmation |
| ✓ Done button | Only shown when status is `coding` or `review`. Marks item as done. |

## Plan Badges & Chips

`renderer/plans/plan-chips.ts` provides two display modes:

### Session Card Badges

`createPlanBadge(codingCount, readyCount, blockedCount, reviewCount)` returns an element with:
- Green map badge with coding count (when > 0)
- Blue map badge with ready count (when > 0)
- Orange/purple badges for blocked and review counts (when > 0)
- Returns `null` when all counts are 0

Rendered by the Vue sidebar components from the reactive plan-count maps.

### Draft Strip Chips

`renderPlanChips(sessionId)` appends plan chips to the draft strip (`#draftStrip`):
- Coding/review chips: green/purple legacy class names — click to re-send the plan prompt without changing ownership
- Ready chips: blue legacy class names — click to apply to the active session and transition to `coding`
- Truncated titles (max 20 chars) with map prefix

Called at the end of `refreshDraftStrip()` in `draft-strip.ts`.

## CSS Classes

| Class | Purpose |
|-------|---------|
| `.plan-screen` | Full overlay container inside `#mainArea` |
| `.plan-header` | Top bar with Back button, title, Add Node button |
| `.plan-canvas` | SVG canvas wrapper |
| `.plan-node` | SVG `<g>` for each plan item |
| `.plan-node--selected` | Selected node highlight |
| `.plan-node--done` | Done node styling |
| `.plan-arrow` | SVG `<path>` for dependency arrows |
| `.plan-editor` | Bottom editor panel |
| `.group-plans-btn` | 🗺️ button on group headers |
| `.plan-badge` | Plan badge on session cards |
| `.plan-badge--doing` | Legacy green class for coding badge |
| `.plan-badge--startable` | Legacy blue class for ready badge |
| `.plan-chip` | Plan chip in draft strip |
| `.plan-chip--doing` | Legacy green class for coding chip |
| `.plan-chip--startable` | Legacy blue class for ready chip |

## Persistence

Plans persist to individual JSON files under `config/plans/` (one file per plan item) with a global dependency registry at `config/plan-dependencies.json`. PlanManager self-saves on every mutation. On startup, `PlanManager` loads all files from disk in its constructor. See [plans-file-structure.md](plans-file-structure.md) for the full schema and file layout.

Plans are folder-level data (not per-profile) — switching profiles does not affect plans.

## Tests

| Test file | Count | Coverage |
|-----------|-------|----------|
| `plan-manager.test.ts` | 42 | PlanManager CRUD, DAG validation, cycle prevention, ready-state computation |
| `plan-handlers.test.ts` | 23 | IPC handler wiring, auto-save, channel responses |
| `plan-layout.test.ts` | 17 | Topological sort, layer assignment, barycenter ordering, coordinate assignment |
| `plan-screen.test.ts` | 33 | Canvas rendering, pan/zoom, node selection, add/delete, editor integration |
| `plan-chips.test.ts` | 11 | Badge rendering, chip rendering, click handlers |
| `plan-navigation.test.ts` | 4 | Navigation integration (B button exits, plan screen priority) |
