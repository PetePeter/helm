# Helm Compact & Switch CLI

Two actions share one engine: Helm strips a session's own transcript to markdown and has a fresh context read it back.

- **Helm Compact** (`session_quick_compact`, context menu "🗜️ Helm Compact"): strip → clear the session → paste a prompt pointing at the file.
- On the phone, both sit on the session sheet: "Helm compact" (confirms first) and "Switch CLI" (opens a picker of the desktop's CLIs). Rows grey out unless the device's mobile allow-list permits the tool.
- **Switch CLI** (`session_switch_cli`, context menu "🔀 Switch CLI…" → CLI picker): strip → spawn the picked CLI in the same directory, name and runtime group, with the prompt as its initial paste → close the source (recycle bin, restorable; `closeSource: false` keeps it; locked sessions are never closed).

```mermaid
graph LR
    H[CLI hooks<br/>transcript_path] -->|HookTracker| S[SessionInfo.cliTranscriptPath]
    S --> X[stripTranscript<br/>src/session/transcript-strip.ts]
    X --> F[Helm tmp .md]
    F --> C[Helm Compact:<br/>clear + resume prompt]
    F --> W[Switch CLI:<br/>spawn picked CLI + resume prompt,<br/>close source]
```

## Why strip instead of `/compact`

Measured on a 157k-token Claude Code session: `/compact` landed at 47–56k, a local-model fold at 56k, stripping at 62k. Only the stripped copy answered every recall question exactly — summaries lose paths, numbers and decisions. Stripping costs ~10–15k more context and no model call.

What is kept: every user prompt and assistant reply, one line per tool call (name + clipped arguments), and failed tool results. What goes: thinking (only useful inside the turn that produced it), successful tool output (re-readable from disk), meta records and injected hook text. Claude Code logs start from the last compaction boundary, keeping its summary; Codex rollouts read `response_item` records only and keep the whole history across compactions — Codex's `compacted` summary is encrypted, so the earlier turns are the only readable record. Copilot CLI logs start after the last `session.compaction_complete`, keeping its summary; sub-agent records (`parentToolCallId`) and the injected `transformedContent` are dropped.

## Requirements

- **CLI hooks installed** ([cli-hooks.md](cli-hooks.md)). The transcript path only arrives through hook payloads (Copilot sends none, so it is derived from the hook's `sessionId`: `~/.copilot/session-state/<id>/events.jsonl`) and is persisted on the session, so it survives a restart. Without it both actions refuse with a clear error and change nothing.
- Supported log formats: Claude Code, Codex and Copilot CLI JSONL. Other CLIs fall through to the Claude parser and produce an empty strip.
- Every strip logs `[TranscriptStrip]` (format, source, sizes, record/compaction/section counts, output file); an empty strip warns with the log's record-type histogram. `[HookTracker]` logs each newly learned transcript path.
- The log is read whole; one over ~512 MB (seen once on a long Copilot session) exceeds Node's string limit and the action fails with an error.
