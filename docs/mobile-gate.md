# MobileGate — proxy identity and capability allow-list

A paired phone is an authenticated remote-code-execution surface that lives in a
pocket. `MobileGate` is the boundary that stands **in front of** the MCP
dispatcher for every inbound phone call: deny by default, no impersonation, rate
limited.

It is deliberately the fleet's `InboundCallGate` pattern one prefix along, not a
second security model. See [fleet.md](fleet.md) for the original. Only two
things differ: the identity prefix (`mobile:` vs `peer:`) and the registry it
reads (`MobileDeviceStore` vs `PeerConfigManager`).

## The boundary, not the dispatcher

`callMcpTool`'s signature is untouched and nothing inside it knows a phone
exists. The gate wraps it. If a change to this feature requires editing
`src/mcp/tools/dispatcher.ts`, the boundary has been put in the wrong place.

```mermaid
graph LR
    P[Phone<br/>BLE peripheral] -->|SecureChannel frame| T[BLE call path<br/>P-0748]
    T -->|handle deviceId, method, params| G[MobileGate]
    G -->|dispatch under<br/>mobile:deviceId| D[callMcpTool<br/>UNCHANGED]
    G -.->|uniform<br/>Tool not permitted| P
```

There must be exactly one gate instance. It is built in `handlers.ts` and reached
via `getMobileGate()`; a mobile frame must never reach `callMcpTool` by any other
route.

## Decision order

Every inbound call runs the same ordered checks:

| # | Check | Denies when |
|---|-------|-------------|
| 1 | Device enabled | the record has `enabled === false` |
| 2 | Permitted-tool discovery | (answered in-gate, never dispatched) |
| 3 | Hard deny | tool is in `HARD_DENY_TOOLS`, or is structurally unreachable — even under a wildcard `*` |
| 4 | Session ownership | (mechanism kept, set currently empty — see below) |
| 5 | Allow-list | no `allow` glob matches the tool name |
| 6 | Rate limit | the device's token bucket is empty |
| 7 | Dispatch | — |

**Deny-by-default is the registry's own behaviour.**
`MobileDeviceStore.isToolAllowed` already refuses an unknown device, a disabled
one and one with an empty `allow` list. The gate reuses it rather than
reimplementing authorisation.

### Uniform denials

Steps 1 and 3–5 all throw the *byte-identical* message `Tool not permitted`. A
phone — or whoever picked up a lost one — must not be able to tell "this tool is
hard-denied" from "this tool is not on your list" from "no such tool", because
the difference is a map of the attack surface. Rate limiting is the one distinct
message, since it is a retry signal rather than an authorisation answer.

### Hard deny

`helm_restart` and `session_group_close` are never invocable from a phone,
whatever the allow-list says. The set is imported from the fleet gate — one list,
one rationale. `session_close` is deliberately *not* in it.

### Structurally unreachable tools

`MOBILE_UNREACHABLE_TOOL_PREFIXES` — `artifact_`, `memory_`, `mess_` — are denied
alongside the hard-deny set and filtered out of `__mobile_tools__`.

Every tool in those families resolves its subject from `authContext.sessionId`
alone and takes no session argument (see the `requireCallerSession` call sites in
`dispatcher.ts`). From the `mobile:` proxy they can only ever address the proxy's
**own** empty data — and that is worse than a denial: `artifact_list` does not
fail for a phone, it *succeeds* with an empty array, so a user looking at three
artifacts on the desktop concludes the phone lost them.

The rule this encodes: **the permitted surface means "this will do something", not
"this will not be refused".** A UI built from `__mobile_tools__` must never be
handed a row that looks live and silently does nothing.

This is not a change to the ownership boundary. `requireCallerSession` is
untouched.

The escape hatch, when a family needs to become reachable, is **address it by
argument, not by loosening the filter**: the `session_artifact_*` tools were
added alongside `artifact_*` and pass the filter by name construction because
their subject is a `sessionId` argument — a phone aims them at a real session
instead of addressing its own empty proxy data. The prefix list itself did not
move, so the silent-empty-success trap stays closed for everything that still
takes no session argument. Artifact ownership *within* the named session is
still enforced (a cross-session artifact id answers not-found, no existence
leak), and the gate's allow-list still applies per device as for any tool.

### Share-to-Helm

`session_share_file_add` / `session_share_file_commit` follow the same rule:
the subject is an explicit `sessionId` argument, checked to exist at open, so
the pair is reachable and allow-list gated like any `session_*` tool. Both are
**paired-phone only** — the dispatcher resolves the device from the
`mobile:<deviceId>` proxy identity and refuses any other caller — and the slot
is bound to that device for every slice and the commit. Denying the pair in a
device's allow-list makes the phone refuse the share up front ("Helm has not allowed this phone to share files"), read from `__mobile_tools__`.
See [mobile-app.md](mobile-app.md#share-to-helm--a-file-into-a-sessions-draft).

## Proxy identity

Calls dispatch under `mobile:<deviceId>` (`mobile-identity.ts`), where
`deviceId` is the **local `MobileDevice` record id** — never the BLE address
(Android rotates it) and never the phone's `machineId`. Real session ids are
UUID v4, and `mobile:` is not part of any UUID, so session-scoped tools
(artifacts, drafts — anything keying ownership on `authContext.sessionId`) can
only ever see the proxy's own data.

`senderSessionId` is **stripped** before dispatch. The fleet *wraps* it as a
routable `fleet:<peerId>:<id>` address because a peer has sessions of its own to
reply to; a phone does not, so there is nothing to preserve and stripping is the
stronger choice.

## Session ownership

`OWNERSHIP_GATED_TOOLS` is **deliberately empty**, and the machinery behind it is
deliberately kept.

A session spawned over the mobile proxy still records `createdByMobileDeviceId` on
its `SessionInfo`, derived from the proxy identity in
`HelmSessionService.spawnCli` and persisted through `serializeSession`
(invariant 6 — the allow-list is explicit). The check and the uniform denial
both still work; nothing is currently named in the set.

`session_close` used to be, mirroring the fleet rule. **Ruled otherwise:** a
SAS-paired phone is the user's own device, and closing a session from the kitchen
is the point of the app. The deciding argument was the app's, not the gate's —
ownership is invisible to `__mobile_tools__`, so the control sheet would have
shown a Close row that looked permitted and was refused every single time, which
is precisely the failure the unreachable-tool audit above exists to remove.
Closing is still governed by the allow-list: permissive about *which* session,
unchanged about *whether*.

## Permitted-tool discovery

`__mobile_tools__` is a reserved, non-dispatchable meta-method that returns the
intersection of the tool catalogue with the device's allow-list, minus the
hard-deny set and the structurally unreachable families. It is the mechanism behind the ratified "grey out forbidden
actions" rule in the app: the phone learns exactly what it may call and nothing
about what it may not. It is rate-limited like any other call, so it
cannot be probed for free, and a disabled device gets the uniform denial.

## Rate limit

One `TokenBucket` per device (the fleet's `PeerRateLimiter`, which is keyed on an
arbitrary string): 120 calls/minute with a burst of 120. The phone's own session
poll spends 30 calls/min of this shared bucket (one `session_list` every 2s while
the app is visible), so the limit must leave room for a user acting on top of
the poll. Still roomier than the fleet's 30 because a phone UI is interactive.

## Key modules

| File | Role |
|------|------|
| `src/mobile/mobile-gate.ts` | The gate: ordered checks, dispatch, uniform denials |
| `src/mobile/mobile-identity.ts` | `mobile:<deviceId>` proxy `AuthContext` |
| `src/mobile/mobile-device-store.ts` | Registry + allow-list ([mobile-pairing.md](mobile-pairing.md)) |
| `src/mcp/peer/inbound-call-gate.ts` | Source of `HARD_DENY_TOOLS` ([fleet.md](fleet.md)) |
