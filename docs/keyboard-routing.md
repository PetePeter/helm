# Keyboard Routing

One capture-phase `keydown` listener owns global keyboard input. Screens register
handlers, declare a scope, and answer two questions: *am I eligible?* and *did I
eat it?* The router resolves the context once, walks the chain in declared
precedence order, and is the only code that suppresses an event.

## Why

Keyboard input used to be nine independent capture-phase listeners on
`window`/`document`. Their relative priority was an accident of module import
order, and each one re-derived its own eligibility from ad-hoc DOM probes. Two
consequences were user-visible bugs:

- **Handlers suppressed events they then declined to handle.** Escape was
  `preventDefault`ed at the top of the keyboard relay and dropped by a later
  guard, so it reached neither the PTY nor xterm.
- **The probes drifted out of sync with the dock.**
  `querySelector('.plan-screen.visible')` matches a pane that is merely
  *mounted* — dock panes use `v-show`, so inactive tabs stay in the DOM. Once the
  planner became a dock pane, that check was permanently true, which killed
  Ctrl+Tab and the managed Ctrl+V.

Four separate copies of "is this an editable field?" had also drifted apart. The
copy in the shell checked `closest('input, textarea')` *before* asking whether
the target was a terminal — and xterm.js focuses a hidden
`<textarea class="xterm-helper-textarea">`, so every Ctrl+Shift+&lt;pane&gt;
shortcut died the moment you were typing in a terminal.

## Flow

```mermaid
graph TB
    KD["keydown — ONE window capture listener"] --> CTX["resolve KeyContext once<br/>combo · scope · activeSessionId<br/>isFocused(pane) · isVisible(pane)"]
    CTX --> L1["1. modal"]
    L1 -->|unclaimed| L2["2. global<br/>dock panes · Ctrl+Tab · Ctrl+N<br/>Ctrl+1-9 · Alt+1-9 · Ctrl+G"]
    L2 -->|unclaimed| L3["3. pane<br/>plan · sessions · navigation<br/>terminal Esc / Ctrl+V"]
    L3 -->|unclaimed| L4["4. terminal<br/>key relay → PTY"]
    L4 -->|unclaimed| FT["fall through — xterm / native"]
    L1 -.->|"ate it"| PD["router alone calls<br/>preventDefault + stopPropagation"]
    L2 -.->|ate it| PD
    L3 -.->|ate it| PD
    L4 -.->|ate it| PD
```

An **editable field** short-circuits the chain after `modal`: ordinary handlers
are skipped unless they opt in with `allowInEditable`. Workspace navigation,
session actions, and voice toggle opt in so their app commands remain available
while typing. A **terminal is never an editable field**, however much its helper
textarea resembles one.

## The contract

```ts
interface KeyHandler {
  id: string;
  scope: 'modal' | 'global' | 'pane' | 'terminal';
  allowInEditable?: boolean;          // fire even while typing in a field
  claims?: (ctx: KeyContext) => boolean;   // am I eligible?
  handle: (ctx: KeyContext) => boolean;    // did I eat it?
}
```

Handlers **never** call `preventDefault` or `stopPropagation`. Returning `false`
leaves the event pristine so xterm.js and native controls still see it. That
inversion is what makes "swallowed but not handled" impossible.

Precedence is declared data in `router.ts` (`SCOPE_PRECEDENCE`), never import
order. Within one scope, registration order applies.

## Modal ownership is two-part

A handler's `scope: 'modal'` and the router's `ctx.scope === 'modal'` are
**different facts**, and a modal needs both. The handler's scope says *where I
sit in the chain*; the context's scope says *a modal currently owns the
keyboard*, and it is derived from the modal stack, not from the registry. A
dialog that registers a modal-scope handler but never joins the stack has done
half the job.

Both halves have bitten, in opposite directions:

```mermaid
graph TB
    Q{"Joined the<br/>modal stack?"}
    Q -->|no| N["ctx.scope stays 'pane'<br/>declined keys fall through<br/>→ typing reaches the PTY"]
    Q -->|yes| Y["ctx.scope = 'modal'<br/>global · pane · terminal all gated out<br/>→ only this dialog can act"]
```

- **Forgetting to join the stack leaks keys.** A modal that registers a
  modal-scope handler but joins no registry leaves `isKeyboardModalOpen()` false,
  so the router stays in pane scope. If its handler ends in
  `default: return false`, every key it declines carries on to the workspace and
  terminal handlers — typing behind the open dialog reaches the CLI.
- **Joining the stack makes the dialog the only actor.** The ESC-protection
  dialog *did* hold modal scope, which correctly gated out the terminal
  handlers — including the confirm branch that lived there. The second Escape
  reached nothing and gamepad B was dead for the same reason.

Two rules follow:

1. **Push a `useModalStack` entry on open, pop it on close.** Then swallow
   unrecognised keys (`default: return true`) — once you own the keyboard,
   declining is not "pass it on", it is "leak it".
2. **A modal owns its own confirmation.** Never leave the confirming branch in a
   lower-scope handler, because your own modal scope is what makes it
   unreachable. Store the callback with the state that opened the dialog.

`interceptKeys` on the stack entry stays **empty** when a modal-scope handler is
already registered; handing the bridge keys to swallow would double-handle them.

## Focused vs. visible

`KeyContext` exposes both, and each screen picks the one that matches what its
key actually does:

| Question | Use | Because |
|----------|-----|---------|
| Is an action explicitly limited to a pane currently on screen? | `isVisible(pane)` | Use visibility only when showing that pane is part of the action's contract. |
| Does this key **send input** to a pane? | `isFocused(pane)` | Esc, Ctrl+V and the key relay write to a PTY. Typing into Memories must never reach a CLI. |

Session actions target the active session rather than a rendered pane. For
example, Ctrl+Shift+W opens the close confirmation for the active session even
when Terminal is hidden.

## Shortcut focus-context matrix

Global shortcuts use the router's resolved context, not a component-specific
input check. `allowInEditable` is the explicit exception for shortcuts that
remain useful while typing. A modal always takes ownership before globals run.

| Shortcut group | Terminal | Chat composer | Draft editor | Search fields | Modal fields | Artifact iframe | Mess / Memories / Plans | Snap-out |
|----------------|----------|---------------|--------------|---------------|--------------|-----------------|-------------------------|----------|
| `Ctrl+Shift+<pane>`, `Ctrl+G`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+digit`, `Alt+digit`, `Ctrl+Shift+N` | Yes | Yes | Yes | Yes | No | Yes, when the iframe is focused; matching handlers act | Yes | Pane-profile shortcuts, `Ctrl+G`, `Ctrl/Alt+digit`; no session cycle or spawn |
| `Ctrl+Shift+G` open Dreaming settings | Yes | Yes | Yes | Yes | No | Yes, when focused | Yes | Not registered |
| `Ctrl+Shift+W` close session | Yes, with an active session | Yes, with an active session | Yes, with an active session | Yes, with an active session | No | Yes, when focused and an active session exists | Yes, with an active session | Not registered |
| `Ctrl+Shift+R` rename, `Ctrl+Shift+B` clear notifications | Yes, with an active session | Yes, when the action is registered | Yes, when the action is registered | Yes, when the action is registered | No | Yes, when focused and an action is registered | Yes, with an active session | Not registered; the pop-out has no rename/notification callbacks |
| `Ctrl+Shift+Space` voice toggle | Yes | Yes | Yes | Yes | No | Yes, when focused and the voice handler is registered | Yes | Not registered |
| Pane-owned keys | Terminal keys go to the PTY | `Enter` adds a line; `Ctrl+Enter` sends | Draft/editor keys stay local | Search text stays local | Modal handler owns keys | Plain keys stay in the artifact | Focused pane handler owns keys | Same pane-local rules for available panes |

Global handlers opt in to editable fields when their action remains useful
while typing. Modal ownership still takes precedence, so a close confirmation
receives keys before workspace shortcuts. Terminal classification is special:
xterm's helper textarea is resolved as the terminal, not as an editable field,
so terminal and global handlers still run.

Artifact documents run in an opaque-origin iframe. Their injected bridge sends
keydowns with Ctrl, Alt, or Meta held; plain and Shift-only typing stays in the
document. Ctrl/Cmd+C, Ctrl/Cmd+A, and Ctrl/Cmd+F also stay in the document for
copy, select-all, and find. The parent accepts only a valid keydown message
from its own focused artifact frame, then dispatches it through the same
router. The registered handlers decide which shortcuts act, so there is no
second shortcut list to keep in sync; modal ownership and editable-field rules
still apply.

The snap-out window uses the `popout` dock profile: Terminal (`T`), Plans (`P`),
Memories (`M`), Mess (`E`), Artifacts (`A`) and Draft (`D`). Chat, Sessions,
Scheduler, Quick Spawn and Projects are absent there. The pinned session means
session cycling, close, rename, notification-clear and voice shortcuts are not
registered; Ctrl/Alt+digit still use the shared session-slot and chip-action
handlers.

## Ownership model

Sessions are the spine; terminal, memories, artifacts and plans are
aspects onto whichever session is selected.

```mermaid
graph LR
    S["Session (spine)"] --> T[Terminal]
    S --> M[Memories]
    S --> A[Artifacts]
    S --> P[Plans]
    CT["Ctrl+Tab"] -->|"moves the spine only"| S
```

Ctrl+Tab therefore always cycles sessions and leaves `focusedPaneId` untouched —
you keep looking at the same aspect of the next session.

## Files

| File | Responsibility |
|------|----------------|
| `renderer/keyboard/key-combo.ts` | `KeyboardEvent` → `ctrl+shift+o`. Meta folds into ctrl. Pure. |
| `renderer/keyboard/key-context.ts` | Resolves scope once per event via `input-ownership.ts` + dock state |
| `renderer/keyboard/router.ts` | Registry, declared precedence, the single listener, event suppression |
| `renderer/keyboard/install.ts` | Builds the `KeyEnvironment` for the dock window and single-pane pop-outs |
| `renderer/keyboard/handlers/workspace-keys.ts` | Dock pane shortcuts (Ctrl+Shift+&lt;letter&gt;, declared as `shortcut` on each `DockPaneDescriptor`), Ctrl+G `draft-jump`, Ctrl+Tab, spawn, close |
| `renderer/keyboard/handlers/number-keys.ts` | Ctrl+&lt;n&gt; session jump, Alt+&lt;n&gt; chip actions |
| `renderer/keyboard/handlers/terminal-keys.ts` | Esc, Ctrl+V, key relay → PTY |

Screens register their own keys next to their own code: `plans/plan-screen.ts`,
`modals/modal-base.ts`, `composables/useModalKeyboardBridge.ts`.

## Adding a binding

1. Pick the screen that owns the key. Register from that module, not centrally.
2. Pick a scope. `global` only if it must work from any pane.
3. Write `claims` against `isFocused` or `isVisible` — never a DOM probe, and
   never `activeView`/`currentScreen`.
4. Return `true` from `handle` only when you consumed the key.
5. Unregister on unmount (`registerKeyHandler` returns the cleanup).

## What replaced what

| Was | Now |
|-----|-----|
| `MainWindowApp.vue` dock shortcut listener | `workspace-keys` (global) |
| `MainWindowApp.vue` modal bridge listener | `modal-stack-bridge` (modal) |
| `useNumberAccelerator` listener ×2 per window | `number-keys` (global) |
| `useAppBootstrap.ts` Ctrl+Tab listener | `session-cycle` (global) |
| `paste-handler.ts` keyboard relay listener | `terminal-keys` (global + pane + terminal) |
| `sessions.ts` keyboard fallback listener | `workspace-keys` + `pane-navigation` |
| `plan-screen.ts` listener + `globalThis` de-dup hack | `plan-screen` (pane) |
| `modal-base.ts` per-modal listener | `modal:*` (modal) |

Also deleted: four duplicate editable-target checks, the stale
`.plan-screen.visible` probes, the inline `.modal-overlay.modal--visible`
eligibility probes, and the `rename-session-request` /
`clear-session-notifications` window CustomEvents (the relay can now reach the
shell through injected collaborators).

## Related

- [docs/controls.md](controls.md) — the actual key map
- [docs/terminal-architecture.md](terminal-architecture.md) — PTY input routing
- [docs/docking.md](docking.md) — panes, focus and visibility
