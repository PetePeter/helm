# Session List previews and message flights

Each Session List row shows a live tail of its session's terminal, and the list
animates messages sent from one session to another. The preview tail is passive:
it does not change the active terminal or receive input.

Sessions marked hidden stay alive and keep their state across restarts, but are
left out of the Session List and its navigation. The active session remains in
the list while selected. Use **Show hidden (N)** in the list toolbar to reveal
other hidden sessions; the control appears only when there are rows to reveal.
Each row's actions menu can hide or restore that session.

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

## Unread Chat count

Local session rows show an outlined `N new` chip after the session name when
that session has unread Chat messages. It counts incoming journal messages;
user-originated turns and typed system records are excluded. The count comes
from `useChatStore` and clears when that session's thread is visible in the
active Chat pane. Peer rows do not show the local Chat count.

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

On desktop a row shows context only as its status ring; hovering the ring opens the chart of the whole stored history, with the window limit and guides at the amber and red limits. The row stays uncluttered: no inline graph or `ctx`/% text. Android rows carry a small graph over the last 2 hours (`ROW_SPAN_MS`), the same span on every row so rows are comparable.

```mermaid
graph LR
  SL[statusline / transcript / API] --> T[SessionContextUsageTracker]
  T -->|contextUsage + contextHistory| SI[SessionInfo]
  SI -->|serializeSession| Y[sessions.yaml]
  SI -->|session:updated| R[SessionCard → ContextRing]
```

- **Why the tracker owns the history:** every snapshot already passes through `SessionContextUsageTracker.storeUsage`, so each reading lands in `contextHistory` without a second producer. The history is capped at `CONTEXT_HISTORY_LIMIT` (120) points, and a reading equal to the last one is skipped, so idle refreshes do not flatten the trend.
- **Why it is persisted:** a restored session keeps its trend, including any `/compact` drops, which appear as ordinary points.
- **Subscription quota (5h / weekly):** `SessionQuotaUsageTracker` holds one runtime-only snapshot per account scope (`quotaScope`: profile + provider + `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and shows it on the ring's hover card. Claude reports it on the statusline; Codex has no statusline, so `readCodexTranscriptQuota` reads `rate_limits` from the latest `token_count` in its rollout JSONL on each transcript refresh. Windows are matched by length (300 / 10080 min), not slot, and stamped with the log line's time, so an idle Codex drops its bars after 15 min like Claude.

```mermaid
graph LR
  CS[Claude statusline] --> Q[SessionQuotaUsageTracker]
  CT[Codex rollout token_count] --> Q
  Q -->|quotaUsage, same scope| SI[SessionInfo]
```

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
  M & A --> D[SessionCard ring]
  M & A --> G[session_get: limits + level]
  M & A --> P[chat reply: contextAmber / contextRed]
```

- **Auto by default:** amber above 75%, red above 90% of the window.
- **Manual:** Settings → CLI tools → *Manual context warnings* stores `contextLimits: { amber, red }` in tokens. Absolute counts suit long-window models where 75% is far past where quality drops. The same screen edits `contextWindow`, the fallback window for CLIs that report none.
- **Why the row resolves limits itself:** `SessionCard` already looks up its CLI type for the cache fade, so a settings change recolours rows at once, with no new field on the persisted snapshot.
- **Hover card:** it is fixed-position and teleported to `body`, so the sidebar's scroll container cannot clip it.

## User notes (📝)

The 📝 button beside 🔗 on a desktop row asks for a short note. On OK the note joins that row's notification carousel as its newest entry, so a note and any `notify_user` messages share one stack. It is stored with them (`llmNotifications` in localStorage) and survives a restart. Desktop only.

While the carousel holds a note, the carousel and the row are a solid, steady `--info` blue. They do not pulse: a note is a reminder you left yourself, not a request for attention like [flash_attention](flash-attention.md). Dismissing the note deletes it, and the blue clears once no notes remain.

```mermaid
graph LR
  B[📝 → form modal] -->|OK| S[llmNotifications store<br/>kind: note, prepended]
  S --> C[NotificationCarousel<br/>jumps to the note, blue]
  S --> R[SessionCard .user-noted]
  C -->|Dismiss| X[note deleted]
```

The session ETA sits on the name line, in the slot the inline context graph used to fill.
