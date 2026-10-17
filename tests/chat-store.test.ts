import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatJournalEntry } from '../src/mobile/mobile-chat-journal.js';
import type { ChatRecordInput } from '../src/mobile/mobile-envelope.js';
import { useChatStore } from '../renderer/stores/chat.js';

const listeners = new Set<(entry: ChatJournalEntry) => void>();
let historyFor: (sessionId: string) => Promise<ChatJournalEntry[]>;
let send: (input: { sessionId: string; text: string; filePath?: string; originId?: string }) => Promise<{ ok: true } | { ok: false; error: string }>;

function entry(
  seq: number,
  sessionId: string,
  text: string,
  originId?: string,
  kind?: ChatRecordInput['kind'],
): ChatJournalEntry {
  return {
    seq,
    record: {
      sessionId,
      sessionName: sessionId,
      text,
      at: seq * 1000,
      ...(originId ? { originId } : {}),
      ...(kind ? { kind } : {}),
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
  it('subscribes before loading history and deduplicates the overlap by seq', async () => {
    let finishHistory!: (entries: ChatJournalEntry[]) => void;
    historyFor = sessionId => sessionId === 'two'
      ? new Promise(resolve => { finishHistory = resolve; })
      : Promise.resolve([]);
    const store = useChatStore();

    const loading = store.start(['one']);
    const loadingTwo = store.loadSessions(['two']);
    const live = entry(2, 'two', 'Reply during load');
    emit(live);
    finishHistory([entry(1, 'two', 'Older reply'), live]);
    await Promise.all([loading, loadingTwo]);

    expect(store.messagesFor('two').map(message => message.record.text)).toEqual(['Older reply', 'Reply during load']);
    expect(store.unreadCountFor('two')).toBe(1);

    store.stop();
    emit(entry(3, 'two', 'After stop'));
    expect(store.messagesFor('two').map(message => message.record.text)).toEqual(['Older reply', 'Reply during load']);
  });

  it('counts incoming unread messages per session and clears them when that thread is viewed', async () => {
    historyFor = async sessionId => [entry(sessionId === 'one' ? 1 : 2, sessionId, 'history')];
    const store = useChatStore();
    await store.start(['one', 'two']);

    expect(store.unreadCountFor('one')).toBe(0);
    expect(store.unreadCountFor('two')).toBe(0);

    emit(entry(3, 'one', 'reply for one'));
    emit(entry(4, 'two', 'reply for two'));
    emit(entry(5, 'one', 'desktop turn', 'desktop:turn-1'));
    emit(entry(6, 'one', 'artifact notice', undefined, 'artifact'));

    expect(store.unreadCountFor('one')).toBe(1);
    expect(store.unreadCountFor('two')).toBe(1);

    store.setViewedSession('one');
    expect(store.unreadCountFor('one')).toBe(0);
    expect(store.unreadCountFor('two')).toBe(1);

    emit(entry(7, 'one', 'reply while viewed'));
    expect(store.unreadCountFor('one')).toBe(0);

    store.setViewedSession(null);
    emit(entry(8, 'one', 'reply while away'));
    expect(store.unreadCountFor('one')).toBe(1);
    expect(store.unreadCountFor('two')).toBe(1);
    store.stop();
  });

  it('catches up unread messages from journal history after the listener stops', async () => {
    historyFor = async () => [entry(1, 'one', 'seen')];
    const store = useChatStore();
    await store.start(['one']);
    store.stop();

    historyFor = async () => [entry(1, 'one', 'seen'), entry(2, 'one', 'arrived while stopped')];
    await store.start(['one']);

    expect(store.unreadCountFor('one')).toBe(1);
    store.stop();
  });

  it('keeps one live subscription until all pane consumers stop', async () => {
    const store = useChatStore();
    await Promise.all([store.start(['one']), store.start(['one'])]);
    expect(listeners.size).toBe(1);

    store.stop();
    emit(entry(1, 'one', 'still subscribed'));
    expect(store.unreadCountFor('one')).toBe(1);

    store.stop();
    emit(entry(2, 'one', 'after final stop'));
    expect(store.unreadCountFor('one')).toBe(1);
    store.stop();
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
    await store.start(['one']);
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
