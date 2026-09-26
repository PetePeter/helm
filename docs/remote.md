# Remote: drive a peer's sessions from here

## Why

Fleet lets you **delegate**: your AI calls another Helm's tools with `peer_call`. Remote lets you **talk**: a session running on another PC appears here as an ordinary row. Its terminal streams from the peer, and your controller, keyboard, phone and voice drive it directly, with no AI in the middle.

Remote is an option of Fleet, not a separate system. It uses Fleet's TLS-WS link, SAS pairing, per-peer allow-list, rate limit and audit log. It adds no new port, crypto or pairing.

## Shape

```mermaid
graph LR
  subgraph "Viewer (this PC)"
    UI[xterm · dots · bindings · phone] <--> PM1[PtyManager]
    PM1 --> RPP[RemotePtyProcess<br/>adopted PtyProcess]
    RS1[RemoteService.open] --> RPP
  end
  RPP <-->|PeerLink<br/>attach = request<br/>data/write/resize/exit = notifications| PL[(Fleet link)]
  subgraph "Owner (peer PC)"
    PL --> G[InboundCallGate<br/>allow-list · rate limit · audit]
    G --> RH[RemotePtyHost]
    PL -->|notifications| RH
    RH <--> PM2[PtyManager<br/>real node-pty]
  end
```

- **A remote PTY is just a `PtyProcess`.** `PtyManager.adopt()` registers a `RemotePtyProcess` exactly like a spawned process. Everything downstream (terminal, activity dots, pattern matcher, `session_send_text`, bindings, the phone) works unchanged.
- **Attach is the grant.** `remote.attach` is a request, so it passes the owner's `InboundCallGate` like any Fleet call. The later `remote.write`, `remote.resize` and `remote.detach` notifications are honoured only from a peer that is currently attached to that session.
- **Streams are notifications.** `PeerLink.notify()` sends id-less JSON-RPC frames: no reply and no timeout, because a round-trip per keystroke would be too slow. The owner coalesces output into one `remote.data` frame per ~16 ms, each with a `seq` number.

## Lifecycle

| Event | What happens |
|---|---|
| Attach | The owner returns a raw snapshot of the last 500 lines, plus the size and label, then nudges a resize so full-screen TUIs repaint. The viewer adds a row with `remote: { peerId, sessionId }`. |
| Lost frame (`seq` gap) | The viewer re-attaches, resets the terminal (`ESC c`) and repaints from a fresh snapshot. |
| Link drops | The viewer shows a notice, and the owner stops streaming to that peer. When the link returns, the viewer re-attaches and repaints. |
| Close the viewer row | This **detaches** only. The CLI keeps running on the owner. |
| Owner's PTY exits | `remote.exit` is sent, and the viewer row ends. |
| Resize | The last resize wins. |

## Rules

- **Remote rows are views, never local sessions.** They are not persisted, not recycle-binned and have no `cliSessionName`, so a restart can never resume-spawn the peer's CLI locally. To get one back after a restart, re-attach.
- **No chains.** A Remote row is never re-exported: attaching to it answers "not found", the Peers-tab picker hides it, and `peer_attach` is hard-denied to inbound peers.
- **Artifacts follow the CLI.** The CLI's MCP calls go to the owner's Helm, so its artifacts live there. `session_artifact_list` and `session_artifact_get` for a Remote row are forwarded to the owner using the owner's session id. That covers the phone, the renderer and local AIs. Downloads, uploads and missions stay local-only for now.

## Access

On the **owner**, allow the viewer peer these patterns. The **Remote** preset in the Peers tab sets all four:

| Pattern | For |
|---|---|
| `session_list` | Finding what to attach to |
| `remote.*` | Attaching |
| `session_artifact_list`, `session_artifact_get` | Artifacts of attached rows |

A `*` allow-list includes Remote. That's consistent with `session_send_text`, which also writes into a PTY.

## Entry points

- **Peers tab:** the **Attach…** button on an online peer lists its sessions, and **Attach** opens the chosen one here.
- **MCP:** `peer_attach(peer, sessionId)`. This is how the phone's operator opens a remote session: find it with `peer_call(peer, "session_list", {})`, then attach. Once attached, nothing else is needed; all input and output routes automatically.

## Modules

| Module | Role |
|---|---|
| `src/session/remote/remote-protocol.ts` | Wire vocabulary shared by both sides |
| `src/session/remote/remote-pty-host.ts` | Owner: streams, applies writes, authorizes by attach |
| `src/session/remote/remote-pty-process.ts` | Viewer: adopted `PtyProcess`, seq ordering, repair |
| `src/session/remote/remote-service.ts` | Both roles over the live Fleet link manager; `open()` |
| `src/mcp/peer/peer-link.ts` | `notify()` plus the `notification` event |

## Known limitations

- Removing `remote.*` from a peer's allow-list stops **new** attaches but doesn't cut a stream that's already attached. To cut it, disable the peer; that drops the link.
- Attaching is manual (Peers tab or `peer_attach`). Remote rows aren't restored after a restart.
- Artifact downloads and uploads, missions and hooks for a Remote row stay with the owner.
