# Helm plan index: Prompt-IDE Docking Workspace

Created 2026-08-27 for the Visual Studio-like prompt-IDE docking E2E.

## Sequence

- Title: Prompt-IDE Docking Workspace
- Sequence ID: `6d644c59-0cf1-4c51-8c63-3aa072726737`
- Project: `X:\\coding\\gamepad-cli-hub`
- Context: `d2d2f093-6e88-4c32-bb17-9eba9300b5b3` (bound to the sequence)

All plans are `autoImplement=false`. No production code was changed while creating this plan graph.

## Plans

1. `P-0693` — Dock workspace contract and layout-tree model
   - ID: `9dc2c16c-707b-48eb-8b97-919300f6e953`
   - State: ready
   - Defines the serializable recursive dock tree, pane registry, pure layout operations, defaults, and invariants.

2. `P-0694` — Extract views and tool windows into registered panes
   - ID: `7da24e3d-6288-4c2a-9ef4-5fe922d55497`
   - State: planning
   - Registers Terminal, PlanScreen, session list, Scheduler, Quick Spawn, planner-directory, and Artifacts.

3. `P-0695` — Persisted workspace layout, View recovery, and reset
   - ID: `59edaea7-4042-4868-876c-fdfd57801b66`
   - State: planning
   - Adds versioned app-data persistence, validation/fallback, View-menu recovery, and reset-to-default.

4. `P-0696` — Identity-based pane focus and safe terminal adoption
   - ID: `f435c7a1-93da-43fc-b309-50fc0609d557`
   - State: planning
   - Removes fixed-column assumptions, preserves deterministic gamepad focus, and moves xterm DOM nodes without remounting or changing PTY ownership.

5. `P-0697` — Recursive dock renderer, tab groups, splitters, and collapse rails
   - ID: `1260e49d-b66e-43f8-bf10-00189d62be02`
   - State: planning
   - Renders the tree with tabs, horizontal/vertical splitters, resize handles, collapse/autohide rails, and accessibility behavior.

6. `P-0698` — Standard drag-and-drop docking and split previews
   - ID: `b21c96c0-5249-4ced-bf23-9cf71a4648b6`
   - State: planning
   - Implements pointer-threshold drag, ghost preview, center-tab/four-edge split zones, outer-edge docking, and tab reorder.

7. `P-0699` — End-to-end docking acceptance, regression gates, and graph update
   - ID: `428d01cf-0d62-4f4f-aa55-9428e6f0ed3a`
   - State: planning
   - Runs build, focused tests, manual Electron E2E, restart/reset persistence checks, terminal continuity, and gamepad focus checks after code changes.

## Dependency graph

```text
P-0693 foundation
├── P-0694 pane extraction ──┐
├── P-0695 persistence ──────┼── P-0697 recursive renderer ── P-0698 drag/drop
└── P-0696 focus/terminal ────┘                                  │
                                                                 └── P-0699 E2E
```

The final E2E plan also depends directly on P-0693, P-0694, P-0695, P-0696, and P-0697. This keeps the acceptance gate blocked until every architectural layer is complete.

## E2E definition of done

- Every listed view/tool window can be opened independently from View and recovered after collapse.
- Any pane can be tabbed with another pane or split horizontally/vertically at any nesting level.
- Dragging shows standard docking targets and commits the selected tab/split operation.
- Resize and collapse/autohide work without losing view state.
- Layout survives restart, invalid persisted data falls back safely, and Reset Layout restores the default.
- Terminal scrollback, DOM ownership, PTY routing, and session identity survive docking moves.
- Gamepad focus follows pane identity rather than a stale column index.
- Build, focused tests, and manual Electron checks are recorded before completion.
