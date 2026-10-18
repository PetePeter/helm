# Session ETA

The session's LLM can set an expected finish time for its current multi-step
request. Helm does not estimate or change the ETA automatically.

## MCP tools

`session_eta_set` acts only on the authenticated caller's own session. Supply
exactly one of:

```text
session_eta_set(minutes=25, note="review tests")
session_eta_set(at=1792288800000, note="finish handoff")
```

`minutes` is a positive number from now. `at` is an absolute epoch-millisecond
timestamp in the machine's clock; a past time is accepted and appears overdue.
The optional note is trimmed. Setting a new ETA replaces the previous one.

`session_eta_clear()` removes the estimate. Both changes persist with the
session and are returned as `your_eta` by `session_info` and as `eta` by
`session_get`, `session_list`, and session-list deltas. The record contains
`at`, `setAt`, and an optional `note`.

## Desktop row

The desktop session row shows `🏁 HH:MM` in local time. Its tooltip includes the
ETA, time remaining, set time, and optional note. After the ETA passes, the row
shows `🏁 late Nm` in warning amber. It uses the existing elapsed-timer tick.

The hook places one `[HELM_ETA]` reminder beside `[HELM_TODOS]`, asking the LLM
to set and update its estimate when it takes on multi-step work. The phone has
no ETA display.
