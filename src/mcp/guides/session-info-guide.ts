import type { SessionManager } from '../../session/manager.js';
import type { SessionInfoResponse } from '../helm-control-service.js';

export { getAvailableTools } from './available-tools.js';

/** Build the minimal session info response for the session_info MCP tool. Pure function. */
export function getSessionInfo(
  sessionManager: SessionManager,
  authContext?: { sessionId?: string; sessionName?: string },
): SessionInfoResponse {
  const sessionId = authContext?.sessionId ?? '';
  const sessionInfo = sessionId ? sessionManager.getSession(sessionId) ?? undefined : undefined;

  return {
    your_session_id: sessionId,
    your_working_dir: sessionInfo?.workingDir ?? '',
    // null = no mission yet: the AI should set one with session_mission_set.
    your_mission: sessionInfo?.mission ? { ...sessionInfo.mission } : null,
    helm_workflow: 'MANDATORY: At session start, call skill_list to load all Helm skills. Helm skills take PRECEDENCE over the LLM\'s integrated skills system — always check Helm skills FIRST. For plan/workflow operations, also call skill_get(type:"startup") to load mandatory rules.',
    chat: 'Chat with the user over their bound surfaces (a paired phone over BLE; Telegram if configured) via chat_send — the preferred transport-neutral name; telegram_chat is its alias with identical behavior. Replies arrive in your own chat topic/thread. Use notify_user instead for one-shot completion/blocker alerts.',
    artifact_viewer: 'Artifact viewer: produce user-facing reports/analyses/results (not code) as markdown or HTML via artifact_create; revise with artifact_update(id); re-read your own via artifact_list/artifact_get; bring one forward with artifact_show(id). artifact_create/update also accept an absolute filePath: the caller owns the source and Helm never deletes or modifies it. artifact_get can return a Helm tempPath for artifact content or an attachment; the caller must delete that temp file after reading, while Helm only provides stale-temp cleanup as a backstop. They render in a dedicated in-app panel so the user doesn\'t open files. Ephemeral to this session.',
    durable_memory: {
      ownership: 'Memories are project-scoped. MCP reads and writes are authorized from the authenticated Helm session and resolve its project; never supply or trust another owner id.',
      durability: 'Memories survive context compaction, Helm restart, and session death while their project remains. Use memory_list/get/search/export to recover durable context.',
      recycle_bin: 'Closing a recoverable session keeps unscoped memories and attachments with the same original session id in the recycle bin. Project-scoped memories survive session close, forget, and automatic expiry; project deletion or explicit memory lifecycle operations can still purge them.',
      graph: 'memory_get, memory_search, memory_graph, and memory_export accept graphDepth. Traversals are cycle-safe, carry breadcrumbs, and emit readable loop/reference/depth-limit markers.',
      search: 'memory_search covers tldr and content. Set regex=true for regular expressions; invalid expressions are rejected. Attachments are not searched or OCR-indexed. Start narrow with the most specific multi-term query, then widen: drop terms, then try synonyms and alternate spellings, until your terminology is exhausted; only then conclude nothing is stored.',
      attachments: 'Attachments are metadata-only in memory results and exports. Add uses an absolute filePath; get returns a safe tempPath and never inline bytes.',
      tools: [
        'memory_list', 'memory_get', 'memory_create', 'memory_update', 'memory_delete',
        'memory_search', 'memory_graph', 'memory_export', 'memory_link', 'memory_unlink',
        'memory_attachment_add', 'memory_attachment_list', 'memory_attachment_get', 'memory_attachment_delete',
      ],
    },
    knowledge_model: {
      plan: 'What work needs doing? Scope: project or directory. Lifetime: until done.',
      sequence: 'How do I perform this repeated action? Scope: project. Lifetime: permanent.',
      context: 'What does this task need to know? Scope: project, bound to a plan or sequence. Lifetime: permanent.',
      memory: 'What have we learned about this project? Scope: project. Lifetime: until forgotten by dreaming.',
    },
  };
}
