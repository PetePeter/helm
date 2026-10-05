# Changelog

All notable changes to Helm are documented in this file.

## [4.5.0] - 2026-10-05

### Features

- Stream API-backed chat completions and apply each model's configured temperature.
- Show thought-round and tool-call counts on completed API reply badges.
- Add an opt-in keep-warm control that sends bounded heartbeat prompts before a CLI prompt cache expires.
- Ship updated Claude, Codex, and Copilot shell guardrail explanations, including the coarse command-text match behavior.

### Improvements

- Preserve bounded keep-warm heartbeat markers when compacting transcripts.
- Carry context, thought, and tool counts through the Android chat wire format and saved message history.
- Improve shell guardrail documentation and keep the shipped provider defaults aligned.

## [3.0.0] - 2026-08-27

### Features

- **Docking workspace** — Arrange Sessions, Scheduler, Quick Spawn, planner views, Terminal, Overview, Plan Screen, and Artifacts in recursive splits and tab groups.
- **Persistent layouts** — Dock moves, tabs, splits, collapse state, and autohide rails survive restart, with Reset Layout available from the View menu.
- **Safe terminal adoption** — Moving a terminal pane preserves the existing xterm host, PTY ownership, scrollback, session switching, and artifact bindings.
- **Drag and drop** — Move panes to tab groups or workspace edges with live previews, pointer capture, keyboard equivalents, and no-op safeguards.

### Distribution

- **Windows x64** — The v3.0.0 release is packaged as a Windows NSIS installer.

## [2.2.0] - 2026-08-10

### Features

- **Caller-bound self-timers** — MCP direct schedules can target `"caller"`, resolving the authenticated Helm session once and retaining that target across restarts. The schedule editor reopens with the correct target session selected.
- **Session locks** — Sessions can be durably locked or unlocked through `session_set_locked`. Locks prevent deliberate closure from the desktop, MCP, Telegram, runtime-group close, and force restart.

### Improvements

- **Clear lock visibility** — Locked sessions display a lock indicator and disable their desktop close control. Process-exit cleanup remains safe, while force restarts explicitly reject locked sessions.

## [1.9.0] - 2026-06-16

### Features

- **Scheduled Task History** — 7-day rolling run log of every scheduled-task fire. Each run captures an immutable setup-snapshot (no PTY output). New "Past Schedules" modal (🕘 split-button) groups runs by day with outcome badges, and "↻ Recreate as new" prefills the create popup from a past run.
- **Auto-resume sessions on restart** — Sessions are preserved and auto-resumed by default when Helm restarts.
- **Telegram voice** — New `telegram_send_voice` MCP tool with Helm-side TTS.

### Fixes

- **Working-dir validation** — MCP working directories and scheduler `dirPath` are validated against known projects on create/update; directories are reconciled when a project is created/updated.
- **Telegram caller identity** — `telegram_chat` now requires a verified caller identity and routes to the authenticated caller's session.
- **Project working dir** — Creating a project auto-registers its directory as a working directory.

## [1.8.1] - 2026-06-13

### Features

- **Copy session ID** — New link button on session card top-row for quick clipboard copy of session ID

### Fixes

- **MCP port clash on relaunch** — Prevents the MCP server from failing to bind when Helm is restarted quickly
- **Hidden PTY delivery** — Nudges non-visible recipient PTY with a transient resize before inter-session delivery

## [1.8.0] - 2026-06-03

### Features

- **Editable prompt button in tool editor** — Replace Helm init checkbox with an editable prompt button for per-CLI initial prompt customization
- **Snapout number accelerators** — Ctrl/Alt+number keyboard shortcuts work in popout (snapped-out) windows

### Fixes

- **Jump number positioning** — Move jump number to column 0, left of name in directory/CLI selectors

## [1.7.3] - 2026-05-20

### Features

- **Open plans as read-only Markdown** — Selecting a plan now exposes an action that writes the plan to a temp file and opens it in the OS default Markdown handler via `plan:open-external`.

### Improvements

- **MCP plan attachment file paths** — `plan_attachment_add` now requires a `filePath` parameter instead of inline base64 data, keeping MCP payloads lean and compatible with large files.
- **MCP guidance clarity** — `notify_user` routing description and directory listing guidance updated to reduce agent ambiguity.
- **Standalone Helm contexts** — `SequencePanel` now makes explicit that contexts without a linked sequence are standalone and usable across plans.

### Fixes

- **DraftEditor resize persistence** — Draft editor panel height is correctly saved and restored across sessions.
- **Chip action delete confirmation** — The delete path in `ChipbarActionsTab` now correctly shows a confirmation step before removing an entry.
- **Alternate folder picker identity** — Directory service no longer drops the alternate picker's resolved identity when switching between session directories.

## [1.7.2] - 2026-05-18

### Features

- **Skill activation MCP workflow** - Added trigger-based skill discovery and activation so agents can load the right user-managed guidance for the current task.
- **Telegram capability reporting** - `session_info` now exposes local Telegram voice, speech, and attachment capability paths for agent workflows.
- **Session capability detection** - Added detection coverage for local transcription and attachment tooling used by Telegram-mode sessions.

### Improvements

- **MCP tool consolidation** - Refactored localhost MCP definitions and dispatch into dedicated tool modules, reducing duplicated dispatch logic.
- **Session info response shape** - Streamlined `session_info` skill summaries to compact `id`, `name`, and `triggerWhen` fields.
- **Skills UI metrics** - Skill cards now surface use counts and ratings consistently, including system skills.
- **Telegram attachments** - Replaced inline base64 attachment delivery with file-path based forwarding for cleaner MCP payloads.

### Fixes

- Fixed MCP type issues found during post-merge review.
- Fixed release publishing so uninstaller stubs and HTML assets are not uploaded as GitHub release assets.
- Removed the generated skill analytics file from repo tracking.

## [1.6.0] - 2026-05-17

### Features

- **Telegram voice transcription** — Incoming Telegram voice messages are automatically transcribed via OpenWhispr and forwarded to the active session as text
- **Telegram attachment forwarding** — Images, documents, and audio received in Telegram are downloaded and forwarded to the active session with full metadata
- **Telegram reaction forwarding** — Emoji reactions on messages are forwarded to the active session as context signals
- **Session channel affinity** — Telegram messages are now routed to the correct session automatically based on established channel affinity, removing the need to manually target sessions

### Improvements

- **Live config reload for Telegram and Scheduler** — Changing Telegram or scheduler settings takes effect immediately without a restart
- **Delivery verification** — Helm prompt delivery is now verified end-to-end before considering a send complete
- **Cleaner Telegram mode handling** — Repeated `[HELM_TELEGRAM_MODE]` wrappers are suppressed; background session sends submit directly without envelope overhead

### Fixes

- Fixed audio transcription accuracy and delivery edge cases
- Fixed Telegram attachment download paths on Windows
- Fixed inter-session delivery pacing to prevent message pile-up
- Fixed Telegram topic cleanup crash on session close
- Fixed planner context editor crash
- Fixed planner context linking reliability
- Fixed notification dismiss button alignment
- Fixed padded plan reference normalisation

## [1.5.0] - 2026-05-11

### Features

- **First-class Project identity** — Helm planning data now belongs to stable Projects instead of raw directory paths, so related work can survive repo moves and multi-worktree setups
- **Automatic project migration** — Existing plans, sequences, and persisted sessions migrate on first run into the new project-aware model with recovery markers and safety backups
- **Multi-worktree project consolidation** — Multiple worktrees of the same git repo now resolve to one shared project backlog while sessions keep their real branch/worktree execution directory
- **Project-aware MCP and UI surfaces** — MCP session and directory summaries plus the sessions UI, overview, and planner shortcuts now prefer canonical project identity over raw cwd grouping
- **Detachable planner window** — The planner can open in a fully usable pop-out window
- **Persistent Helm completion notifications** — Completed plan flows can surface stronger in-app guidance for testing and next-step follow-ups

### Improvements

- **Planner editor correctness** — Better resize behavior, edit-target ownership, refresh timing, and filter persistence in the plan editor flow
- **Context card reliability** — Context CRUD, binding, persistence, and inspector ordering are more stable and predictable
- **Session list behavior** — Selection, ordering, snap-out state, and startup restore are more coherent across reloads and view switches
- **Chip bar simplification** — Removed obsolete draft/apply affordances and tightened remaining plan-chip behavior
- **Helm MCP plan guidance** — `plan_get` exposes better lightweight context metadata and project-aware planning surfaces behave more consistently for agents

### Fixes

- Fixed planner popup reset and debug-button behavior
- Fixed planner context refresh races and stale context UI updates
- Fixed session-list hit testing, ordering drift, and overview click-to-session navigation regressions
- Fixed startup session restore flicker and silent disappearance issues
- Fixed packaged-install identity paths so Helm data stays out of legacy locations
- Fixed MCP delivery and plan-follow-up behavior around plan completion workflows

### Migration Notes

- On first launch after upgrading, Helm migrates legacy dir-owned planning data into project-aware ownership and writes `projects.json`
- Existing sessions keep their exact `workingDir`, but shared planning/grouping can now follow canonical project roots across worktrees
- Multi-worktree repos should now appear as one shared planning backlog instead of separate per-worktree backlogs

## [1.4.6] - 2026-05-01

### Features

- **Telegram rewrite** — Complete overhaul of the Telegram bot in 6 stages:
  - Stage 1: Removed old modules (mirror, commands, summarizer, keyboard, text-input)
  - Stage 2: Collapsible setup guide in Telegram settings
  - Stage 3: RelayService rewritten as a simple broker
  - Stage 4: Topic lifecycle sync — closing a session auto-closes its Telegram topic
  - Stage 5: MCP tool consolidation (3 tools: status, chat, close)
  - Stage 6: Talk button on pinned dashboard for quick session access
- **LLM-directed notifications** — Sessions can route notifications to other sessions, Telegram, or Windows toasts with smart delivery routing. The AI decides where notifications go based on context and urgency
- **Configurable submit suffix (submitSuffix)** — Per-CLI text terminator setting (escape notation: `\r`, `\n`, `\r\n`, `\t`). Applied in Helm inter-session messages and clipboard paste delivery. Each CLI type knows its own input protocol
- **Ctrl+Tab exits plan screen** — Pressing Ctrl+Tab while in the planner navigates directly to the target session, skipping the sessions screen
- **helmPreambleForInterSession** — Toggle whether `[HELM_MSG]` envelopes wrap inter-session messages. Configurable per-session in settings
- **Plan attachments + sequence memory MCP guidance** — `session_info` now returns plan attachment discovery guide and sequence memory write patterns for coordinated multi-agent work

### Fixes

- **submitSuffix race condition** — Eliminated race where submitSuffix could execute before bracketed paste completes by routing through atomic `deliverBulkText` path
- **submitSuffix IPC propagation** — Wired submitSuffix through the full IPC chain (renderer → preload → App.vue) so Helm messages actually reach the terminal with the correct suffix
- **Inter-session message auto-execution** — Helm messages now use submitSuffix option instead of relying on delivery-layer line endings, fixing bracketed paste regression across all CLI types
- **Typed newline for message execution** — Inter-session messages append a newline for reliable auto-execution on all CLI types
- **helmPreambleForInterSession persistence** — Fixed unchecked toggle not saving to config

### Refactoring

- **Plan attachments, helm control service, and UI improvements** — Consolidated plan attachment workflow, improved helm control service structure
- **Removed dead hook calls** — Cleaned up stale hook invocations in Telegram orchestrator and handlers
- **Removed legacy Telegram tests** — Deleted tests for removed modules (terminal-mirror, reply-keyboard, text-input, topic-input, output-summarizer, patterns-button)

### Style

- **Date format standardization** — Plan item cards and metadata now use `yyyy/mm/dd` format (with `HH:mm` for datetime) instead of browser locale formatting

### Tests

- Added 170 tests for `parseSubmitSuffix` (Helm + renderer implementations)
- Added 79 integration tests for submitSuffix paste routing
- Added 44 tests for pinned dashboard
- Added 34 tests for plan attachment manager
- Added 180 tests for date format utilities
- Added 141 tests for build-tool-editor-options store
- Added 43 tests for Telegram topic manager
- Total test count grew from ~2700 to 2826

## [1.2.4] - 2026-04-23

### Features
- **Keyboard Shortcuts** — Add Ctrl+N (new session) and Ctrl+W (close session) for quick keyboard control alongside gamepad bindings
- **Auto-save Indicators** — Plan and draft editors now auto-save with visual save indicators
- **Sequence Parser Expansion** — Comprehensive test coverage for sequence parser and chipbar templates

### Fixes
- **Settings UX** — Fixed settings panel user experience issues
- **Packaged Icon Handling** — Corrected icon handling in packaged builds
- **Startup Splash** — Fixed startup splash screen ownership and rendering
- **Modal Keyboard Navigation** — Unified modal keyboard interception and focus handling across all modal types

### Refactoring
- **Modal Input Consolidation** — Consolidate modal keyboard input through shared modal stack bridge for consistency
- **Legacy Code Removal** — Remove legacy quick-spawn and dir-picker paths to simplify codebase
- **Test Updates** — Update chip bar specs for current store and component APIs

## [1.2.3] - Previous Release

See git history for previous releases.
