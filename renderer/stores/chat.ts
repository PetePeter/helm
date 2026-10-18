/** Pinia state for the desktop active-session chat pane. */
import { defineStore } from 'pinia';
import { reactive } from 'vue';
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

export interface ChatAttachmentDetails {
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  artifactId?: string;
  attachmentId?: string;
}

let nextLocalId = 0;

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useChatStore = defineStore('chat', () => {
  const entriesBySession = reactive(new Map<string, ChatJournalEntry[]>());
  const readThroughBySession = reactive(new Map<string, number>());
  const localTurnsBySession = reactive(new Map<string, ChatThreadMessage[]>());
  const draftsBySession = reactive(new Map<string, string>());
  const attachmentsBySession = reactive(new Map<string, { filePath: string; details: ChatAttachmentDetails }>());
  const historyErrors = reactive(new Map<string, string>());

  const loadedSessions = new Set<string>();
  const loadingSessions = new Map<string, Promise<void>>();
  const firstLiveSeqBySession = new Map<string, number>();
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let startCount = 0;
  let viewedSessionId: string | null = null;

  function journalEntriesFor(sessionId: string): ChatJournalEntry[] {
    return entriesBySession.get(sessionId) ?? [];
  }

  function maxSequence(sessionId: string): number {
    return journalEntriesFor(sessionId).reduce((max, entry) => Math.max(max, entry.seq), 0);
  }

  function advanceReadThrough(sessionId: string, seq: number): void {
    const current = readThroughBySession.get(sessionId) ?? 0;
    if (seq > current) readThroughBySession.set(sessionId, seq);
  }

  function markRead(sessionId: string): void {
    if (!loadedSessions.has(sessionId) && !entriesBySession.has(sessionId)) return;
    advanceReadThrough(sessionId, maxSequence(sessionId));
  }

  function setViewedSession(sessionId: string | null): void {
    viewedSessionId = sessionId;
    if (sessionId) markRead(sessionId);
  }

  function unreadCountFor(sessionId: string): number {
    const readThrough = readThroughBySession.get(sessionId);
    if (readThrough === undefined) return 0;
    return journalEntriesFor(sessionId).filter(({ seq, record }) =>
      seq > readThrough && !record.originId && !record.kind,
    ).length;
  }

  function addEntry(entry: ChatJournalEntry, fromLiveFeed = false): void {
    const { sessionId, originId } = entry.record;
    const entries = journalEntriesFor(sessionId);
    if (entries.some(existing => existing.seq === entry.seq)) return;

    if (fromLiveFeed && !readThroughBySession.has(sessionId)) {
      const firstLiveSeq = firstLiveSeqBySession.get(sessionId);
      firstLiveSeqBySession.set(sessionId, firstLiveSeq === undefined ? entry.seq : Math.min(firstLiveSeq, entry.seq));
    }

    const next = [...entries, entry].sort((a, b) => a.seq - b.seq);
    entriesBySession.set(sessionId, next);

    if (viewedSessionId === sessionId) advanceReadThrough(sessionId, entry.seq);

    if (originId) {
      const localTurns = localTurnsBySession.get(sessionId) ?? [];
      localTurnsBySession.set(sessionId, localTurns.filter(turn => turn.record.originId !== originId));
    }
  }

  async function loadSession(sessionId: string): Promise<void> {
    if (loadedSessions.has(sessionId)) return;
    const ongoing = loadingSessions.get(sessionId);
    if (ongoing) return ongoing;
    const chatHistory = chatClient.chatHistory;
    if (typeof chatHistory !== 'function') return;

    const loadingGeneration = generation;
    const readSequenceAtStart = readThroughBySession.get(sessionId);
    const loading = chatHistory(sessionId)
      .then(entries => {
        for (const entry of entries) addEntry(entry);
        if (readSequenceAtStart === undefined) {
          const historyMax = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
          const firstLiveSeq = firstLiveSeqBySession.get(sessionId);
          const initialReadThrough = firstLiveSeq === undefined
            ? historyMax
            : Math.min(historyMax, firstLiveSeq - 1);
          const currentReadThrough = readThroughBySession.get(sessionId);
          if (currentReadThrough === undefined) readThroughBySession.set(sessionId, initialReadThrough);
          else advanceReadThrough(sessionId, initialReadThrough);
        }
        firstLiveSeqBySession.delete(sessionId);
        if (viewedSessionId === sessionId) markRead(sessionId);
        historyErrors.delete(sessionId);
        if (loadingGeneration === generation) loadedSessions.add(sessionId);
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

  async function start(sessionIds: readonly string[]): Promise<void> {
    // Subscribe before history so a reply between the request and response is
    // merged once by journal sequence rather than lost or shown twice.
    const onChatEntry = chatClient.onChatEntry;
    if (!unsubscribe) {
      if (typeof onChatEntry !== 'function') return;
      unsubscribe = onChatEntry(entry => addEntry(entry, true));
    }
    startCount += 1;
    await loadSessions(sessionIds);
  }

  function stop(): void {
    if (startCount === 0) return;
    startCount -= 1;
    if (startCount > 0) return;

    unsubscribe?.();
    unsubscribe = null;
    generation += 1;
    loadedSessions.clear();
    loadingSessions.clear();
  }

  function historyErrorFor(sessionId: string): string | undefined {
    return historyErrors.get(sessionId);
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
    return attachmentsBySession.get(sessionId)?.filePath ?? null;
  }

  function attachmentDetailsFor(sessionId: string): ChatAttachmentDetails | null {
    return attachmentsBySession.get(sessionId)?.details ?? null;
  }

  function setAttachment(sessionId: string, path: string | null, details?: ChatAttachmentDetails): void {
    if (path) attachmentsBySession.set(sessionId, {
      filePath: path,
      details: { ...details, filename: details?.filename ?? fileName(path) },
    });
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
    const attachmentDetails = attachmentDetailsFor(sessionId);
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
        ...(path ? {
          filePath: path,
          filename: attachmentDetails?.filename ?? fileName(path),
          ...(attachmentDetails?.mimeType ? { mimeType: attachmentDetails.mimeType } : {}),
          ...(attachmentDetails?.sizeBytes !== undefined ? { sizeBytes: attachmentDetails.sizeBytes } : {}),
          ...(attachmentDetails?.artifactId ? { artifactId: attachmentDetails.artifactId } : {}),
          ...(attachmentDetails?.attachmentId ? { attachmentId: attachmentDetails.attachmentId } : {}),
        } : {}),
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
    start,
    stop,
    loadSessions,
    historyErrorFor,
    journalEntriesFor,
    messagesFor,
    unreadCountFor,
    setViewedSession,
    draftFor,
    setDraft,
    attachmentFor,
    attachmentDetailsFor,
    setAttachment,
    send,
    retry,
  };
});
