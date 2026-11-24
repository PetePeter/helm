# User Tasks

A board of post-it notes for things only the **user** can do — decide, approve,
test on a device, buy, sign in — written by the user or posted by any AI
session. One board per user profile, shown in the desktop **User Tasks** dock
pane (Ctrl+Shift+U) and on the Android phone and tablet.

Session todos ([todos.md](todos.md)) are the LLM's own steps and die with the
session. User Tasks are the opposite: work the LLM is handing to the user, which
must survive the session that wrote it.

## Why snapshots

The session that posts a task is often closed by the time the user acts on it,
and session artifacts are discarded with their session. So a task owns copies:

| Recorded | How |
|----------|-----|
| Author | `{kind:'user'}`, or `{kind:'ai', name, cliType, dir, sessionId}` copied at write time. The desktop offers *Jump* while the session lives, *Restore from bin* while it is in the recycle bin, and nothing after. |
| Artifact | Latest version copied as an attachment (md / html / text). |
| Plan | Snapshot rendered to markdown, plus the live `planId`. |
| File | Bytes copied (≤ 10 MB, ≤ 10 attachments per task). |

Deleting a task deletes its attachment copies. Done tasks are kept 7 days and
then purged.

## Fields

`title` (≤ 200), `body` (≤ 4000), `author`, optional `projectId` (no project
shows under *General*; an AI's project is resolved from its session folder),
`urgent`, `attachments`, `createdAt`, `updatedAt`, `doneAt`. Colour is derived
from the project, never stored.

## Identity

The author comes from the authenticated MCP caller, never from arguments: a
local session is recorded as an AI snapshot, a paired phone (`mobile:<id>`) is
the user, and the desktop IPC path always writes as the user. No AI can post as
"you".

## Surfaces

- **MCP** — `user_task_add / list / get / update / done / delete`. Advertised in
  the tool descriptions, the client guide, and from `session_todo_wait` (parking
  a todo on the user is the moment a user task is usually the better tool). It is
  not injected into every prompt.
- **Desktop** — `UserTasksPane.vue`: filters (All / Mine / AI / Urgent / Done),
  group by project or author, search, add. Selecting a note opens
  `UserTaskDetail.vue` (edit, done/reopen, delete, attachments). Attachments
  render in the opaque-origin artifact frame (invariant 9); PNG/JPEG/GIF/WebP
  inline; other binaries open in the OS viewer from a temp copy.
- **Android** — the same MCP tools over the phone link; see the Board screen.

## Files

| File | Role |
|------|------|
| `src/types/user-task.ts` | Types and limits |
| `src/session/user-task-manager.ts` | Owner, ordering, purge, events |
| `src/session/user-task-persistence.ts` | `user-tasks/tasks.json` + `user-tasks/attachments/<taskId>/<attId>` |
| `src/mcp/services/helm-user-task-service.ts` | MCP surface, author + attachment snapshots |
| `src/electron/ipc/user-task-handlers.ts` | Desktop IPC (acts as the user) |
| `renderer/stores/user-tasks.ts`, `renderer/user-tasks/user-task-board.ts` | Mirror, filter/group helpers |
