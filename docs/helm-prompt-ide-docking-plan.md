# Helm Prompt-IDE Docking Workspace Plan

## Goal

Make Helm behave like an IDE for prompting: Terminal and PlanScreen are independent views that can be docked, split, tabbed, resized, and restored anywhere in the workspace. Scheduler, Quick Spawn, the session sidebar, planner-directory navigation, and Artifacts are independent tool windows with the same docking shell.

## Recommended model

Use a Vue-native, serializable recursive layout tree. Do not add Dockview or Golden Layout; those libraries would own DOM placement and risk fighting xterm.js, the existing terminal manager, and gamepad routing.

```text
Workspace
├─ Left dock
│  ├─ Sessions
│  └─ Tool group: Scheduler | Quick Spawn | Planner directories
├─ View workspace
│  └─ Terminal | PlanScreen
└─ Right dock
   └─ Artifacts
```

The default layout should reproduce the current UI closely. The important change is that each item is an independent pane, even when initially grouped.

## Layout data

```ts
type DockNode =
  | { type: 'split'; direction: 'horizontal' | 'vertical'; sizes: number[]; children: DockNode[] }
  | { type: 'group'; tabs: PaneId[]; activeTab: PaneId }
  | { type: 'dock'; side: 'left' | 'right' | 'top' | 'bottom'; mode: 'pinned' | 'autohide' | 'hidden'; child: DockNode }
  | { type: 'empty' };
```

Pane descriptors are id-keyed registrations. Views and tool windows have different defaults, but every pane can be moved, split, or closed and later restored:

- Views: session terminals and PlanScreen. They default to the view workspace, but can be docked to any side, split horizontally or vertically, or tabbed with another view.
- Tool windows: session list, Scheduler, Quick Spawn, planner-directory navigation, and Artifacts. They default to edge docks and support auto-hide, but can also be dragged into a view group.

The existing PlanScreen is a dockable view. The existing PlansGrid is only the planner-directory navigation tool; selecting a directory opens or activates its PlanScreen view.

## Vue seams

Add one recursive renderer and one state store/composable:

- `DockWorkspace.vue`
- `DockNode.vue`
- `DockPane.vue`
- `DockTabGroup.vue`
- `DockPreview.vue`
- `useDockWorkspace.ts`
- pure layout operations in `dock-layout.ts`

Pure operations should cover move, split, tab, close, collapse, restore, reset, and empty-node normalization. Persist a versioned layout in the per-user app-data configuration, not localStorage. Keep localStorage only for small transient UI values if still needed.

Reuse and generalize `usePanelResize` for split-node sibling sizes. Keep `main-view-manager.ts`, `SnapOutWindow.vue`, and `focus-slot.ts` as existing seams rather than replacing them.

## Interaction behavior

- Drag from a pane tab; a single-tab group also permits dragging its title bar.
- Require a small movement threshold so clicks still select tabs.
- Show five drop zones: center to tab, top/right/bottom/left to split.
- Show a translucent preview rectangle for the resulting layout.
- Dragging outside the main window uses the existing OS-window pop-out path where supported.
- Tabs can reorder within a group, move to another group, or split into a new group.
- Collapse/autohide leaves a labelled edge rail. Click or hover reveals the pane; focus loss collapses it.
- Use the existing Artifact edge-tab visual language for all collapsed panes.
- Provide a View menu listing every registered pane plus Reset Layout, so every pane can be recovered after a bad layout. An all-closed workspace uses the canonical empty root.
- Add accessible `role=tablist`, `role=tab`, `role=tabpanel`, labels, keyboard movement, and a visible active-pane focus ring.

## Focus and terminal safety

The current fixed `focusColumn` model cannot survive arbitrary docking. Replace it with:

- `focusedPaneId`
- pane-local `focusedItemId`
- deterministic pane-cycle order from a left-to-right, top-to-bottom tree walk

Gamepad D-pad navigation remains local to the focused pane. A modifier cycles panes. Auto-hidden panes are skipped.

Docking must never change the PTY input target. The active session remains the explicit keyboard/PTY target; moving a pane only changes layout.

Before implementing drag-and-drop, prove that moving a terminal pane adopts the existing xterm DOM node rather than remounting it. Remounting would lose scrollback, cause flicker, and break the current terminal manager assumptions. Call `fit()` after adoption and after every split resize.

## Delivery phases

### Phase 1: structural workspace

1. Add the layout store, schema validation, default layout, persistence, and Reset Layout.
2. Extract Terminal, PlanScreen, Scheduler, Quick Spawn, planner-directory navigation, session sidebar, and Artifacts into registered panes.
3. Add dock-side toggles and the View menu.
4. Generalize split resizing.
5. Replace fixed focus columns with identity-based pane focus.

### Phase 2: standard docking

1. Add pointer drag threshold, drag ghost, five-zone preview, tab reorder, tab moves, and split drops.
2. Add collapse/autohide rails and focus-loss restore behavior.
3. Add manual acceptance coverage for terminal reparenting, resize/refit, gamepad focus, and persistence across restart.

### Defer

- Named workspace presets.
- Multi-monitor layout memory.
- Touch drag.
- Dragging between separate Helm windows.
- New floating-window machinery; reuse the existing OS pop-out path first.

## Verification gates

- Pure layout-tree tests for every move/split/tab/close/normalize operation.
- Component tests for dock previews, tabs, collapse rails, accessibility, and persistence migration.
- Terminal adoption test proving the xterm element and scrollback survive a move.
- Gamepad tests proving pane cycling is deterministic and PTY targeting is unchanged.
- Manual app gate: move each pane, split panes horizontally and vertically, tab panes, collapse/reopen, restart, reset layout, and verify terminal scrollback and session focus.
- Run the normal build and focused Vitest suite.
- Record the final repository state, focused tests, build, and manual Electron evidence after code changes.

## Opinionated boundary

Do not implement the flashy drag system first. The structural workspace, independent panes, persistence, identity focus, and View-menu recovery deliver most of the IDE experience and expose the terminal-reparenting risk early. Add drag previews only after those foundations are stable.

No production code has been changed as part of this plan.
