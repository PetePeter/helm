# File Structure

Complete directory tree with per-file descriptions.

## Source (`src/`)

```
src/
├── electron/
│   ├── main.ts                 # Electron main: window creation, IPC setup, lifecycle, renderer crash recovery, delegates power monitoring to setupPowerMonitor()
│   ├── preload.ts              # Context bridge (renderer ↔ main IPC)
│   └── ipc/
│       ├── handlers.ts         # Orchestrator — imports + wires 10 domain handlers, returns { cleanup, sessionManager, ptyManager }. Auto-bookmarks working dir on session:removed (when cliSessionName present)
│       ├── session-handlers.ts
│       ├── config-handlers.ts
│       ├── profile-handlers.ts
│       ├── tools-handlers.ts
│       ├── keyboard-handlers.ts
│       ├── pty-handlers.ts
│       ├── system-handlers.ts  # system:openLogsFolder
│       ├── telegram-handlers.ts # Telegram bot settings CRUD, bot start/stop IPC
│       ├── draft-handlers.ts   # 5 IPC channels (draft:create/update/delete/list/count) wired to DraftManager
│       ├── plan-handlers.ts   # 12 IPC channels (plan:list/create/update/delete/addDep/removeDep/apply/complete/startableForDir/doingForSession/deps/getItem) wired to PlanManager; startable/doing names are legacy ready/coding query names
│       ├── mess-handlers.ts   # Cursor-neutral mess:history plus project-scoped mess:appended push; read-only renderer boundary
│       ├── handover-handlers.ts # handover:cancel/pending + armed/delivered/lost forwarding for the compaction terminal lock
│       └── mobile-handlers.ts  # 9 IPC channels (mobile:list/setEnabled/setAllowList/revoke/startPairing/confirmPairing/cancelPairing/pairingState/apkRelease). Secrets never cross this boundary
├── input/
│   └── sequence-parser.ts      # {Enter}, {Ctrl+C}, {Wait 500}, {Mod Down/Up}, {{/}} — used by bindings + initialPrompt
├── output/
│   └── keyboard.ts             # OS-level key simulation via robotjs (voice bindings only)
├── session/
│   ├── manager.ts              # Session tracking (EventEmitter), calls persistence on changes
│   ├── persistence.ts          # Save/load/clear sessions to config/sessions.yaml + saveDrafts/loadDrafts to config/drafts.yaml + plan file I/O for config/plans/*.json + config/plan-dependencies.json
│   ├── pty-manager.ts          # PTY process management (node-pty: cmd.exe on Windows, bash on Unix)
│   ├── delivery-lock.ts         # Per-session gate serializing the nudge/payload/settle/submit delivery transaction
│   ├── bracketed-paste-tracker.ts # Per-session DEC 2004 state scanned from PTY output (incremental, chunk-boundary safe)
│   ├── state-detector.ts       # PTY activity tracking + question markers; AIAGENT phase state is MCP-owned + markRestored() grace period for restored sessions
│   ├── handover-delivery.ts    # Holds a session_compact handover across the compaction; pastes it back on the first inactive edge (floor 15s / ceiling 5min)
│   ├── pipeline-queue.ts       # Waiting→implementing auto-handoff queue (FIFO)
│   ├── notification-manager.ts # Windows toast notifications (Electron Notification API, activity-change triggers for implementing/planning sessions, dedup, click-to-focus)
│   ├── initial-prompt.ts       # Sequence syntax → PTY escape codes, configurable delay, onComplete callback
│   ├── draft-manager.ts        # Per-session draft prompt CRUD (EventEmitter, emits draft:changed, persisted to config/drafts.yaml)
│   ├── plan-manager.ts         # Per-directory plan DAG CRUD (EventEmitter, emits plan:changed, cycle prevention via DFS, ready-state computation, persisted to config/plans/*.json)
│   ├── mess-manager.ts         # Project-scoped durable coordination, ordered unread cursors, bounded history, and mess:appended events
│   ├── mess-persistence.ts     # Per-project JSONL log plus atomic cursor metadata, retention pruning, compaction recovery, and corruption diagnostics
│   ├── mess-notifier.ts        # Best-effort idle reminders with append-while-idle detection, cooldown, retry, and system delivery verification
│   ├── persistence-paths.ts    # Stable per-user app-data paths, including the UUID-keyed Mess directory and log/cursor files
│   ├── session-alert.ts        # States ONCE which session transitions are worth a buzz, and the `kind` each maps to. Read by both Telegram and the phone
│   ├── chat/
│   │   ├── chat-bridge.ts      # The interface one chat surface implements, whatever transport is underneath
│   │   ├── chat-broker.ts      # The registry surfaces plug into; fan-out is unconditional and the registry is unbounded
│   │   └── chat-bindings.ts    # Provider-keyed map of where a session lives on each surface; unknown keys survive a round-trip
│   ├── prompt-template-types.ts        # PromptFolder / PromptTemplate / PromptNode model + isFolder type guard
│   ├── prompt-template-manager.ts      # Global nested prompt-template tree CRUD (EventEmitter, emits prompt-template:changed; folders nest, templates are leaves)
│   ├── prompt-template-persistence.ts  # YAML load/save to config/prompt-templates.yaml (global)
│   ├── prompt-template-migration.ts    # One-time fold of legacy per-profile sequences groups into the prompt-template tree
│   └── power-monitor.ts        # Suspend/resume/shutdown diagnostics — session counts, PTY IDs, survival status
├── config/
│   └── loader.ts               # Self-contained profile YAML config + CRUD + StickConfig + haptic settings + auto-migration + bookmark CRUD (addBookmarkedDir/removeBookmarkedDir) + ChipbarAction interface + chipActions profile field + getChipbarActions()
├── mcp/
│   ├── guides/
│   │   └── mess-guide.ts       # Agent-facing Mess tool rules and local-only/social-coordination constraints
│   └── services/
│       └── helm-mess-service.ts # Authenticated mess_post/check/history facade and compact wire-shape conversion
├── mobile/                      # The Helm half of the phone link. See docs/mobile-app.md
│   ├── ble/
│   │   ├── characteristics.ts  # GATT UUIDs, directions stated from HELM's POV (so they invert on the phone). CTL is declared and RESERVED-BUT-UNUSED
│   │   ├── ble-framing.ts      # The only layer that knows a GATT write is not a stream — chunk/reassemble, seq detects a dropped notification
│   │   ├── ble-link-client.ts  # Helm's BLE central; the only file that talks to noble. Emits a BleLink (identity + BytePipe); no GATT type escapes
│   │   ├── noble-adapter.ts    # The single lazy load of the real radio, behind the NobleApi interface that keeps the client testable
│   │   └── framing-vectors.ts  # Generates tests/fixtures/ble-framing-vectors.json — regenerating is a WIRE BREAK
│   ├── secure-channel.ts       # Authenticated encrypted channel over ANY BytePipe; zero BLE awareness. Reuses mcp/peer/pairing-crypto.ts verbatim
│   ├── aead.ts                 # AES-256-GCM framing; per-direction keys, counter nonce never transmitted, refuse at exhaustion, no resync
│   ├── protocol-version.ts     # Range negotiation, decoupled from product versions. A breaking change bumps PROTOCOL_MAX + adds a history row
│   ├── test-vectors.ts         # Generates tests/fixtures/secure-channel-vectors.json — regenerating is a WIRE BREAK
│   ├── mobile-pairing.ts       # Drives start → offerLink → SAS → confirm → persisted. NOT a second crypto exchange, by design
│   ├── mobile-device-store.ts  # Paired-phone registry + per-device allow list. Keyed on machineId, never the rotating BLE address. Holds no secrets
│   ├── mobile-device-sanitize.ts   # The ONE sanitizer shared by the loader and importAll, so machineId can never be silently dropped
│   ├── mobile-device-persistence.ts # The ONE reader/writer of mobile-devices.yaml + mobile-secrets.yaml (PSKs, mode 0600)
│   ├── mobile-link-manager.ts  # Owns the BLE lifecycle — scan, authenticate with a STORED PSK, identify, keep or drop, report online state
│   ├── mobile-gate.ts          # The security boundary for a phone's MCP calls: deny by default, no impersonation, rate limited, audited
│   ├── mobile-identity.ts      # Synthesizes the mobile:<deviceId> proxy AuthContext. The prefix is not part of any UUID, so it cannot impersonate
│   ├── mobile-audit-log.ts     # 7-day rolling decision trail — argument KEY NAMES and error TYPES only, never values
│   ├── mobile-audit-persistence.ts # The ONE reader/writer of mobile-audit.yaml, atomic at mode 0600, defensive prune on load
│   ├── mobile-envelope.ts      # The four application records (call/result/error/chat). Deterministic encoding; a field or key-order change is a wire break
│   ├── mobile-envelope-vectors.ts  # Generates tests/fixtures/mobile-envelope-vectors.json — regenerating is a WIRE BREAK
│   ├── mobile-chat-bridge.ts   # The phone as a ChatBridge, and the ONE inbound path from a phone into Helm's tools (always via MobileGate)
│   ├── mobile-alert-notifier.ts    # Session state / notify_user / flash_attention → a kind-bearing chat record over the open link. No dedup, deliberately
│   └── apk-release.ts          # Resolves the GitHub release asset URL for the RUNNING version, never `latest`. Availability is three-valued
├── telegram/
│   ├── bot.ts                  # TelegramBotCore — bot lifecycle (start/stop), long-polling, user-ID whitelist, message helpers, deleteForumTopic
│   ├── callback-handler.ts     # Inline keyboard callback routing — session controls, spawn wizard, close all, text input
│   ├── commands.ts             # Slash command handlers (/status, /switch, /send, /close, /spawn, /output)
│   ├── keyboards.ts            # Inline keyboard layout builders (session list, controls, commands, spawn wizard)
│   ├── notifier.ts             # State change → Telegram notification messages with inline keyboards. NOTE: `handleStateChange` has no production caller — orchestrator.ts takes the notifier as `_notifier`, so Telegram's state-change notifications have never fired. The live path is session-alert.ts → MobileAlertNotifier
│   ├── openwhispr-transcriber.ts # OpenWhispr-backed audio attachment transcription, writes transcript files beside downloads
│   ├── orchestrator.ts         # Telegram module factory — wires bot, topic manager, notifier, terminal mirror, dashboard
│   ├── output-summarizer.ts    # PTY buffer → 3-5 line smart summary
│   ├── pinned-dashboard.ts     # Auto-updating pinned message with all-sessions status + Close All button
│   ├── reply-keyboard.ts       # Persistent reply keyboard for most-used actions
│   ├── terminal-mirror.ts      # Activity-gated PTY→Telegram mirror: buffers output, flushes on activity/state/question triggers, ANSI+noise stripping, dedup guard
│   ├── text-input.ts           # Free-text input with confirmation step
│   ├── topic-input.ts          # Topic message → PTY stdin forwarding
│   ├── topic-manager.ts        # Forum topic lifecycle: ensureTopic on session:added, deleteForumTopic on session:removed
│   └── utils.ts                # Shared Telegram utilities
├── types/
│   ├── session.ts              # SessionInfo (includes cliSessionName for resume), DraftPrompt, SessionChangeEvent, AnalogEvent types
│   ├── plan.ts                 # PlanItem, PlanDependency, PlanStatus ('planning'|'ready'|'coding'|'review'|'blocked'|'done'), DirectoryPlan, PlanSequence types
│   ├── mess.ts                 # Durable project Mess Entry and ordered Cursor wire/domain types
│   └── mobile-device.ts        # Persisted paired-phone record + pairing-state wire types. Carries pskRef only, never a PSK
└── utils/
    └── logger.ts               # Winston logger (daily rotation, used everywhere)
```

## Renderer (`renderer/`)

```
renderer/
├── index.html                  # Main UI template — sidebar header has ⚙ (settings) and 🐛 (open logs folder) buttons
├── main.ts                     # Entry point — init, wiring, DOMContentLoaded, terminal manager, auto-resume (queries sessionGetAll, removes stale sessions, spawns with resumeSessionName via doSpawn)
├── state.ts                    # Shared AppState type + singleton (currentScreen, sessions, activeSessionId, etc.)
├── utils.ts                    # DOM helpers, logEvent, showScreen, toDirection
├── bindings.ts                 # Config cache, binding dispatch (PTY-aware routing, voice OS-default + PTY via target: 'terminal', F1-F12 VT220 escape sequences)
├── paste-handler.ts            # Document-level Ctrl+V interceptor → clipboard text → active PTY (blocked during plan screen)
├── navigation.ts               # Gamepad navigation setup, event routing. Priority chain: sandwich → dirPicker → bindingEditor → formModal → closeConfirm → quickSpawn → draftEditor → draftAction → draftSubmenu → contextMenu → promptTree → planScreen (within sessions case) → overview → screen routing → configBinding fallback
├── gamepad.ts                  # Browser Gamepad API wrapper + repeat engine
├── session-groups.ts           # Pure session grouping logic (by working directory) — types, grouping, nav list, reorder, bookmarked dirs
├── sort-logic.ts               # Pure sort functions for sessions + bindings
├── state-colors.ts             # Activity-level-to-color mapping (getActivityColor, ACTIVITY_COLORS). Used by session cards + overview grid.
├── tab-cycling.ts              # Ctrl+Tab / Ctrl+Shift+Tab terminal cycling resolver
├── components/
│   ├── index.ts                # Barrel export of all Vue SFC components
│   ├── sort-control.ts         # Reusable sort dropdown + direction toggle widget
│   ├── chip-bar.ts             # Thin wrapper composing draft-strip + plan-chips
│   ├── modals/
│   │   ├── index.ts
│   │   ├── CloseConfirmModal.vue
│   │   ├── PlanDeleteConfirmModal.vue
│   │   ├── PromptTreeModal.vue        # Prompt-template picker tree (progressive disclosure; accelerators 1-9,0,a-z)
│   │   ├── QuickSpawnModal.vue
│   │   ├── DirPickerModal.vue
│   │   ├── ContextMenu.vue
│   │   ├── DraftSubmenu.vue
│   │   ├── FormModal.vue
│   │   ├── BindingEditorModal.vue
│   │   └── MobilePairingDialog.vue    # SAS 6-digit compare for a pairing phone; the digits are a KDF output, safe to display
│   ├── sidebar/
│   │   ├── index.ts
│   │   ├── SessionCard.vue     # Session card (activity dot, badges, timer, rename, close)
│   │   ├── SessionGroup.vue    # Collapsible directory group header
│   │   ├── SpawnGrid.vue       # 2-column CLI spawn button grid
│   │   ├── SortBar.vue         # Sort field dropdown + direction toggle
│   │   ├── PlansGrid.vue       # Per-directory plan buttons with badges
│   │   ├── StatusStrip.vue     # Gamepad dot, count, profile badge
│   │   ├── SettingsPanel.vue   # Settings slide-over with tab switching
│   │   ├── ProfilesTab.vue     # Profile list CRUD
│   │   ├── BindingsTab.vue     # Per-CLI binding list
│   │   ├── ToolsTab.vue        # CLI type management
│   │   ├── TelegramTab.vue     # Telegram bot configuration
│   │   └── MobileTab.vue       # Paired phones (enable / allow-list / revoke) + the APK QR and version-pinned URL
│   ├── dock/
│   │   ├── MessPane.vue        # Read-only project Mess observer pane
│   │   └── PopOutTerminalPane.vue # Snap-out terminal: owns its own TerminalView + PTY attach
│   └── panels/
│       ├── index.ts
│       ├── TerminalPane.vue    # xterm.js lifecycle wrapper
│       ├── OverviewCard.vue    # Session preview card
│       ├── OverviewGrid.vue    # Scrollable preview grid
│       ├── PlanScreen.vue      # SVG DAG canvas + editor
│       ├── MainView.vue        # Right panel view switcher
│       └── ChipBar.vue         # Draft pills + plan chips strip (chips/ChipBar.vue; mounted via chips/TerminalChips.vue inside the terminal pane)
├── stores/
│   ├── index.ts                # Barrel export of all Pinia stores
│   ├── app.ts                  # useAppStore — currentScreen, gamepadCount, eventLog, activeProfile
│   ├── sessions-screen.ts      # useSessionsScreenStore — zone, focusIndex, cardColumn, overviewGroup
│   ├── config.ts               # useConfigStore — cliBindingsCache, cliSequencesCache, cliToolsCache, cliTypes
│   ├── drafts.ts               # useDraftsStore — draftCounts, activeDraft, editorVisible
│   ├── plans.ts                # usePlansStore — planDoingCounts, planStartableCounts
│   ├── chip-bar.ts             # useChipBarStore — chip bar action state + refresh for active session
│   └── navigation.ts           # useNavigationStore — centralized view routing, active session, sidebar focus, overlay lifecycle
├── composables/
│   ├── index.ts                # Barrel export of all composables
│   ├── useHandover.ts          # Reactive mirror of pending compaction handovers; drives the terminal lock
│   ├── useModalStack.ts        # Reactive push/pop modal stack replacing 11-deep if-chain
│   ├── useIpc.ts               # Typed IPC wrappers with auto-cleanup on unmount
│   ├── useGamepad.ts           # Gamepad polling setup + connection events
│   ├── usePanelResize.ts       # Splitter drag resize via template refs
│   ├── useKeyboardRelay.ts     # Ctrl+V → PTY, Ctrl+G → Prompt Editor intercepts
│   ├── usePromptApplyFlow.ts   # Shared prompt-template apply flow (picker tree → prefill Prompt Editor → deliverPromptSequence). Used by main + popout windows
│   ├── useTerminals.ts         # Terminal create/switch/destroy lifecycle
│   ├── useNavigation.ts        # Navigation routing: sandwich → modal stack → view → screen → config binding
│   ├── useMessPane.ts          # Project-following Mess history, filters, append subscription, labels, and bounded backscroll
│   └── useMobileDevices.ts     # Module-singleton mirror for Settings → Mobile (paired phones, pairing state, APK release). Displays SAS digits — a KDF output; no PSK ever reaches the renderer
├── drafts/
│   ├── draft-strip.ts          # Draft strip above terminal — draft pills (click opens editor) + plan chips + right-aligned chip-bar action buttons (renderActionButtons, invalidateChipActionCache, resolveTemplates)
│   └── draft-editor.ts         # Slide-down draft editor panel (title + content, Save/Apply/Delete/Cancel buttons)
├── plans/
│   ├── plan-screen.ts          # SVG canvas screen — pan/zoom (viewBox-based), node rendering with status colors, quadratic bezier arrows, click-to-select, Add Node button. Renders inside #mainArea as .plan-screen overlay
│   ├── plan-layout.ts          # Sugiyama-style left-to-right layered auto-layout. Exports computeLayout(items, deps) → LayoutResult with nodes (id, x, y, layer, order) and width/height
│   └── plan-chips.ts           # Plan badges on session cards (createPlanBadge) + plan chips in draft strip (renderPlanChips with generation counter dedup). Shows ready/coding/review/blocked counts
├── terminal/
│   ├── terminal-view.ts        # xterm.js wrapper (fit/search/weblinks addons)
│   ├── terminal-manager.ts     # Multi-terminal orchestration (create/switch/rename/resize/destroy + tab bar + PtyOutputBuffer + right-click paste prevention + pty:markSwitching before fit)
│   ├── pty-filter.ts           # Strips mouse-tracking + alternate-scroll escape sequences from PTY output
│   └── pty-output-buffer.ts    # Ring buffer for PTY output — last N lines per session, ANSI-stripped, for preview display
├── screens/
│   ├── sessions.ts             # Sessions screen orchestrator: group init, collapse/reorder actions, removeBookmark action, navigation, public API. Re-exports from sessions-spawn and sessions-plans.
│   ├── sessions-spawn.ts       # doSpawn(), PTY creation, terminal area visibility, spawn zone navigation, D-pad Right → group overview entry (col 0 on group-header); Plans button at col 1 (maxCol 1)
│   ├── sessions-state.ts       # Sessions screen navigation state (sessions/spawn/plans zones, overviewGroup + overviewFocusIndex + plansFocusIndex)
│   ├── group-overview.ts       # Group overview grid — session preview cards with live PTY output, entry/exit/navigation, max ~5 cards visible
│   └── sessions-plans.ts       # Folder planner grid zone (3rd nav zone below spawn) — shows working directories with plan badges, gamepad 2-column grid navigation, click opens plan screen
├── sidebar/
│   └── session-services.ts     # Sidebar session services: sort preferences, rename flow, status counts
├── modals/
│   ├── modal-base.ts           # Shared modal foundation (show/hide, backdrop, gamepad focus management, Tab/Shift+Tab button cycling in selection mode)
│   ├── dir-picker.ts           # Directory picker modal (supports pre-selection via preselectedPath)
│   ├── binding-editor.ts       # Binding editor modal
│   ├── context-menu.ts         # Context menu overlay — Copy/Paste/Compose in Editor/New Session/New Session with Selection/⚡ Prompts…/Drafts ►/Cancel. "⚡ Prompts…" routes into the prompt-template picker (`components/modals/PromptTreeModal.vue`) → in-app Prompt Editor (`EditorPopup.vue`) flow
│   ├── close-confirm.ts        # Close session confirmation popup — centered modal with Close/Cancel, warns about unsent drafts, gamepad + keyboard support
│   ├── quick-spawn.ts          # Quick-spawn CLI type picker — centred modal listing available CLI types with pre-selection, gamepad + click support
│   └── draft-submenu.ts        # Drafts submenu from context menu — New Draft + per-draft Apply/Edit/Delete action picker
└── styles/
    └── main.css
```

## Android app (`android/`)

Self-contained Gradle/Kotlin project for the phone client. It shares no
toolchain with the Node build in either direction — see
[../android/README.md](../android/README.md) for the boundary, the build
commands and the permanent applicationId/keystore rules.

```
android/
├── settings.gradle.kts          # Root + :app, repository declarations
├── build.gradle.kts             # Plugin versions only (apply false)
├── gradle.properties            # AndroidX, JVM args
├── gradle/
│   ├── libs.versions.toml       # Version catalog — AGP, Kotlin, Compose BOM
│   └── wrapper/                 # Gradle wrapper (committed, incl. the jar)
├── gradlew / gradlew.bat
├── local.properties             # GITIGNORED — sdk.dir + release signing material
└── app/
    ├── build.gradle.kts         # applicationId, versionCode derived from ../package.json, signing
    ├── proguard-rules.pro
    ├── src/main/
    │   ├── AndroidManifest.xml  # BLUETOOTH_ADVERTISE (the phone is the peripheral), CONNECT, foreground-service, notifications, audio
    │   ├── kotlin/com/potatomotato/helm/
    │   │   ├── HelmApp.kt       # Application — starts the process-scoped singletons
    │   │   ├── MainActivity.kt  # Compose shell placeholder + permission gate (real UI: P-0740+)
    │   │   ├── crypto/
    │   │   │   ├── Hkdf.kt            # RFC 5869 HMAC-SHA256, pinned to Node's hkdfSync
    │   │   │   ├── X25519Keys.kt      # Ephemeral keys + strict SPKI-DER (Bouncy Castle; JCE XDH is API 33)
    │   │   │   ├── PairingCrypto.kt   # Transcript, commitment, SAS, confirm-MAC, PSK
    │   │   │   ├── Aead.kt            # AES-256-GCM, per-direction keys, implicit counters
    │   │   │   ├── ProtocolVersion.kt # Ranges, refusal codes and their wording
    │   │   │   ├── Frames.kt          # uint32be length | type | payload; length read through a Long
    │   │   │   └── SecureChannel.kt   # Responder half only — Helm is always the initiator
    │   │   ├── data/
    │   │   │   ├── PskStore.kt        # Pairing persistence seam, keyed on machineId
    │   │   │   ├── DeviceKeyStore.kt  # Keystore-wrapped PSK; only ciphertext reaches prefs
    │   │   │   └── PhoneIdentity.kt   # Stable machineId, generated once (never the BLE address)
    │   │   ├── link/
    │   │   │   ├── PairingController.kt # PSK choice, screen state, persist-on-confirm. No Android types
    │   │   │   ├── HelmLinkPipe.kt      # HelmLink as a BytePipe + the timeout's coroutine clock
    │   │   │   └── HelmPairing.kt       # Process-scoped wiring: link up → handshake
    │   │   ├── ui/pairing/
    │   │   │   └── PairingScreen.kt   # Mockup screen 5 — the six-digit SAS comparison
    │   │   └── ble/
    │   │       ├── BleFraming.kt      # Chunker/reassembler — byte-for-byte port of ble-framing.ts
    │   │       ├── HelmGatt.kt        # Service/characteristic UUIDs, mirroring characteristics.ts
    │   │       ├── LinkState.kt       # Advertising / Connecting / Linked / Disconnected
    │   │       ├── BleLinkSession.kt  # All link decisions; no Android types, JVM-testable
    │   │       ├── GattServer.kt      # BluetoothGattServer + BluetoothLeAdvertiser adapter
    │   │       ├── HelmLinkService.kt # Foreground service, type connectedDevice
    │   │       ├── HelmLink.kt        # The duplex byte-stream seam for the layers above
    │   │       └── BlePermissions.kt  # Runtime permissions (no BLUETOOTH_SCAN, by design)
    │   └── res/values/          # strings.xml, themes.xml (true-black window chrome)
    └── src/test/kotlin/…/      # JVM unit tests — no device, no Robolectric
        ├── Fixtures.kt         # Reads tests/fixtures/ IN PLACE via helm.fixtures.dir
        ├── ble/                # Framing + link session, incl. the shared-fixture conformance test
        ├── crypto/             # SecureChannelVectorsTest pins every derivation to the desktop
        └── link/               # PairingController against a real channel and a fake store
```

## Config (`config/`)

```
config/
├── settings.yaml               # Active profile + hapticFeedback toggle + notifications toggle + sessionGroups prefs (order + collapsed + bookmarked)
├── sessions.yaml               # Persisted session state (auto-managed)
├── drafts.yaml                 # Persisted draft prompts per session (auto-managed)
├── plans/                      # Individual per-plan JSON files (auto-managed, folder-level not per-profile)
├── plan-dependencies.json      # Directory plan dependency registry
├── plans/incoming/             # Inbox for importable ready plan JSON artifacts
├── mobile-devices.yaml         # Paired-phone registry — non-secret, holds pskRef references only
├── mobile-secrets.yaml         # Mobile pairing PSKs, base64, mode 0600. Never logged, never sent to the renderer
├── mobile-audit.yaml           # 7-day rolling trail of phone call decisions — argument key names and error types only
└── profiles/
    └── default.yaml            # Self-contained: tools + workingDirectories + bindings + sticks + dpad
```

## Tests (`tests/`)

```
tests/                                  # 61 test files
├── app-paths.test.ts           # Application path resolution tests
├── bindings-pty.test.ts        # PTY escape helpers + routing tests
├── bindings-target.test.ts     # Voice binding target routing (PTY vs OS)
├── callback-handler.test.ts    # Telegram callback handler tests (session controls, spawn, close all)
├── close-confirm.test.ts       # Close confirmation modal tests
├── commands.test.ts            # Telegram slash command handler tests
├── config.test.ts              # Config loading, stick config, haptic, virtual buttons, prompt-tree binding persistence, legacy sequences loader (migration input)
├── context-menu.test.ts        # Context menu overlay tests
├── draft-editor.test.ts        # Draft editor panel tests
├── draft-manager.test.ts       # DraftManager CRUD + events
├── draft-persistence.test.ts   # Draft save/load persistence
├── mess-manager.test.ts        # Project membership, ordered unread cursors, visibility, and cursor-neutral history
├── mess-persistence.test.ts    # JSONL persistence, atomic metadata, sequence recovery, pruning, and diagnostics
├── mess-notifier.test.ts       # Append/idle reminder gating, cooldown, retry, verification, and cleanup
├── mess-mcp.test.ts            # Authenticated Mess service validation and compact wire responses
├── mess-ipc.test.ts            # Renderer history bounds, project routing, and IPC cleanup
├── mess-pane.test.ts           # Pure observer labels, unread projection, and filters
├── draft-strip.test.ts         # Draft strip pill rendering + badge
├── draft-submenu.test.ts       # Draft submenu + action picker tests
├── gamepad-repeat.test.ts      # D-pad/stick key repeat engine tests
├── group-overview.test.ts      # Group overview grid tests
├── handlers-restore.test.ts    # Session restore on startup tests
├── handoff-command.test.ts     # Configurable handoff command tests
├── initial-prompt.test.ts      # Initial prompt delivery tests
├── keyboard.test.ts            # Keyboard simulation
├── modal-base.test.ts          # Modal UI base tests
├── navigation.test.ts          # Navigation priority chain tests
├── navigation-store.test.ts    # Navigation store tests — view routing, session switching, overlay lifecycle, sidebar focus (61 tests)
├── notification-manager.test.ts # NotificationManager tests
├── output-summarizer.test.ts   # Telegram output summarizer tests
├── paste-routing.test.ts       # Ctrl+V paste → PTY routing tests
├── persistence.test.ts         # Session persistence
├── pinned-dashboard.test.ts    # Telegram pinned dashboard tests
├── pipeline-queue.test.ts      # Auto-handoff queue tests
├── power-monitor.test.ts       # Power monitor diagnostics tests
├── pty-filter.test.ts          # Mouse-tracking + alternate-scroll escape sequence stripping tests
├── pty-manager.test.ts         # PTY process management tests
├── pty-output-buffer.test.ts   # PtyOutputBuffer ring buffer tests
├── quick-spawn.test.ts         # Quick-spawn CLI type picker tests
├── reply-keyboard.test.ts      # Telegram reply keyboard tests
├── resume-spawn.test.ts        # CLI session resume spawning tests
├── sequence-parser.test.ts     # Sequence format parser tests
├── components/modals/prompt-tree-modal.test.ts  # PromptTreeModal picker tests (tree disclosure, selection, gamepad navigation, apply flow)
├── session-groups.test.ts      # Session grouping logic tests + bookmark persistence tests
├── session-handlers.test.ts    # session:close → PtyManager routing tests
├── session.test.ts             # Session management
├── sessions-screen.test.ts     # Session cards + group headers + spawn grid navigation + directional buttons
├── sort-logic.test.ts          # Session sort order tests
├── state-detector.test.ts      # AIAGENT phase text ignore tests + activity tracking
├── tab-cycling.test.ts         # Terminal tab cycling tests
├── telegram-bot.test.ts        # TelegramBotCore lifecycle + auth tests
├── telegram-config.test.ts     # Telegram config loading/saving tests
├── telegram-keyboards.test.ts  # Telegram inline keyboard layout tests
├── telegram-notifier.test.ts   # Telegram notification routing tests
├── telegram-topic-manager.test.ts # Topic manager lifecycle tests (ensure/delete topics)
├── terminal-manager.test.ts    # Embedded terminal lifecycle tests (including adoptTerminal)
├── terminal-mirror.test.ts     # Telegram terminal mirror tests
├── text-input.test.ts          # Telegram text input tests
├── topic-input.test.ts         # Telegram topic input forwarding tests
├── plan-manager.test.ts        # PlanManager CRUD, DAG validation, cycle prevention, ready-state computation (42 tests)
├── plan-handlers.test.ts       # Plan IPC handler tests (23 tests)
├── plan-layout.test.ts         # Auto-layout algorithm tests — topological sort, layering, barycenter ordering (17 tests)
├── plan-screen.test.ts         # Plan canvas + editor tests — rendering, pan/zoom, node selection, CRUD (33 tests)
├── plan-chips.test.ts          # Plan badges + chips rendering tests (11 tests)
├── plan-navigation.test.ts     # Plan screen navigation integration + gamepad D-pad/action-button tests
├── sessions-plans.test.ts      # Folder planner grid rendering, badge refresh, gamepad navigation tests
├── utils.test.ts               # Utility function tests
├── pinia-setup.ts              # Global Vitest setup — creates fresh Pinia for each test
├── stores/
│   └── stores.test.ts          # Pinia store tests (app, sessions-screen, config, drafts, plans — 20 tests)
├── composables/
│   ├── composables.test.ts     # Composable unit tests (modal stack, IPC, gamepad, panel resize, keyboard relay, terminals — 21 tests)
│   └── navigation.test.ts     # Navigation composable tests (routing, modal interception, view/screen dispatch — 31 tests)
└── components/
    ├── modals/
    │   └── modals.test.ts      # Vue SFC modal tests (@vue/test-utils — 90 tests)
    ├── sidebar/
    │   └── sidebar.test.ts     # Vue SFC sidebar tests (@vue/test-utils — 106 tests)
    ├── panels/
    │   └── panels.test.ts      # Vue SFC panel tests (@vue/test-utils — 79 tests)
    └── dock/
        └── mess-pane.test.ts   # Mess pane project switching, live append, labels, and read-only rendering
```
