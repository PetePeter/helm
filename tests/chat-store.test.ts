import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatJournalEntry } from '../src/mobile/mobile-chat-journal.js';
import { useChatStore } from '../renderer/stores/chat.js';

const listeners = new Set<(entry: ChatJournalEntry) => void>();
let historyFor: (sessionId: string) => Promise<ChatJournalEntry[]>;
let send: (input: { sessionId: string; text: string; filePath?: string; originId?: string }) => Promise<{ ok: true } | { ok: false; error: string }>;

function entry(seq: number, sessionId: string, text: string, originId?: string): ChatJournalEntry {
  return {
    seq,
    record: {
      sessionId,
      sessionName: sessionId,
      text,
      at: seq * 1000,
      ...(originId ? { originId } : {}),
    },
  };
}

function emit(value: ChatJournalEntry): void {
  for (const listener of listeners) listener(value);
}

beforeEach(() => {
  setActivePinia(createPinia());
  listeners.clear();
  historyFor = async () => [];
  send = async () => ({ ok: true });
  vi.stubGlobal('window', {
    helm: {
      chat: {
        chatHistory: (sessionId: string) => historyFor(sessionId),
        chatSend: (input: Parameters<typeof send>[0]) => send(input),
        onChatEntry: (listener: (value: ChatJournalEntry) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('Chat store', () => {
  it('subscribes before loading history, deduplicates the overlap, and tracks unread replies by seq', async () => {
    let finishHistory!: (entries: ChatJournalEntry[]) => void;
    historyFor = sessionId => sessionId === 'two'
      ? new Promise(resolve => { finishHistory = resolve; })
      : Promise.resolve([]);
    const store = useChatStore();

    const loading = store.start(['one', 'two'], 'one');
    const live = entry(2, 'two', 'Reply during load');
    emit(live);
    finishHistory([entry(1, 'two', 'Older reply'), live]);
    await loading;

    expect(store.messagesFor('two').map(message => message.record.text)).toEqual(['Older reply', 'Reply during load']);
    expect(store.unreadCount('two')).toBe(2);

    store.selectSession('two');
    expect(store.unreadCount('two')).toBe(0);
    emit(entry(3, 'two', 'Visible reply'));
    expect(store.unreadCount('two')).toBe(0);

    store.selectSession('one');
    emit(entry(4, 'two', 'New unread reply'));
    expect(store.unreadCount('two')).toBe(1);
  });

  it('keeps drafts and attachment selections per session', () => {
    const store = useChatStore();
    store.setDraft('one', 'first draft');
    store.setAttachment('one', 'C:/first.txt');
    store.setDraft('two', 'second draft');
    store.setAttachment('two', 'C:/second.txt');

    expect(store.draftFor('one')).toBe('first draft');
    expect(store.attachmentFor('one')).toBe('C:/first.txt');
    expect(store.draftFor('two')).toBe('second draft');
    expect(store.attachmentFor('two')).toBe('C:/second.txt');
  });

  it('keeps a failed desktop send visible as Failed without adding a journal turn', async () => {
    send = async () => ({ ok: false, error: 'session is not accepting input' });
    const store = useChatStore();
    store.setDraft('one', 'please continue');

    await store.send('one');

    const messages = store.messagesFor('one');
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe('failed');
    expect(messages[0].record.originId).toMatch(/^desktop:/);
    expect(store.journalEntriesFor('one')).toHaveLength(0);
  });

  it('reconciles the optimistic turn with its journal echo and keeps Sent status', async () => {
    const store = useChatStore();
    await store.start(['one'], 'one');
    send = async input => {
      emit(entry(1, input.sessionId, input.text, input.originId));
      return { ok: true };
    };
    store.setDraft('one', 'hello from desktop');

    await store.send('one');

    const messages = store.messagesFor('one');
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe('sent');
    expect(messages[0].seq).toBe(1);
    expect(store.journalEntriesFor('one')).toHaveLength(1);
  });
});
