# Desktop Chat pane

The Chat pane (`Ctrl+Shift+J`) gives the desktop a journal-backed thread for
each top-level session. Sessions are grouped by project on the left; the selected thread
shows messages, timestamps, safe web links, attachment tiles and send status.
Draft text and a chosen file are kept per session.

```mermaid
flowchart LR
    Pane[ChatPane.vue] <--> Store[useChatStore]
    Store -->|chat:send| IPC
    Store -->|chat:history| IPC[chat-handlers.ts]
    IPC -->|read session history| Journal[MobileChatJournal]
    IPC -->|deliver to target first| Target[CLI or ComfyUI session]
    IPC -->|on success| Broker[ChatBroker]
    Agent[Agent chat_send] --> Broker
    Broker --> Mobile[MobileChatBridge]
    Broker --> Telegram[TelegramRelayService]
    Mobile -->|append before push| Journal
    Journal -->|onAppend / chat:entry| Store
    Telegram -->|incoming turn after delivery| External[recordExternalTurn]
    External --> Journal
    Phone[Phone session_send_text] --> Mobile
    Mobile -->|accepted call| Gate[MobileGate]
    Gate --> Target
```

`useChatStore` merges the initial history with the live feed by journal sequence.
It keeps drafts, attachments and the in-memory read cursor per session. Unread
counts include new agent messages; selecting a thread or receiving a live entry
while it is selected advances its read cursor. Alerts and user echoes do not
increment the count.

User turns carry an `originId`: `desktop:` renders as **Desktop**, `telegram:`
as **Telegram**, and phone origins as **Phone**. Agent replies have no origin
badge. Telegram adds `[Desktop]` to the displayed text of desktop-sourced sends;
the journal and phone keep the original text.

The context header shows the session name, mission, project folder, CLI label,
context tokens/window with the per-CLI amber/red thresholds and sparkline, plus
activity and session state. These values come from existing session metadata.

The ComfyUI profile and reference-gallery picker is a follow-up. The pane keeps
basic prompt and single-file submission, using the default profile and size.
