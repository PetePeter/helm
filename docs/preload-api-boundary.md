# Preload API Boundary

The renderer still reaches Electron through `contextBridge`. The migration target is not to bypass the window boundary, but to replace the broad `window.gamepadCli` facade with owned domain clients under `window.helm.<domain>`.

`src/electron/preload-api-contract.ts` is the checked-in inventory for the current legacy surface. `tests/preload-api-contract.test.ts` parses `src/electron/preload.ts` directly and fails when a legacy method is added without a domain assignment.

## Compatibility Policy

- Keep `contextBridge` as the only Electron exposure boundary.
- Keep `window.gamepadCli` as a compatibility facade until external/test callers migrate.
- Additions to the legacy facade must be assigned to exactly one target domain.
- New renderer code must use `renderer/ipc/clients.ts` instead of `window.gamepadCli`.

## Legacy Allowlist

Direct `window.gamepadCli` references are allowed only in:

- `renderer/ipc/clients.ts`, the compatibility fallback adapter.
- `src/electron/main.ts`, the startup preload smoke check.
- `src/electron/preload-api-contract.ts`, the policy text tested by the contract suite.

`tests/preload-api-contract.test.ts` enforces this list across `renderer` and `src/electron`.

## Target Domains

| Target | Ownership |
| --- | --- |
| `window.helm.app` | app version and startup lifecycle readiness |
| `window.helm.sessions` | session selection, lifetime, snap-out/snap-back, rename, and state |
| `window.helm.terminal` | PTY spawn, write, resize, scroll input, switching marks, and kill |
| `window.helm.delivery` | queued pipeline operations |
| `window.helm.config` | bindings, sequences, chip bar, notifications, MCP config, ESC protection, sort/filter/group prefs, working directories, spawn commands, CLI env, editor prefs, and the dock workspace layout |
| `window.helm.tools` | configured CLI tools and their ordering |
| `window.helm.profiles` | profile list, active profile, switching, creation, and deletion |
| `window.helm.projects` | project list, CRUD, and directory membership |
| `window.helm.plans` | plan CRUD, dependencies, apply/complete/reopen/state, legacy startable/doing query names for ready/coding data, sequences, and planner pop-out |
| `window.helm.contexts` | plan context CRUD, append, position, bind, and unbind |
| `window.helm.attachments` | plan attachment list, presence, add, delete, and open |
| `window.helm.incoming` | incoming plan files, plan export, and plan file read/write |
| `window.helm.drafts` | draft prompt CRUD/count and draft editor history |
| `window.helm.scheduler` | scheduled task CRUD/list/get/cancel |
| `window.helm.patterns` | pattern CRUD and pattern schedule cancellation |
| `window.helm.keyboard` | key tap, combo send/down/up, and typed string |
| `window.helm.dialog` | folder/file dialogs, external editor, and temporary content files |
| `window.helm.system` | OS-level utility actions such as opening logs |
| `window.helm.events` | renderer subscriptions for PTY, delivery, notifications, sessions, plan, incoming, pattern, and scheduler events |

## Current Legacy Inventory

The exhaustive current-method list lives in `PRELOAD_API_DOMAINS`. That source is intentionally code, not prose, so review and CI catch drift whenever the preload facade changes.
