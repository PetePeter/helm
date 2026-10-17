/** Pinia state for the desktop all-session chat pane. */
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import type { ChatJournalEntry } from '../../src/mobile/mobile-chat-journal.js';
import type { ChatRecordInput } from '../../src/mobile/mobile-envelope.js';
import { chatClient } from '../ipc/clients.js';

export type ChatSendStatus = 'sending' | 'sent' | 'failed';

export interface ChatThreadMessage {
  id: string;
  seq?: number;
  record: ChatRecordInput;
  status?: ChatSendStatus;
  error?: string;
}

let nextLocalId = 0;

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useChatStore = defineStore('chat', () => {
  const selectedSessionId = ref<string | null>(null);
  const entriesBySession = reactive(new Map<string, ChatJournalEntry[]>());
  const localTurnsBySession = reactive(new Map<string, ChatThreadMessage[]>());
  const draftsBySession = reactive(new Map<string, string>());
  const attachmentsBySession = reactive(new Map<string, string>());
  const readSeqBySession = reactive(new Map<string, number>());
  const historyErrors = reactive(new Map<string, string>());

  const loadedSessions = new Set<string>();
  const loadingSessions = new Map<string, Promise<void>>();
  let unsubscribe: (() => void) | null = null;
  let generation = 0;

  function journalEntriesFor(sessionId: string): ChatJournalEntry[] {
    return entriesBySession.get(sessionId) ?? [];
  }

  function markRead(sessionId: string): void {
    const latest = journalEntriesFor(sessionId).reduce((seq, entry) => Math.max(seq, entry.seq), 0);
    readSeqBySession.set(sessionId, Math.max(readSeqBySession.get(sessionId) ?? 0, latest));
  }

  function addEntry(entry: ChatJournalEntry): void {
    const { sessionId, originId } = entry.record;
    const entries = journalEntriesFor(sessionId);
    if (entries.some(existing => existing.seq === entry.seq)) return;

    const next = [...entries, entry].sort((a, b) => a.seq - b.seq);
    entriesBySession.set(sessionId, next);

    if (originId) {
      const localTurns = localTurnsBySession.get(sessionId) ?? [];
      localTurnsBySession.set(sessionId, localTurns.filter(turn => turn.record.originId !== originId));
    }
    if (selectedSessionId.value === sessionId) markRead(sessionId);
  }

  async function loadSession(sessionId: string): Promise<void> {
    if (loadedSessions.has(sessionId)) return;
    const ongoing = loadingSessions.get(sessionId);
    if (ongoing) return ongoing;

    const loadingGeneration = generation;
    const loading = chatClient.chatHistory(sessionId)
      .then(entries => {
        for (const entry of entries) addEntry(entry);
        historyErrors.delete(sessionId);
        if (loadingGeneration === generation) loadedSessions.add(sessionId);
        if (selectedSessionId.value === sessionId) markRead(sessionId);
      })
      .catch(error => historyErrors.set(sessionId, errorMessage(error)))
      .finally(() => {
        if (loadingSessions.get(sessionId) === loading) loadingSessions.delete(sessionId);
      });
    loadingSessions.set(sessionId, loading);
    return loading;
  }

  async function loadSessions(sessionIds: readonly string[]): Promise<void> {
    await Promise.all([...new Set(sessionIds)].map(loadSession));
  }

  function selectSession(sessionId: string): void {
    selectedSessionId.value = sessionId;
    markRead(sessionId);
  }

  async function start(sessionIds: readonly string[], initialSessionId?: string | null): Promise<void> {
    // Subscribe before history so a reply between the request and response is
    // merged once by journal sequence rather than lost or shown twice.
    unsubscribe ??= chatClient.onChatEntry(addEntry);
    if (selectedSessionId.value === null) {
      const firstSessionId = initialSessionId && sessionIds.includes(initialSessionId)
        ? initialSessionId
        : sessionIds[0];
      if (firstSessionId) selectSession(firstSessionId);
    }
    await loadSessions(sessionIds);
  }

  function stop(): void {
    unsubscribe?.();
    unsubscribe = null;
    generation += 1;
    loadedSessions.clear();
    loadingSessions.clear();
  }

  function historyErrorFor(sessionId: string): string | undefined {
    return historyErrors.get(sessionId);
  }

  function unreadCount(sessionId: string): number {
    const readSeq = readSeqBySession.get(sessionId) ?? 0;
    return journalEntriesFor(sessionId).filter(({ seq, record }) =>
      seq > readSeq && record.kind === undefined && record.originId === undefined).length;
  }

  function messagesFor(sessionId: string): ChatThreadMessage[] {
    const journal = journalEntriesFor(sessionId).map(({ seq, record }) => ({
      id: `seq:${seq}`,
      seq,
      record,
      ...(record.originId?.startsWith('desktop:') ? { status: 'sent' as const } : {}),
    }));
    const echoedIds = new Set(journal.map(message => message.record.originId).filter((id): id is string => Boolean(id)));
    const local = (localTurnsBySession.get(sessionId) ?? []).filter(turn =>
      !turn.record.originId || !echoedIds.has(turn.record.originId));
    return [...journal, ...local].sort((a, b) =>
      a.record.at - b.record.at || (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
  }

  function draftFor(sessionId: string): string {
    return draftsBySession.get(sessionId) ?? '';
  }

  function setDraft(sessionId: string, draft: string): void {
    draftsBySession.set(sessionId, draft);
  }

  function attachmentFor(sessionId: string): string | null {
    return attachmentsBySession.get(sessionId) ?? null;
  }

  function setAttachment(sessionId: string, path: string | null): void {
    if (path) attachmentsBySession.set(sessionId, path);
    else attachmentsBySession.delete(sessionId);
  }

  async function transmit(sessionId: string, turn: ChatThreadMessage): Promise<boolean> {
    turn.status = 'sending';
    turn.error = undefined;
    try {
      const result = await chatClient.chatSend({
        sessionId,
        text: turn.record.text,
        ...(turn.record.filePath ? { filePath: turn.record.filePath } : {}),
        ...(turn.record.originId ? { originId: turn.record.originId } : {}),
      });
      if (!result.ok) {
        turn.status = 'failed';
        turn.error = result.error;
        return false;
      }
      turn.status = 'sent';
      return true;
    } catch (error) {
      turn.status = 'failed';
      turn.error = errorMessage(error);
      return false;
    }
  }

  async function send(sessionId: string): Promise<boolean> {
    const text = draftFor(sessionId);
    const path = attachmentFor(sessionId);
    if (!text.trim() && !path) return false;

    nextLocalId += 1;
    const originId = `desktop:${Date.now().toString(36)}-${nextLocalId.toString(36)}`;
    const turn: ChatThreadMessage = {
      id: originId,
      record: {
        sessionId,
        sessionName: sessionId,
        text,
        at: Date.now(),
        originId,
        ...(path ? { filePath: path, filename: fileName(path) } : {}),
      },
      status: 'sending',
    };
    const localTurns = localTurnsBySession.get(sessionId) ?? [];
    localTurnsBySession.set(sessionId, [...localTurns, turn]);
    setDraft(sessionId, '');
    setAttachment(sessionId, null);
    return transmit(sessionId, turn);
  }

  async function retry(sessionId: string, originId: string): Promise<boolean> {
    const turn = (localTurnsBySession.get(sessionId) ?? []).find(message => message.record.originId === originId);
    if (!turn || turn.status !== 'failed') return false;
    return transmit(sessionId, turn);
  }

  return {
    selectedSessionId,
    start,
    stop,
    loadSessions,
    selectSession,
    unreadCount,
    historyErrorFor,
    journalEntriesFor,
    messagesFor,
    draftFor,
    setDraft,
    attachmentFor,
    setAttachment,
    send,
    retry,
  };
});
