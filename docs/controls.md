# Controls

Gamepad button and keyboard shortcut mappings.

## Gamepad

| Input | Action |
|-------|--------|
| D-Pad Up/Down | Switch sessions (auto-selects terminal) / auto-opens overview on group headers |
| D-Pad Right | Session card: cycle sub-elements / Group header: open group overview (col 0) — 🗺️ Plans button (col 1) is click-only |
| D-Pad Left | Back one sub-element column |
| D-Pad directions | Overview grid: navigation between cards (Up/Down past edges exits overview) |
| Left Stick | Same as D-pad |
| Right Stick | Configurable (default: scroll terminal buffer / overview grid) |
| A | Configurable per-CLI binding / overview: select session + exit |
| B | Back to sessions zone / configurable per-CLI binding |
| X | Configurable per-CLI binding / overview: close focused session |
| Y | (planned: cycle terminal state) |
| Left Trigger | Spawn Claude Code |
| Right Bumper | Spawn Copilot CLI |
| Back/Start | Switch profile (previous/next) |
| Sandwich/Guide | Focus hub window + show sessions screen |
| Any button bound to `voice-talk` | Hold to talk to Helm (the operator); release sends. The release is honoured from any pane |

### Session card columns

D-pad Right walks a focused session card's buttons; **A** activates the one you
are on.

| Column | Button | A does |
|--------|--------|--------|
| 0 | the card itself | falls through to the configured binding |
| 1 | state | open the state dropdown |
| 2 | ✎ | start rename |
| 3 | 👁 | toggle overview visibility |
| 4 | ✕ | close (confirmation) |
| 5 | 🔓 / 🔒 | lock or unlock against closure |

The padlock sits to the LEFT of ✕ on screen — beside the button it guards — but
holds the highest column index deliberately, so columns 1-4 keep the numbering
they have always had.

A locked session shows 🔒 and its ✕ is disabled; closing is refused in the main
process too, so MCP, Telegram, group close, and force restart all bounce off it.
The same flag the `session_set_locked` MCP tool writes.

## Keyboard

| Input | Action |
|-------|--------|
| Ctrl+Tab | Next terminal tab |
| Ctrl+Shift+Tab | Previous terminal tab |
| Ctrl+Shift+T | Focus the Terminal pane |
| Ctrl+Shift+M | Focus the Memories pane |
| Ctrl+Shift+P | Open/focus the Plans pane for the active session folder |
| Ctrl+Shift+S | Focus the Sessions pane |
| Ctrl+Shift+A | Show/focus the Artifacts pane; never toggles it |
| Ctrl+Shift+N | Terminal: open quick spawn / Sessions: create a new plan for the current directory |
| Ctrl+Shift+W | Close the active session; needs a terminal **visible**, not focused |
| Ctrl+Tab / Ctrl+Shift+Tab | Cycle the selected session forward/back. Moves the session spine only — the focused pane stays put and re-points at the new session |
| Arrow keys | Navigate the focused pane (mapped to D-pad equivalents). xterm owns arrows when the keystroke lands in it |
| Enter | Mapped to A button |
| Escape | Focused terminal: ESC protection (see below), else ESC to the PTY. Any other pane: the pane's own business (mapped to B button) |
| Delete | Mapped to X button |
| F5 | Mapped to Y button |
| Ctrl+V | Focused terminal: managed paste to PTY stdin (bracketed-paste framing, chunking). Focused Artifacts pane: creates a new artifact from the clipboard |
| Ctrl+G | Open in-app Prompt Editor (`EditorPopup.vue`) — multi-line textarea + recent-prompts list + prompt-template tree pane; Ctrl+Enter / Send delivers to active terminal via `deliverPromptSequence()`. Works from any pane while a terminal is **visible**; a no-op when none is |
| Ctrl+1-9, Ctrl+0 | Jump directly to the Nth session in sidebar order (badge: `^n`) |
| Alt+1-9 | Fire the Nth chip bar quick-action for the active session (badge: `⌥n`) |
| Ctrl+Shift+Space | Talk to Helm: press to start, press again to send (a toggle — the router is keydown-only and key repeat makes a keyboard hold unreliable). Global scope, so a modal blocks it like the other workspace keys |
| Tab / Shift+Tab (selection-mode modal) | Cycle buttons in close-confirm, context-menu, prompt-tree picker, or quick-spawn |

## Keyboard Ownership

Keyboard input is routed by a single capture-phase listener with an explicitly
declared precedence chain — `modal` > `global` > `pane` > `terminal`. Each screen
registers its own handlers and decides whether it is eligible, asking whether it
is **focused** (keys that send input) or **visible** (keys that render over a
pane). See [docs/keyboard-routing.md](keyboard-routing.md).

## ESC Protection

For CLI types with the setting armed, Escape in a focused terminal does **not**
go straight to the PTY — an accidental interrupt is expensive mid-run. The first
Escape raises a confirmation dialog instead; the interrupt is sent only if you
confirm.

| Input | Action |
|-------|--------|
| Escape (first press) | Raise the protection dialog. Nothing reaches the PTY |
| Escape / B (dialog open) | Confirm — ESC goes through to the PTY, dialog closes |
| Any other key (dialog open) | Dismiss. The interrupt is **not** sent |

Both routes converge on one handler, so the keyboard Escape and the gamepad B
button behave identically. The dialog owns its own confirmation: once it is up
it holds modal scope, which by design gates the terminal handlers out entirely
(see [keyboard-routing.md](keyboard-routing.md#modal-ownership-is-two-part)).

## Navigation Priority Chain

When a button is pressed, the navigation system checks handlers in this order:

1. Sandwich button (always → sessions screen)
2. Directory picker modal
3. Binding editor modal
4. Form modal (A/B only)
5. Close confirmation modal (Arrow keys + Tab/Shift+Tab for button cycling)
6. Quick-spawn picker
7. Draft editor panel (D-pad/A/B field navigation)
8. Draft action picker (per-draft Apply/Edit/Delete — accessed via context menu Drafts ► submenu)
9. Draft submenu (Drafts list from context menu)
10. Context menu (Arrow keys + Tab/Shift+Tab for button cycling)
11. Prompt-template picker tree (`PromptTreeModal`)
12. Screen-specific routing (sessions / settings)
    - **Sessions case:** Plan screen overlay (when visible, B exits) → Group overview → Session/spawn navigation
13. Config binding fallback (per-CLI bindings)

The first handler that returns `true` (consumed) stops the chain.

## Draft Prompts

The `new-draft` action type can be bound to any gamepad button to open the draft editor for the active session. Drafts can also be accessed via the **Drafts ►** submenu in the context menu, which provides New Draft, and per-draft Apply (send to PTY) / Edit / Delete actions.

### Draft Editor Gamepad Navigation

When the draft editor panel is visible, all gamepad input is captured (like a modal):

| Input | Action |
|-------|--------|
| D-Pad Up/Down | Cycle focus: Title → Content → Save → Apply → Delete → Cancel (wraps) |
| A | Activate focused element (click Save/Apply/Delete/Cancel buttons) |
| B | Cancel and close the editor |

Keyboard input flows through to the focused field normally — only gamepad navigation is intercepted.

## Directory Plans

The 🗺️ Plans button on group headers (column 1, click only — D-pad Right at col 0 opens the group overview instead) opens the plan canvas for that directory. The plan screen is an overlay inside `#mainArea`, not a separate screen — it's checked via `isPlanScreenVisible()` within the sessions case of the navigation router.

### Plan Screen Controls

| Input | Action |
|-------|--------|
| Click on node | Select node → open bottom editor panel |
| Click on arrow | Remove that dependency edge |
| Click + drag canvas | Pan (viewBox-based) |
| Mouse wheel | Zoom in/out |
| Ctrl+N | Add new node |
| Escape | Close plan screen (when editor is not open) |
| ← Back button | Exit plan screen |
| D-Pad Left/Right | Move between layers (closest-Y selection) |
| D-Pad Up/Down | Move within a layer |
| A (gamepad) | Open editor for selected node |
| X (gamepad) | Delete selected node |
| Y (gamepad) | Add new node |
| B (gamepad) | Exit plan screen |

Keyboard and clipboard paste are blocked while the plan screen is visible (`.plan-screen.visible` guard in paste-handler).

### Plan And Draft Editor Shortcuts

| Input | Action |
|-------|--------|
| Ctrl+S | Save and close the current draft/plan editor |
| Ctrl+Enter | Save and close the current draft/plan editor |
| Ctrl+N | Save current draft/plan item and create a new one |
| Escape | Cancel using the same close path as the visible Cancel action |

### Prompt Editor Modal

| Input | Action |
|-------|--------|
| Ctrl+Enter | Send the current textarea content to the active session |
| Escape | Close the prompt editor modal |
