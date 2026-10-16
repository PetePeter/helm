# Session List previews and message flights

Each Session List row shows a live tail of its session's terminal, and the list
animates every message one session sends another. Both used to live in Team
View, a second roster pane that duplicated the Session List. Team View was
retired (P-0804) and these two parts moved into the list.

```mermaid
graph LR
  MP[Main: HelmSessionDeliveryService<br/>holds the PTY write] -->|onSessionMessageFlight| SL[SessionList.vue<br/>useMessageFlights]
  SL -->|row / collapsed group header / none| ANIM[Envelope animation]
  ANIM -->|animationend, or no target| ACK[ackSessionMessageFlight]
  ACK --> MP
  OB[PtyOutputBuffer.getLastLines] --> PV[useSessionPreviews] --> SC[SessionCard preview]
```

## PTY preview

- **Source:** the renderer's existing `PtyOutputBuffer`, which is already
  ANSI-stripped. The preview never copies PTY data into a store, takes focus,
  or writes a terminal. Clicking the row selects the session as before.
- **Lines:** the last 5 *non-blank* lines. TUIs pad their output with empty
  rows, so the raw last 5 lines are often blank.
- **Throttle:** buffer updates bump one version counter at most every 250 ms, so
  a burst of `pty:data` re-renders once rather than per chunk.
- **Late manager:** dock panes mount before `useAppBootstrap` builds the
  `TerminalManager`, so the composable subscribes to `onTerminalManagerChanged`
  instead of reading the buffer once at setup.
- **Setting:** Settings → Tools → *Output preview*: `on` (default),
  `selected-only` (one preview, for gamepad density) or `off` (compact rows).
  Persisted as `sessionPreviewMode` with the session-group prefs.

## Scheduled-task indicator

Local session rows show a clock when a pending direct-mode task targets that session.
If several tasks target one session, the tooltip shows the one with the nearest next
run. Spawn-mode tasks, disabled tasks, and tasks with `scheduleKind: none` are hidden.

`SessionList` loads task data through the scheduler preload API and refreshes from
the existing `onScheduledTaskChanged` event, which covers creation, edits, runs,
cancellation, completion, and deletion. Peer session lists do not load local tasks.

## Message flights

The delivery service broadcasts a flight **before** it pastes an inter-session
message, and holds the paste until the renderer acks it. Landing the envelope
is what releases the message.

| Case | Behaviour |
|------|-----------|
| Recipient row rendered | Envelope flies there; ack on `animationend`; the row flashes accent for 0.6 s |
| Recipient inside a collapsed group | Lands on that group's header |
| Recipient not rendered (closed, filtered) | Acked at once, with no animation |
| Sender has no row (phone proxy, peer) | Flies in from the list's top-right corner |
| Session List unmounted mid-flight | Every pending flight is acked on unmount |
| No Session List mounted at all | Main-process timeout (`HELM_MESSAGE_FLIGHT_TIMEOUT_MS`, default 1.6 s) releases it |

A paste is never held hostage to a missing target. Anchors are matched by
comparing `dataset` values, not by building an attribute selector, because
session ids and paths contain characters that would need CSS escaping.
Envelope colours come from `MESSAGE_FLIGHT_COLORS` in `renderer/state-colors.ts`:
blue for a first send, amber for a reply within the reply window.

## Context fill graph

The `ctx` label on each row carries a small graph of the session's context size over the last 2 hours (`ROW_GRAPH_SPAN_MS`). Every row uses the same span, so rows are comparable, and an idle session draws a flat line at its last level. Hovering the label opens a larger chart of the whole stored history, with the window limit and guides at the amber and red limits.

```mermaid
graph LR
  SL[statusline / transcript / API] --> T[SessionContextUsageTracker]
  T -->|contextUsage + contextHistory| SI[SessionInfo]
  SI -->|serializeSession| Y[sessions.yaml]
  SI -->|session:updated| R[SessionCard → ContextSparkline]
```

- **Why the tracker owns the history:** every snapshot already passes through `SessionContextUsageTracker.storeUsage`, so each reading lands in `contextHistory` without a second producer. The history is capped at `CONTEXT_HISTORY_LIMIT` (120) points, and a reading equal to the last one is skipped, so idle refreshes do not flatten the trend.
- **Why it is persisted:** a restored session keeps its trend, including any `/compact` drops, which appear as ordinary points.
- **Colour:** the graph is `--accent`, turning `--status-blocked` (amber) above the amber limit and `--danger` above the red limit. With no known window it scales to the peak; with no limits it stays green.

### Warning limits — per CLI type

One rule, `src/session/context-limits.ts`, serves the desktop row, `session_get` and the phone:

```mermaid
graph LR
  Y[cli-types.yaml<br/>contextLimits?] --> R{manual limits set<br/>and red &gt; amber?}
  W[context window<br/>CLI-reported or contextWindow] --> R
  R -->|yes| M[amber / red tokens as set]
  R -->|no, window known| A[75% / 90% of window]
  R -->|no window| N[no limits: stays green]
  M & A --> D[SessionCard sparkline]
  M & A --> G[session_get: limits + level]
  M & A --> P[chat reply: contextAmber / contextRed]
```

- **Auto by default:** amber above 75%, red above 90% of the window.
- **Manual:** Settings → CLI tools → *Manual context warnings* stores `contextLimits: { amber, red }` in tokens. Absolute counts suit long-window models where 75% is far past where quality drops. The same screen edits `contextWindow`, the fallback window for CLIs that report none.
- **Why the row resolves limits itself:** `SessionCard` already looks up its CLI type for the cache fade, so a settings change recolours rows at once, with no new field on the persisted snapshot.
- **Hover card:** it is fixed-position and teleported to `body`, so the sidebar's scroll container cannot clip it.
