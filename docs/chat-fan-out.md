# Chat fan-out — ChatBroker, ChatBridge and the mobile chat surface

Telegram used to **be** the chat channel: `TelegramRelayService` was both the
concept and the transport. A phone over BLE is a second surface that runs
**alongside** Telegram permanently, and a LAN surface is wanted later still, so
the concept is lifted out into a bridge interface and a broker.

| Module | Role |
|--------|------|
| `src/session/chat/chat-bridge.ts` | The interface one chat surface implements |
| `src/session/chat/chat-broker.ts` | Unbounded registry, fan-out, inbound routing |
| `src/session/chat/chat-bindings.ts` | Per-provider session bindings + `topicId` migration |
| `src/telegram/relay-service.ts` | `provider: 'telegram'` — the first implementation |
| `src/mobile/mobile-chat-bridge.ts` | `provider: 'mobile'` — the phone, and the inbound call path |
| `src/mobile/mobile-envelope.ts` | The records that cross the BLE wire |

```mermaid
graph TB
    CLI[AI CLI] -->|telegram_chat MCP tool| SVC[HelmTelegramService]
    SVC --> BROKER[ChatBroker<br/>unconditional fan-out]
    BROKER --> TG[TelegramRelayService<br/>provider: telegram]
    BROKER --> MOB[MobileChatBridge<br/>provider: mobile]
    BROKER -.->|later, no code changes here| LAN[LAN bridge]
    TG --> TOPIC[Telegram forum topic]
    MOB --> LINK[MobileLinkManager] --> PHONE[Paired phone]

    PHONE -->|call record| LINK --> MOB
    MOB -->|"the ONLY route"| GATE[MobileGate] --> MCP[callMcpTool]
```

## Fan-out is unconditional

Every registered bridge receives every message, always. No provider selection, no
"prefer the phone when it is linked", no de-duplication. Telegram is the only
out-of-BLE-range path, so suppressing it whenever the phone happens to be online
would make *"was I told?"* depend on link state. **Duplicate buzzes are the
accepted cost** — the escape hatch is muting the Telegram topic at OS level.

One bridge failing never silences another: each send is isolated, and a throw
becomes a `sent: false` row rather than propagating.

The registry is **unbounded**. Adding a surface is one `register()` call and one
interface implementation — nothing in the broker, the service or the MCP tools
changes. The MCP tool names (`telegram_chat`, `telegram_send_voice`) are
deliberately unchanged: a CLI keeps calling what it always called, and the extra
surfaces appear behind them.

## chatBindings — where a session lives on each surface

`SessionInfo.topicId` was a Telegram forum topic id and nothing else. The
persisted form is now `chatBindings`, a map keyed by provider.

Two rules, both learned the hard way:

1. **Forward compatible.** An unrecognised provider key survives a load/save
   round-trip untouched. An older Helm must not silently delete a newer one's
   binding — that is exactly how fleet lost `machineId`.
2. **One source of truth per provider.** `topicId` remains on the in-memory
   `SessionInfo` as Telegram's typed view of `chatBindings.telegram`, because the
   whole Telegram stack reads it. The mirroring lives **only** in
   `chat-bindings.ts`: derived on save, rehydrated on load, legacy `topicId`-only
   records migrated on the way. Per invariant 6, `chatBindings` is in
   `serializeSession`'s allow-list; the regression test is
   `tests/chat-bindings.test.ts`.

Mobile deliberately has **no** binding — a phone addresses a session by its id.

## Inbound

Telegram keeps its own inbound path: it already resolves topic → session and
injects into the PTY itself, so routing it through the broker as well would
deliver the user's message twice. It therefore does not emit `inbound`.

The phone's inbound path is different and is a **security boundary**: every
record a phone sends is a `call`, and every call goes through
`MobileGate.handle`. A chat reply from the phone is a `session_send_text` call —
gated, rate-limited and audited like any other — not a privileged side channel.
There is no second gate and no other route from `MobileChatBridge` to a tool. If
no gate is wired the bridge **denies**; a missing boundary never becomes an open
one.

Anything that is not a well-formed `call` from a **registered** machine is
dropped silently — answering would tell a stranger their bytes were understood.
`MobileDeviceStore.getByMachineId` is the bridge between the link manager (keyed
on `machineId`) and the gate (keyed on the local `MobileDevice` record id).

## The mobile wire records

`src/mobile/mobile-envelope.ts` defines four UTF-8 JSON records carried inside a
`SecureChannel` message. Key order is fixed and optional keys are omitted rather
than emitted as null, so two encoders in two languages produce identical bytes.

| Record | Direction | Purpose |
|--------|-----------|---------|
| `call` | phone → Helm | A tool invocation. The only inbound kind. |
| `result` | Helm → phone | The gate's return value for one call id. |
| `error` | Helm → phone | JSON-RPC-shaped failure; deny messages stay uniform. |
| `chat` | Helm → phone | An unsolicited agent message for a session. |

Decoding never throws — a malformed record is dropped and logged.

**Cross-language contract:** `tests/fixtures/mobile-envelope-vectors.json` pins
the exact bytes for both directions plus the payloads a conformant decoder must
refuse. P-0743 (Kotlin) asserts against that file. Regenerate it **only** for an
intentional wire change:

```bash
npx tsx scripts/generate-mobile-envelope-vectors.ts
```

Regenerating is a wire break.
