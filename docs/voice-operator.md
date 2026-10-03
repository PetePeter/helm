# Voice operator — "Call Helm"

A phone-call-style voice conversation with Helm from the Android app. A call
is a mode of a chat: the composer's round voice button, set to 📞, rings that
session and the composer turns into the call's controls. Talk; Helm says "on it"
and later speaks the result. Built for driving: it runs through the car's
Bluetooth, the handset or the speaker, and survives the screen turning off.

It is full duplex like a phone call, not a walkie-talkie: the mic stays open
while Helm speaks, and talking over Helm stops it.

This page covers the phone half (P-0834, P-0835), the desktop's
[operator session](#the-operator-session--helm) (P-0833) and
[desktop voice](#desktop-voice) (P-0836). With no operator
configured, any session's chat can be called.

## Shape

```mermaid
graph LR
    subgraph Phone
        UI[ChatScreen<br/>CallPanel in the composer] -- intents --> SVC[VoiceCallService<br/>FGS: microphone]
        SVC --> CC[CallController<br/>pure state machine]
        CC --> STT[CallMic<br/>VoskCallMic]
        CC --> TTS[TtsEngine<br/>AndroidTtsEngine]
        SVC -- sendChat --> CL[HelmClient]
        CL --> CR[ChatRepository<br/>target thread]
        CR -- CallFeed --> CC
        SVC -- call StateFlow --> UI
    end
    CL -- session_send_text<br/>gated --> Helm[Helm desktop<br/>target session]
    Helm -- chat records --> CR
```

No new wire surface: an utterance is the same gated `session_send_text` a typed
chat message is, and a reply is whatever lands in the target's chat thread. The
call is drawn inside that thread's chat, so the transcript **is** the thread and
the call and the chat can never disagree.

## Who is called

The session whose chat the call was started from — its composer's 📞, the 📞
on its control sheet, or (for the operator) the 📞 on the Helm home tab. One
call at a time: while a call is live, other chats' phone buttons go dark.

## The composer's voice button

One round button, Telegram-style, either 🎙 or 📞 (remembered):

- 🎙 **hold** to dictate into the draft; **slide up** while holding to switch mode.
- 📞 **tap** to call this session; **hold** to switch mode.

While a call with the session is live, `CallPanel` replaces the composer:
status, what was heard, Handset / Speaker / Bluetooth, the three-state mic
control, and Hang up. Leaving the chat does not hang up — like a phone app; the
notification can.

The mic control cycles through **Open → Muted → PTT**. In PTT mode the mic is
muted until the ThinkPhone Red Key is held; releasing it mutes the mic again.
Helm sees that key as Android `KEY_SEARCH` and filters it through the
`RedKeyPttAccessibilityService`, so it works while the call screen is focused
or in the background. Android requires the user to enable this service in
Accessibility settings. Choosing PTT opens those settings if the service is
not connected. The key filter consumes `KEY_SEARCH` only during a live PTT call.

## The Helm home tab

The operator is the FIRST entry of the phone's home dropdown — **Helm**, then
Sessions, Plans, Contexts (`HomeTab`; Sessions stays the default). The Helm tab
is `ui/operator/OperatorSection.kt` — status dot, last reply (tap → the full
thread), 📞 Call — with the operator's chat thread below
it, the same `ChatScreen` a session's Chat tab uses. Seeing it there counts as
reading it (unread clears). The operator session is filtered OUT of the Sessions
list (`withoutOperator`), so it is shown in one place only.

```mermaid
graph TD
    S[session list + chat threads] --> Q["operatorSummary()"]
    Q -->|operator present| On["On: name · activity dot · last reply"]
    Q -->|none| Off["Off: 'enable it in desktop Settings > Operator'"]
    On -->|tap| Chat[operator chat thread]
    On --> Call[📞 → call in the operator chat below]
    On --> Thread[operator chat below the section]
```

The last reply is the newest non-phone row of the operator's thread — the same
journal the chat screen reads. The 📞 appears only when an operator exists and
no call is live; any session is still callable from its own chat. The phone matches the literal string
`"operator"` (`CallTarget.kt`), so that value is a wire contract.

## The operator session — "Helm"

One locked session named **Helm** that every voice client (phone now, desktop
later) talks to. It answers questions about Helm state and general questions (including web
searches and page fetches)
itself; for work, it is a router: it passes an instruction to the right work
session, acknowledges at once, and speaks a short summary when the reply comes
back. It never edits files, runs commands, reads repo code or restarts Helm —
coding stays in the sessions that own it, and there is one conversation for
phone and desktop to share.

**It manages Helm itself.** Every other Helm MCP tool is open to it: schedules
(a "remind me" is a `scheduler_create` direct task with `targetSession:"caller"`),
plans, contexts, sequences, artifacts, and sessions — it may `session_create` a
session for work nothing fits, hand it over, and `session_close` it when done
(never one it did not create, unless asked).

**Its own memories and tasks.** It ALWAYS lives in `<config>/operator`,
registered as the **Helm Operator** project (`ensureOperatorHome`); there is no
working-dir setting, because a repo dir put its memories and task plans in that
repo's project. An operator found anywhere else (restored from an older build)
is demoted and a fresh one spawned at home. It may READ every
project's memories — `MemoryManager.canReadAll`, wired to `role === 'operator'` —
but writes stay fenced to its own project: reading is never owning, enforced in
`owns()`, not in the prompt.

```mermaid
graph LR
    V[Phone / desktop<br/>voice or chat] -- session_send_text<br/>gated --> OP[Helm operator<br/>role=operator, locked]
    OP -- session_send_text<br/>expectsResponse=true --> W[Work session]
    W -- HELM_MSG reply --> OP
    OP -- chat_send<br/>1–2 spoken sentences --> V
    subgraph Main process
        CFG[Settings → Operator<br/>enabled · cliType · workingDir] --> OSM[OperatorSessionManager.ensure]
        OSM -- spawn once --> SPAWN[spawnConfiguredSession<br/>+ operator guide]
    end
    SPAWN --> OP
```

- **Singleton.** `OperatorSessionManager.ensure()` (`src/session/operator-session-manager.ts`)
  runs at startup, after `restoreSessions`, and on every settings save. It
  keeps exactly one `role: 'operator'` session: a persisted one is reused (the
  renderer's auto-resume brings it back on the same `cliSessionName`), a
  missing one is spawned through `spawnConfiguredSession`. Duplicates keep the
  oldest and have their role cleared — demoted, never closed. Lock and the
  name "Helm" are re-asserted on every ensure.
- **Off means demoted.** Disabling the setting clears the operator's role, so
  the phone stops routing to it; the session itself stays open until you close
  it (force, since it stays locked).
- **Restart.** A force-restart (`helm_restart` with `resume:false`) skips the
  operator: its lock is by design, so it neither blocks the restart nor gets
  closed, and it resumes next launch.
- **Settings.** `settings.yaml → operator: { enabled, cliType, workingDir, compactEveryMinutes }`,
  edited in Settings → 🎙 Operator. `cliType` is a dropdown of your own CLI
  types — ids are per-machine UUIDs, so there is no shipped default and
  nothing spawns until one is chosen. Changing `cliType` takes effect at once
  (and on restart): the operator on the old type is demoted and unlocked, not
  closed, and a fresh operator spawns on the new type.
- **Persistence.** `SessionInfo.role` is in `serializeSession`'s allow-list
  (invariant 6), in the renderer's session-refresh allow-list, and in
  `session_list`/`session_get` summaries. An unknown role drops on load.
- **Rules.** `src/mcp/guides/operator-guide.ts` is delivered as the initial
  prompt. There are three modes (P-0838):

  ```mermaid
  flowchart LR
      Q[User asks] --> K{Kind?}
      K -->|Helm state| A[Read-only lookups:<br/>plan_* · sequence_* · session_* · context_*<br/>scheduler_list · memory_* · skill_list<br/>directory_list · project_list · tool_list] --> R[chat_send answer]
      K -->|general| G[Own knowledge + web search] --> R
      K -->|work| W[session_send_text to owning session]
  ```

  The only writes are `chat_send` and `session_send_text`. It never edits
  files, runs commands, reads repo code, mutates Helm state, or spawns or
  closes sessions. It asks back when the target is ambiguous, and it keeps a
  speakable style (no markdown, paths or UUIDs). CLI types come from the
  existing `tool_list`, so no new tool was needed.
  **Rule changes need a fresh prompt:** the guide is the operator's initial
  prompt, so a running operator only picks up edits after it is respawned or
  cleared. The idle self-clear below re-sends it every time.
- **User rules (P-0842).** Settings → Operator has a **Rules** section. It
  lists the built-in hard rules read-only and has a "Your rules" box.

  ```mermaid
  flowchart LR
      OR[OPERATOR_RULES<br/>operator-guide.ts] --> G[buildOperatorGuide rules]
      OR --> TAB[OperatorTab.vue<br/>read-only list]
      TAB -->|Save| CFG[settings.yaml<br/>operator.rules]
      CFG --> G
      G --> SP[spawn: initial prompt]
      G --> HC[self-clear context]
  ```

  - **The built-ins remain.** User rules are appended as a `[user_rules]`
    section (one `rule_N` per non-blank line), ranked as the highest priority.
    They can narrow the operator or grant it more. The built-in `[rules]` are
    still sent every time, and blank rules add no section.
  - **One source.** The tab imports `OPERATOR_RULES` from the guide module, so
    the list shown is exactly the text the operator receives.
  - Both deliveries read the rules from config at that moment, so an edit
    applies from the next spawn or clear. Saving goes through the existing
    `config:setOperatorConfig` channel; there is no new IPC.
- **Idle self-clear (P-0839).** The operator lives for days, so its context
  would grow without bound. It is *cleared*, not compacted: a compaction summary
  must name a goal, so a finished one got re-summarised into every later
  handover and the operator kept chasing work that was long done. A clear plus
  the guide carries nothing over; durable facts belong in memories and task
  plans. Handover summaries stay for sessions whose context actually fills up. Every `compactEveryMinutes` (default 60; 0 = off)
  the manager checks it:

  ```mermaid
  flowchart TD
      T[Tick] --> B{Busy?<br/>dot active · implementing ·<br/>handover pending · open relay}
      B -->|yes| R[Retry in 30 min]
      B -->|no| S{Settling after<br/>a self-clear?}
      S -->|yes| RB[Baseline = lastOutputAt] --> N[Next tick in interval]
      S -->|no| A{lastOutputAt > baseline?}
      A -->|no| N
      A -->|yes| C[session_clear path<br/>context = operator guide] --> R
  ```

  - It reuses `clearSession` with a context, so [handover.md](handover.md)'s
    delivery and terminal lock apply unchanged. The context says "you are Helm,
    the operator, no relays are open" and then repeats the full guide.
  - **Why a settle step.** The clear's output, and the operator's answer to
    the guide, move `lastOutputAt` too. The first idle check afterwards
    rebaselines, so that echo never counts as activity. Otherwise an untouched
    operator would clear every hour forever. The cost: activity in that same
    window is picked up an interval later. Rebaselining on `handover-delivered`
    was rejected: the operator's reply to the handover comes *after* delivery,
    so it would count as activity and bring back the hourly loop.
  - **In-flight safety.** A tick awaits the clear. A generation counter,
    bumped on every timer clear, stops a tick that outlived a
    dispose/disable/interval change from rescheduling.
  - **Open relays.** An operator send with `expectsResponse` (seen on the
    message-flight sink) opens a relay. The recipient's next message to the
    operator closes it. Clearing mid-relay would lose what the reply is for.
    A relay stops blocking after 2 h, so a reply that never comes cannot pin the
    context forever.
  - The baseline is in memory. After a restart, the first idle tick clears
    once if the operator has any output at all.
- **Launch race.** Main can spawn the operator before the renderer's
  auto-resume runs; `pty:spawn` treats a resume of an already-live PTY as an
  attach, not a second process.

## The call state machine — `CallController`

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Idle: start (user's call): ask Telecom, "Connecting…"
    Idle --> Listening: Telecom took the call / answered ring (mic opens once)
    Idle --> Ended: Telecom refused (Busy / Unavailable) / hang up while connecting
    Listening --> Sending: non-empty final (unmuted)
    Sending --> Listening: carried
    Sending --> Speaking: send failed (spoken error)
    Listening --> Speaking: reply arrives (mic stays open)
    Speaking --> Speaking: next queued reply
    Speaking --> Listening: queue empty
    Speaking --> Listening: barge-in (2+ words heard)
    Listening --> Ended: hang up / mic failure
    Speaking --> Ended: hang up
```

Why each rule exists:

- **One open mic.** `CallMic` is a single stream from pick-up to hang-up. The
  old per-utterance `SpeechRecognizer` restarted on every pause, grabbed audio
  focus on each restart (which churned the Bluetooth headset's call link) and
  could not listen while Helm spoke.
- **Silence is never sent.** Empty or whitespace finals are dropped.
- **Heard, instantly.** Each send plays a short ack tone on the call route.
  TTS runs at 1.15×. `call sending` / `call target replied` /
  `text to speech speaking` / `call barge-in` log lines give the per-turn trace.
- **Barge-in.** Helm speaks with the mic open; a partial of 2+ words stops it,
  drops what was queued, and what the user says is sent. One stray word while
  speaking is taken as residual echo and ignored — echo removal itself is the
  recorder's job (below).
- **Replies queue in order**, including ones that arrive mid-send.
- **Mute is the phone's own microphone mute** (`MicSwitch` →
  `AudioManager.isMicrophoneMute`), not an app flag. The Mute button, a car
  screen and the system call UI all flip that one switch, so they cannot
  disagree. Telecom reports a change through the legacy
  `onCallAudioStateChanged` callback or Android 14+'s mute callback; the call
  re-reads the switch (`syncMute`), which is why a repeated or stale report
  can never flip it. Nothing is sent while muted, a muted user never interrupts,
  and the switch is handed back as it was found when the call ends. A headset
  that mutes inside itself tells the phone nothing: Helm just hears silence.
- **Every call is a system call** (`CallLine` → `HelmTelecom`). A call the user
  starts is placed with Telecom first and opens the mic only once Telecom has
  created it; a refusal (`CallRefusal.Busy` — another call is up — or
  `Unavailable`) ends it before any audio is taken, with a toast saying why.
  There is no call outside Telecom, so the car's mute and hang-up always reach it.
- **Send failures are spoken** ("That did not send.") and the call keeps going.
- **A mic that cannot run** (no recorder, no model) ends the call with an error.

## The call mic — `VoskCallMic`

One `AudioRecord` as `VOICE_COMMUNICATION` (so the platform's call echo
canceller applies; `AcousticEchoCanceler` and `NoiseSuppressor` are enabled
when present), 16 kHz mono in 100 ms frames, fed to an offline
[Vosk](https://alphacephei.com/vosk/) recogniser. Partials drive barge-in;
finals are utterances. Nothing leaves the phone but the recognised text.

**The model** is `vosk-model-small-en-us-0.15` (~40 MB zip, English only). It
is not checked in: the Gradle `voskModel` task downloads it once into
`android/app/build/vosk/` and unpacks it into generated assets with a `uuid`
file; on first call it is unpacked to `filesDir` (`StorageService.unpack`) and
loaded once per process. The dictation mic (🎙) still uses the platform
recogniser — it is per-utterance by nature.

`CallFeed` turns the target thread into events: rows present at call start are
history and never read out; each new agent row is a reply; each own row that
settles `Failed` is one spoken failure.

## Audio — `VoiceCallService`

A foreground service of type `microphone` (manifest:
`FOREGROUND_SERVICE_MICROPHONE`, `MODIFY_AUDIO_SETTINGS`). For the call's
lifetime it:

- sets `AudioManager.MODE_IN_COMMUNICATION` and restores the previous mode on end
  (only if the call actually began — a service that never began touches nothing);
- requests no audio focus of its own: every call is a Telecom call, Telecom
  holds the call focus for it, and a second request for the same call is always
  refused. A GSM call taking over ends ours through Telecom
  (`HelmConnection.onDisconnect`);
- requests routes through its self-managed Telecom `Connection` (legacy route
  API through Android 13, call endpoints on Android 14+), and marks only the
  route Telecom confirms as active. The recorder and voice share that route;
- speaks TTS as `USAGE_VOICE_COMMUNICATION`, so replies follow the call route.

The call screen offers the routes Telecom reports as available. Its route
selection follows Telecom's confirmed current route, so a rejected request does
not make the UI claim the audio moved. Call controls have a 64 dp minimum height
for reliable taps while moving.

The notification carries a **Hang up** action. The call is not sticky: a killed
call is never restarted behind the user's back.

## Desktop voice

Hold a gamepad button bound to `voice-talk` (or press **Ctrl+Shift+Space**,
press again to send) and talk; the words go to the operator and its reply is
spoken through the speakers. It reuses the local tools Telegram already has —
no second STT/TTS stack.

```mermaid
sequenceDiagram
    participant R as Renderer<br/>useVoiceCall
    participant M as Main<br/>VoiceService
    participant OP as Operator "Helm"
    participant P as Phone
    R->>M: voice:transcribe(clip)
    M->>M: OpenWhisprTranscriber (src/voice)
    M-->>R: text
    R->>M: voice:ask(text)
    M->>OP: deliverPromptSequenceToSession
    M->>P: recordDesktopTurn (journal + live push)
    OP->>M: chat_send (ChatBroker fan-out)
    M-->>P: MobileChatBridge
    M-->>R: DesktopVoiceBridge → voice:operatorReply
    R->>M: voice:speak(text)
    M-->>R: OGG/Opus bytes (PiperTts)
```

- **Shared modules.** `openwhispr-transcriber.ts`, `piper-tts.ts` and `ffmpeg.ts`
  moved from `src/telegram/` to `src/voice/`; Telegram imports them from there
  unchanged. Piper keeps its OGG/Opus output — Chromium plays it natively.
- **Configuration.** The tool paths live in Settings → Voice (shared with
  Telegram voice notes; still stored under the `telegram` config block).
  `CapabilityDetector.getVoiceTools()` checks them without requiring the bot to
  be enabled; a missing tool is a clear error, and nothing is spawned.
- **Config boundary.** The recorded clip, its transcript and the synthesized
  OGG live in the app-data temp dir and are deleted on success and failure.
- **Replies.** The operator answers with `chat_send`, as for the phone.
  `DesktopVoiceBridge` is one more ChatBroker surface, so the desktop hears
  exactly what the phone receives; it declines every non-operator session.
- **One conversation.** The user's desktop words are journaled
  (`originId: desktop:<uuid>`) and pushed live to linked phones, so the phone
  thread shows both sides.
- **Call window.** The first talk opens the call; while it is open each
  reply is spoken once, strictly in arrival order. After **Hang up** replies
  are still listed but not spoken — the phone may be the one talking.
- **Gating.** Talk and Call refuse (with a message) while no operator exists.

### The sidebar "Helm" section

The desktop twin of the phone's first tab (`OperatorSummary.kt`):
`OperatorSection.vue` is pinned above the session list and fed by the pure
`operatorSummary()` (`renderer/operator-summary.ts`) — the operator's activity
dot (`state-colors.ts`), its last reply (seeded at startup from the chat
journal via `voice:lastOperatorReply`, so it survives a restart), **Call / Hang up**, and while a call is
open the live phase and transcript (it replaced the floating call panel — one
UI). Clicking the title opens the operator's pane. With no operator it
reads "Enable in Settings > Operator". `buildSessionGroups` drops the operator
(`withoutOperator`), so it is never listed twice — the same rule as the phone.
Instead it is the pinned first gamepad nav item (`buildFlatNavList` →
`type: 'operator'`), so the D-pad and stick reach it like any session card
(Invariant 1: the gamepad reaches everything). Starting a call from any binding
restores/activates/reveals the Sessions pane, so the Hang up button is always
on screen.

### The operator chat view

Opening the operator shows `OperatorChat.vue` over its terminal (the xterm
stays mounted underneath; **Terminal** / **Chat** flip between them). It is the
phone's operator thread on the PC: the conversation IS the chat journal.

```mermaid
flowchart LR
    C[OperatorChat.vue] -- voice:operatorHistory --> J[(chat journal)]
    J -- onAppend → voice:operatorChat --> C
    C -- voice:ask text + filePath --> M[main: deliver to operator PTY<br/>+ recordDesktopTurn]
    M --> J
    O[operator chat_send] --> B[ChatBroker] --> MB[MobileChatBridge] --> J
```

- **Bubbles.** User turns (desktop or phone, `originId` set) on the right in
  the accent green; the operator's messages on the left. Alerts are skipped.
- **Composer.** Enter sends, Shift/Ctrl+Enter is a newline. 📎 attaches a local
  file: the path is appended to the prompt — the operator is a local CLI and can
  read it.
- **Push-to-talk dictates** — hold 🎤 or the PTT key (Settings → Operator,
  default `f9`, captured as a canonical combo) and the transcript lands in the
  composer to edit and send. No spoken replies; **Call** in the header is the
  same hands-free call as the sidebar's. The key press goes through the one key
  router (`operator-chat-ptt`, global, allowed in fields); release is its keyup.
- **Born as the operator.** `spawnConfiguredSession` takes `role`/`locked`, so
  the operator is added with its role in the same `addSession` — no list ever
  sees it as a plain row, even for a frame.

### Hands-free call

**Call** (or a gamepad button bound to `voice-call`, a toggle) keeps the mic
open and lets a voice-activity gate cut it into turns; hold-to-talk still works
outside a hands-free call.

```mermaid
stateDiagram-v2
    [*] --> listening: Call (mic.open + listen)
    listening --> transcribing: Vad 'end' (quiet ≥ 800ms after ≥ 250ms speech, or 30s cap)
    listening --> listening: Vad 'discard' (blip / 30s silence) — drop, fresh recording
    transcribing --> listening: voice:transcribe → voice:ask
    listening --> speaking: operator reply (mic.take — paused)
    transcribing --> speaking: operator reply
    speaking --> listening: clip played + 300ms (fresh recording)
    listening --> [*]: Hang up (mic.close)
    speaking --> [*]: Hang up
```

- **Vad** (`renderer/voice/vad.ts`) is pure: fed one RMS energy per 20ms frame
  with its time, it emits `start` / `end` / `discard` (blips shorter than the
  minimum speech length). No WebAudio in its tests.
- **Mic** (`createBrowserMic`, `browser-audio.ts`): one stream for the call, an
  `AnalyserNode` meter, and a fresh `MediaRecorder` per turn. A turn's clip
  runs from when listening resumed, so the speech onset is never clipped.
- **Bounded.** A turn is cut at 30s (forced `end`); a recording that held no
  speech for 30s, or only a blip, is `discard`ed — dropped, and a fresh one starts.
- **Race-safe.** A hang-up (or a second `voice-call` press) while the mic is
  still opening cancels the call; the mic is closed as soon as it opens. A
  generation counter makes late transcribe/playback work from an ended call inert.
- **No echo.** The mic asks for browser echo cancellation, noise suppression
  and AGC; recording and meter are paused while Piper speaks and resume 300ms
  after it ends; words spoken over a reply are dropped. A failed or repeated
  `open()` releases the stream and audio context. Empty transcripts send
  nothing. No new main-process code — the same `voice:*` IPC.

## Ring me — a session calls the user

"Hey operator, call me when P-0850 finishes or has blocking questions." Calls
were phone-initiated only; `ring_user` is the one reverse path.

```mermaid
sequenceDiagram
  participant U as User (phone)
  participant O as Operator
  participant W as Work session
  U->>O: "call me when X"
  O->>O: memory_create "[RING-ME] X"
  O->>W: session_send_text "tell me when X"
  Note over O: /compact → SessionStart re-lists [RING-ME] memories
  W->>O: X happened (text or artifact id)
  O->>U: ring_user {reason} → chat kind:"ring"
  U->>O: Answer → ordinary Call Helm to the operator
  O->>O: memory_delete the watch
```

- **Any session.** `ring_user` rings as the calling session: the phone shows its
  name as caller ID and Answer opens a Call Helm straight to it. The flow above is
  the operator's "call me when X"; a work session the user asked directly just
  rings when X is met. A work session may still hand the operator what to say
  (`session_send_text`, or an artifact id) and let it make the call.
- **Watches are plain memories**, tldr prefixed `[RING-ME]` (`RING_ME_PREFIX`,
  `context-injector.ts`). No new store: SessionStart fires after every
  compaction, and for the operator it lists those tldrs with the instruction to
  check them.
- **Wire:** the existing alert push with `kind: "ring"` (`MobileChatBridge.sendRing`).
  A phone that predates it degrades to an ordinary notification.
- **Phone:** `notify/IncomingRing.kt` — high-importance CALL notification with a
  full-screen intent and the default ringtone, 30 s timeout. Answer opens the
  app and starts `VoiceCallService` (a visible activity may start the mic FGS;
  a background broadcast may not). Answering on a locked phone shows the app
  over the lock screen and turns the screen on (`MainActivity.showOverLockScreen`),
  so the call starts without an unlock; the pass is dropped in `onStop`, so only
  the answered call ever sits over the keyguard. Because `MainActivity` is
  exported, Accept carries a one-shot `RingTicket` minted with the ring; an accept
  intent without the live ticket (another app's) only opens the thread. Decline just stops ringing;
  nothing is reported back.
- **A real incoming call.** The ring is an Android Telecom call
  (`telecom/HelmTelecom.kt`, a self-managed PhoneAccount + `HelmConnectionService`),
  so car Bluetooth call screens, steering-wheel and headset buttons can answer,
  decline and mute it. Self-managed calls draw their own UI, so the ring
  notification is its incoming UI; Answer from anywhere runs the same
  MainActivity accept path. The system call ends with ours and times out with
  the notification (30 s, missed). A ring Telecom refuses (a phone call is up,
  no permission) does not ring: it lands as an ordinary alert, and being
  unanswered it still gets Helm's one retry.
- **Opens speaking.** Within a breath of Answer the phone says "Hi, it's Helm.
  I have a message about <reason>. Is now a good time?" (`RingGreeting`, spoken
  via `CallController.start(opening)` with the mic already open). The user's
  spoken yes / no / "call me back in N" reaches the operator, whose guide says
  how to honour each — a call-back is a once scheduler self-timer.
- **One retry per session.** The phone reports only ANSWERED (`__ring_answered__`
  with `{ sessionId }`, in-gate; an older phone names none and ends every chain).
  No answer inside 45 s — declined, timed out, phone off — and Helm rings once
  more 10 min later (`src/session/ring-retry.ts`). Each session keeps its own chain, so one
  session's ring never cancels another's retry. Each miss leaves a note in
  the ringing session's chat: the first says when Helm will call back (~HH:MM), the
  second says there are no more retries. In memory: a restart drops a pending retry.
- **Ear sensor.** For the whole call, on any route, a proximity wake lock
  darkens the screen while the sensor is covered — at the ear, or face down
  on a stand to save battery. Lifting it wakes the screen. Released when the call ends.
- **Fails legibly** when no phone takes the ring; the caller falls back to
  `chat_send`.

## Sessions the operator starts report back to it

A session created by the operator gets `reportsTo = <operator id>` (persisted).
Every SessionStart — so also after each compaction — tells it that it works for
the operator and must send progress, results and questions there with
`session_send_text`, not to the user. The user taking it over clears the field:
a phone or Telegram message to it (seen by the prompt hook), or typing into its
terminal. From then on it is an ordinary session and answers the user.

## Call transfer — `call_transfer`

A live call can be handed from the session holding it to another, so the user
speaks with a work session directly and can be passed on again (or back).

```mermaid
sequenceDiagram
  participant U as Phone (call with A)
  participant A as Session A
  participant B as Session B
  A->>U: call_transfer {B} → chat kind:"transfer", fromSessionId A
  U->>U: live call target == A? retarget to B
  U->>U: speak "Now talking to B."
  U->>B: next utterance → sendChat(B)
```

- **Only the holder moves it.** The desktop cannot see which session the phone
  is talking to, so the phone checks: a transfer whose `fromSessionId` is not
  the live call's target is ignored (`VoiceCallService.transfer`).
- **Nothing drops.** Mic, the Telecom call and route stay; only the send target and
  the reply feed change. The new feed baselines on the thread as it stands, so
  the new session's history is never read out.
- **Wire:** the alert push with `kind: "transfer"`, `sessionId` = the session
  taking the call, plus `fromSessionId` (emitted last). A phone that predates it
  shows an ordinary notification; the call stays where it was.

## Operator tasks — asks it follows through

"Check ABC and get it done later", "check EF too", "build G": each is an ask the
operator must keep chasing across compactions. A task is an ordinary plan in the
operator's own project carrying a `task` block — `builderSessionId`,
`watchPlanId`, `waitingOn` — set with `plan_update`. **Why a plan:** plans already
persist, render on both boards and complete with notes; a task differs only in
being a follow-up in flight, which its project and block say.

**Helm opens the task, not the model.** The operator's prompt asked it to open a
task and timer on every hand-off, and it forgot, above all after compaction.
So for the operator only, `session_create` and `session_send_text` take
`task` when the hand-off needs following up: a short title (Helm opens the plan)
or the P-id of an open task (Helm reuses it). A one-off note takes no task and
is not tracked. Helm records `builderSessionId` and starts a 2-hour safety-net
check timer unless one already runs (`src/session/operator-delegation.ts`); its
prompt names the session to probe. When every plan a timer watches is completed,
the scheduler cancels it (`plan:completed` in `ScheduledTaskManager`), so no
timer outlives its task.

**Checks follow the builder's news, not a clock** (`OperatorTaskWatcher`).
Polling woke the operator every 30 minutes with nothing to do. Now:

```mermaid
graph LR
    B[builder sets AIAGENT<br/>completed / idle] -->|run check now| O[operator:<br/>check task P-x: probe session]
    R[builder session removed<br/>or gone at startup] -->|delete timer,<br/>waitingOn: gone| X[no prompt]
    C[user cancels the timer] -->|task.checks = off| N[never re-armed]
```

A cancelled check stays cancelled: `trackOperatorTask` skips a task whose
`checks` is `"off"`, so a later hand-off for it cannot quietly bring the timer back.
The result echoes `taskId`. `session_create` from the operator also requires
`initialPrompt`, because a session opened without its work sits idle. Both are
checked before anything spawns or sends, and each refusal names what is missing.

Three more guards back this up. A built-in PreToolUse deny stops the operator
reading, running or changing code; Glob and the web stay open (see
[cli-hooks.md](cli-hooks.md#enforcement-g2--pretooluse-denies)). And every
SessionStart re-injects `OPERATOR_MANTRA` first, because the full guide arrives
only at spawn.

The check timer is an ordinary scheduler row (`targetSession:"caller"`) whose
`planIds` include the task, so "next check" is derived (`nextCheckAt` in
`src/session/operator-tasks.ts`) and never stored twice. `plan_summary` rows
carry the task block plus the builder's name and next check, so the phone and PC
cards need no full record. After every compaction SessionStart re-lists the
operator's open tasks.

**On the PC** the Plans pane shows an "Operator tasks" button while the operator
runs (found via its session's working dir, not the renameable project name). A
task card replaces its description with 👷 builder (click: go to the session),
📋 watched plan (click: open it in its own canvas), ⏰ next check, and ⏳
waiting-on. "no timer" is shown deliberately: a task nobody will check is a
dropped ask.

**On the phone** the Helm home tab's operator row has a **Tasks** link that opens
the operator session's Plans tab — its project's plans are its tasks. A task row
adds 👷 builder (tap: its chat), 📋 watched plan (tap: its detail, via the
`watchPlanUuid` the summary resolves), ⏰ next check and ⏳ waiting-on. Everything
rides `plan_summary`, so the phone never asks for full records.

```mermaid
sequenceDiagram
    participant U as User
    participant O as Operator
    participant S as Builder session
    U->>O: build G
    O->>S: session_send_text (task) or session_create (task, initialPrompt)
    Note over O: Helm opens the task plan + interval timer
    loop every check
        O->>S: check progress, update waitingOn
    end
    S-->>O: done
    O->>O: plan_complete (Helm cancels the timer)
    O->>U: ring_user (if asked)
```

## Limitations

- Desktop voice: the transcript holds only this run's lines (the phone
  keeps history); no barge-in — a reply that arrives while you talk is spoken
  after the one before it, and in a hands-free call it pauses the mic even
  mid-sentence. The VAD threshold is a fixed energy level, not calibrated.
  Not yet judged live (needs a restart + a real call).

- Not yet judged on a device: routing, screen-off survival, BT switching and
  hang-up from the notification need the manual adb check in P-0834's
  acceptance criteria.
- The small Vosk model is less accurate than Google's recogniser; a larger
  model (~128 MB more) is the upgrade path.
- Barge-in quality depends on the phone's echo canceller; on speaker, a loud
  reply can still leak two words and cut itself off.
