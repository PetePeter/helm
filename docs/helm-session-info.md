# session_info MCP Tool — Endpoint Context

## Overview

The `session_info` MCP tool is an **autocall endpoint** that provides AI agents with session context, MCP connectivity information. Call this tool on session startup to prime the state machine.

It is also the main place Helm teaches agents about durable memory: prefer `context_*` tools for notes that should survive this session, and treat sequence `sharedMemory` as legacy coordination text rather than the default place to accumulate new knowledge.

## Tool Definition

**Name:** `session_info`  
**Title:** Get Session Info  
**Method:** `tools/call` with `params.name='session_info'`  
**Input Schema:** Empty object `{}`  

## Response Fields

The tool returns a `SessionInfoResponse` object with these fields:

### Current Context Size

`session_info` includes a `context` object for the caller's own session. `session_get` includes the same object for its selected session. A known result has `known: true`, a positive `tokens` count, `source` (`transcript`, `api`, or `statusline`), and optional `window`, rounded `percent`, and `measuredAtIso`. Transcript measurements use the timestamp on the usage record; API measurements are the server's latest reported count; Claude statusline reports include the model's actual context window.

The caller's current mission and expected finish time are also returned as
`your_mission` and `your_eta` (either is `null` when unset). Use
`session_eta_set` and `session_eta_clear` to maintain `your_eta` for your own
multi-step request; see [session-eta.md](session-eta.md).

When Helm cannot report a value, `context` is `{ "known": false, "reason": ... }`. Reasons include `no-transcript` (no transcript path or it cannot be read), `no-usage-yet` (a readable transcript has no usage record yet), `unsupported-cli` (the CLI does not report live context usage), `remote` (the session is hosted by a peer), and `api-unavailable` (an API session process is not available). Helm omits `context` when a global-token caller has no session. It never reports zero as a known size.

Context lookup is deliberately limited to `session_info` and `session_get`: reading a CLI transcript may inspect up to 1 MB, so `session_list` and the session feed do not include it.

### Session Identity (Optional)

- **`sessionId`** (string, optional) — Helm session UUID if the caller authenticated with a session-scoped token (HELM_MCP_TOKEN). Undefined if using a global auth token.
- **`sessionName`** (string, optional) — Display name of the session (`HELM_SESSION_NAME` env var at session startup). Undefined for global token callers.
- **`cliType`** (string, optional) — CLI type identity of the session. A UUID — pass it back verbatim, never show it to a human; `session_list` / `session_read_terminal` carry `cliTypeName` alongside it for that. Pre-UUID slugs (`'claude-code'`, `'copilot-cli'`) and display names still resolve. Undefined for global token callers. See [config-system.md](config-system.md#cli-type-identity).
- **`workingDir`** (string, optional) — Working directory the session was spawned in. Undefined for global token callers.

### MCP Endpoint Context

- **`mcp_url`** (string) — HTTP endpoint for MCP requests: `http://127.0.0.1:PORT/mcp`. Constructed from `HELM_MCP_PORT` config (default 47373).
- **`mcp_token`** (string) — Bearer auth token for MCP requests. From Helm settings → MCP → Auth Token. Pass in request header: `Authorization: Bearer {mcp_token}`.

### Chat Guidance

- **`chat`** (string) — Points agents at `chat_send` as the transport-neutral way to reach the user's bound chat surfaces (a paired phone over BLE; Telegram if configured).

### Available Resources

- **`available_projects`** (ProjectInfo[]) — Compact project stubs with `{ id, name, canonicalPath }` fields. Call `projects_list` when full project directory details are needed.
- **`skills`** — Compact summaries for user and system skills applicable to the current session project. Fields: `id`, `name`, `description`, `aiAmendable`, `allProjects`, `projectIds`, `type`, `source`. Fetch full bodies with `skills_get` only when needed. System skill type identifiers: `session-send-text`, `agent-plan`, `notification`.

  | Type | Content |
  | --- | --- |
  | `session-send-text` | Inter-LLM handoff protocol via `session_send_text`. |
  | `agent-plan` | Plan management workflow — creating, claiming, completing, and linking Helm plans. |
  | `notification` | Notification routing — when and how to call `notify_user`; toast / bubble / Telegram routing. |

  Agents should fetch these only when the task requires the guidance, not on every startup.

## Usage Pattern

### 1. Startup Initialization

When a session starts, call `session_info` to prime the state machine:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "session_info",
    "arguments": {}
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "a1b2c3d4-e5f6-...",
    "sessionName": "Claude-Main",
    "cliType": "claude-code",
    "workingDir": "X:\\coding\\gamepad-cli-hub",
    "mcp_url": "http://127.0.0.1:47373/mcp",
    "mcp_token": "eyJhbGciOi...",
    "available_projects": [
      { "id": "543a...", "name": "gamepad-cli-hub", "canonicalPath": "x:\\coding\\gamepad-cli-hub" }
    ],
    "skills": [
      { "id": "sys-agent-plan", "name": "Agent Plan Guide", "type": "agent-plan", "source": "system" }
    ],
    "telegramCapabilities": {
      "available": true,
      "openwhisper": true,
      "openwhisperPath": "C:\\openwhispr\\OpenWhispr.exe",
      "piper": true,
      "piperPath": "C:\\piper\\piper.exe",
      "ffmpeg": false
    }
  }
}
```

### 3. Building MCP Requests

Use `mcp_url` and `mcp_token` to construct subsequent MCP requests:

```javascript
const { mcp_url, mcp_token } = await callSessionInfo();

const response = await fetch(mcp_url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${mcp_token}`
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'plans_list',
      arguments: { dirPath: workingDir }
    }
  })
});
```

### 4. Discovering Available Tools

Use the MCP `tools/list` protocol request to inspect the current tool catalog. The Helm `tools_list` tool is separate: it lists configured CLI types and spawn targets.

### 5. Creating Durable Plans

When an agent discovers follow-up work that should survive the current session, call `plan_create` with a description that includes the required sections from `agent_plan_guide.required_description_sections`. If the agent is blocked by a user question, create a separate plan titled `QUESTION: ...`, put the concrete question at the top of that plan, and link that question plan to the original blocked plan with `plan_nextplan_link` so the question must complete first.

When a user mentions `P-0035` or another `P-00xx` value, treat it as a Helm plan reference. MCP plan tools that accept a plan id also accept these human-readable IDs; use `plans_summary` when you need to map the `P-00xx` value to the canonical UUID, title, status, or dependency context.

### 6. Plan Attachments and Sequence Memory

#### Plan Attachments

`plan_get` is intentionally lightweight. It returns the plan item plus `hasAttachments: boolean` — a flag indicating whether the plan has any attached files. This design keeps raw attachment content out of routine plan reads.

**Workflow:**
1. Call `plan_get` to fetch a plan — the response includes `hasAttachments: true|false`.
2. If `hasAttachments` is true, call `plan_attachment_list` to see metadata (filename, size, content type, timestamps).
3. Call `plan_attachment_get` to retrieve a specific attachment — it is copied to a Helm temp file, and you receive the local temp path. Read it and delete the returned temp file promptly; Helm only reaps stale copies as a startup backstop.
4. Call `plan_attachment_add` with a `filePath` to attach an existing file (code samples, screenshots, design docs); the caller owns the source and Helm never deletes or modifies it. Attachments are persisted inside Helm's config-managed storage and survive session restarts.

Example:
```javascript
const plan = await mcp.callTool('plan_get', { id: 'P-0042' });
if (plan.hasAttachments) {
  const attachments = await mcp.callTool('plan_attachment_list', { planRef: 'P-0042' });
  for (const attachment of attachments) {
    const { tempPath } = await mcp.callTool('plan_attachment_get', {
      planRef: 'P-0042',
      attachmentId: attachment.id
    });
    // Read the file at tempPath...
  }
}
// Attach a file from disk
await mcp.callTool('plan_attachment_add', {
  planId: 'P-0042',
  filePath: '/path/to/artifact.json'
});
```

#### Sequence Memory (Shared State for Plan Groups)

A sequence is a first-class shared-memory store that groups related plans into a coordinated swimlane. Plans can optionally join a sequence to track common progress, decisions, or accumulated context.

**Key points:**
- A plan may include `sequenceId` (returned by `plan_get`), but the full sequence and its shared memory are NOT inlined.
- Call `plan_sequence_list` with `planId` to discover the sequence and see member plans, mission statement, and shared memory.
- `memberPlanIds` / `memberHumanIds` include all members. `openMemberPlanIds` / `openMemberHumanIds` exclude plans with status `done`; an empty open array means there are no open plans. If an older desktop omits both open arrays, use the all-member arrays.
- Shared memory is common state that all member plans can read and append to.

**Workflow for reading:**
```javascript
const plan = await mcp.callTool('plan_get', { id: 'P-0042' });
if (plan.sequenceId) {
  const sequences = await mcp.callTool('plan_sequence_list', { planId: 'P-0042' });
  const sequence = sequences[0]; // The sequence this plan belongs to
  console.log('Shared Memory:', sequence.sharedMemory);
  // All member arrays include done plans; open member arrays omit them.
  console.log('Member Plans:', sequence.memberHumanIds);
  console.log('Open Member Plans:', sequence.openMemberHumanIds ?? sequence.openMemberPlanIds ?? sequence.memberHumanIds);
}
```

**Workflow for writing shared memory atomically:**
When multiple agents may write concurrently, use `expectedUpdatedAt` from the last read to prevent overwrites:
```javascript
const sequences = await mcp.callTool('plan_sequence_list', { planId: 'P-0042' });
const sequence = sequences[0];

// Later, when writing:
const updated = await mcp.callTool('plan_sequence_memory_append', {
  id: sequence.id,
  text: 'Agent A completed the initial research phase.',
  expectedUpdatedAt: sequence.updatedAt  // Mutex: fails if another agent wrote first
});

// If mutex fails, re-read and retry:
// 1. Refetch the sequence with plan_sequence_list
// 2. Append with the new expectedUpdatedAt
```

Alternatively, use `plan_sequence_update` for full edits or to change mission and title.

## Environment Variables (at Session Spawn)

Helm injects these env vars into each spawned session's PTY:

- **`HELM_SESSION_ID`** — UUID v4 session identifier (matches `sessionId` in response).
- **`HELM_SESSION_NAME`** — Display name of the session (matches `sessionName` in response).
- **`HELM_MCP_TOKEN`** — Session-scoped auth token (session-specific variant of `mcp_token`). Derived from the global auth token.
- **`HELM_MCP_URL`** — MCP endpoint URL (matches `mcp_url` in response): `http://127.0.0.1:PORT/mcp`.

CLI agents can read these from `process.env` to avoid making a `session_info` call if they prefer.

## Authentication

Two auth models:

1. **Session-Scoped Token** (Preferred for inter-session communication)
   - Generated at spawn time via `mintSessionAuthToken()` — encodes `sessionId` and `sessionName`.
   - Passed in MCP request header: `Authorization: Bearer {HELM_MCP_TOKEN}`.
   - Server decodes the token and extracts `sessionId` and `sessionName` into `authContext`.
   - Useful for `session_send_text` and inter-LLM messages — proves sender identity.

2. **Global Auth Token** (Fallback for global callers)
   - Set in Helm settings → MCP → Auth Token.
   - Passed in request header: `Authorization: Bearer {authToken}`.
   - Server accepts but does not decode — `authContext` is empty.
   - Used by global tooling that doesn't have a session context.

## Example: Full Session Initialization

```javascript
// Step 1: Call session_info to prime the state machine
const sessionInfo = await mcp.callTool('session_info', {});
console.log(`Session: ${sessionInfo.sessionName} (${sessionInfo.sessionId})`);

// Step 2: Fetch detailed workflow guidance only when needed
const planGuide = await mcp.callTool('skills_get', {
  type: 'agent-plan',
  dirPath: sessionInfo.workingDir
});

// Step 3: Make MCP calls as needed
const plans = await mcp.callTool('plans_summary', {
  dirPath: sessionInfo.workingDir
});
```

## See Also

- [Helm Session Architecture](./helm-session-info.md) — How sessions are created, resumed, and managed.
- [MCP Protocol Documentation](./mcp-protocol.md) — Full MCP request/response format.
- [Config System](./config-system.md) — How to configure Helm, profiles, and MCP settings.
