/**
 * Desktop operator chat (renderer/operator/operator-chat.ts): bubbles come from
 * the chat journal, sends go through voiceAsk, PTT dictates into the composer.
 * Fakes stand in for IPC and the microphone only.
 */
import { describe, it, expect } from 'vitest';
import { composerKeyAction, createOperatorChat, usageBadge, type OperatorChatEntry } from '../renderer/operator/operator-chat';

function fakes(history: OperatorChatEntry[] = []) {
  let push: ((entry: OperatorChatEntry) => void) | null = null;
  const asked: Array<{ text: string; filePath?: string; sessionId?: string }> = [];
  const historyFor: Array<string | undefined> = [];
  let askResult: { ok: true } | { ok: false; error: string } = { ok: true };
  let heard: { ok: true; text: string } | { ok: false; error: string } = { ok: true, text: 'dictated words' };
  let clip = { bytes: new Uint8Array([1, 2]), mimeType: 'audio/webm' };
  const client = {
    voiceOperatorHistory: async (sessionId?: string) => { historyFor.push(sessionId); return history; },
    onVoiceOperatorChat: (cb: (entry: OperatorChatEntry) => void) => { push = cb; return () => { push = null; }; },
    voiceAsk: async (text: string, filePath?: string, sessionId?: string) => { asked.push({ text, filePath, sessionId }); return askResult; },
    voiceTranscribe: async () => heard,
  };
  const recorder = { start: async () => {}, stop: async () => clip };
  return {
    chat: createOperatorChat({ client, recorder, sessionId: 'op' }),
    asked,
    historyFor,
    push: (entry: OperatorChatEntry) => push?.(entry),
    subscribed: () => push !== null,
    failAsk: (error: string) => { askResult = { ok: false, error }; },
    hear: (result: typeof heard) => { heard = result; },
    silence: () => { clip = { bytes: new Uint8Array(), mimeType: 'audio/webm' }; },
  };
}

const you = (seq: number, text: string): OperatorChatEntry => ({ seq, record: { text, at: seq, originId: `desktop:${seq}` } });
const helm = (seq: number, text: string): OperatorChatEntry => ({ seq, record: { text, at: seq } });

describe('composerKeyAction', () => {
  const key = (over: Partial<KeyboardEvent>) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...over });

  it('Enter sends; Shift/Ctrl+Enter is a newline; other keys and IME composition are left alone', () => {
    expect(composerKeyAction(key({}))).toBe('send');
    expect(composerKeyAction(key({ shiftKey: true }))).toBe('newline');
    expect(composerKeyAction(key({ ctrlKey: true }))).toBe('newline');
    expect(composerKeyAction(key({ key: 'a' }))).toBeNull();
    expect(composerKeyAction(key({ isComposing: true }))).toBeNull();
  });
});

describe('createOperatorChat', () => {
  it('shows the backlog as you/helm bubbles in seq order, skipping notices', async () => {
    const f = fakes([helm(2, 'hello back'), you(1, 'hi'), { seq: 3, record: { text: 'alert', at: 3, kind: 'attention' } }]);
    await f.chat.open();
    expect(f.chat.bubbles.value.map(b => [b.from, b.text])).toEqual([['you', 'hi'], ['helm', 'hello back']]);
  });

  it('appends live entries once, even when the backlog already had them', async () => {
    const f = fakes([you(1, 'hi')]);
    await f.chat.open();
    f.push(you(1, 'hi'));
    f.push(helm(2, 'reply from the phone thread'));
    expect(f.chat.bubbles.value.map(b => b.seq)).toEqual([1, 2]);
    f.chat.close();
    expect(f.subscribed()).toBe(false);
  });

  it('shows only its own session from the shared live feed, and scopes history to it', async () => {
    const f = fakes();
    await f.chat.open();
    f.push({ seq: 5, record: { sessionId: 'api-1', text: 'another session', at: 5 } });
    f.push({ seq: 6, record: { sessionId: 'op', text: 'mine', at: 6 } });
    expect(f.chat.bubbles.value.map(b => b.text)).toEqual(['mine']);
    expect(f.historyFor).toEqual(['op']);
  });

  it('sends the trimmed draft with its attachment, then clears both', async () => {
    const f = fakes();
    f.chat.draft.value = '  send this log  ';
    f.chat.attachment.value = 'C:\\logs\\crash.log';
    await f.chat.send();
    expect(f.asked).toEqual([{ text: 'send this log', filePath: 'C:\\logs\\crash.log', sessionId: 'op' }]);
    expect(f.chat.draft.value).toBe('');
    expect(f.chat.attachment.value).toBeNull();
  });

  it('never sends an empty draft, and keeps the draft when the send is refused', async () => {
    const f = fakes();
    f.chat.draft.value = '   ';
    await f.chat.send();
    expect(f.asked).toEqual([]);

    f.failAsk('The Helm operator is off');
    f.chat.draft.value = 'keep me';
    await f.chat.send();
    expect(f.chat.draft.value).toBe('keep me');
    expect(f.chat.error.value).toBe('The Helm operator is off');
  });

  it('PTT: hold records, release transcribes into the composer (appending), and never sends', async () => {
    const f = fakes();
    f.chat.draft.value = 'Tell helm-ui';
    await f.chat.pttStart();
    expect(f.chat.recording.value).toBe(true);
    await f.chat.pttStop();
    expect(f.chat.recording.value).toBe(false);
    expect(f.chat.draft.value).toBe('Tell helm-ui dictated words');
    expect(f.asked).toEqual([]);
  });

  it('PTT: silence adds nothing; a transcription failure is shown', async () => {
    const f = fakes();
    f.silence();
    await f.chat.pttStart();
    await f.chat.pttStop();
    expect(f.chat.draft.value).toBe('');

    const g = fakes();
    g.hear({ ok: false, error: 'OpenWhispr not configured' });
    await g.chat.pttStart();
    await g.chat.pttStop();
    expect(g.chat.error.value).toBe('OpenWhispr not configured');
  });
});

describe('API-tool chat extras', () => {
  it('a deleted tombstone removes its bubble and shows nothing itself', async () => {
    const f = fakes([helm(1, 'keep'), helm(2, 'drop me')]);
    await f.chat.open();
    f.push({ seq: 3, record: { sessionId: 'op', text: '', at: 3, kind: 'deleted', deletes: 2 } });
    expect(f.chat.bubbles.value.map(b => b.text)).toEqual(['keep']);
  });

  it('an API reply shows its context and tool-call badge', async () => {
    const f = fakes([{ seq: 1, record: { text: 'answer', at: 1, contextTokens: 12345, toolCalls: 3 } }]);
    await f.chat.open();
    expect(f.chat.bubbles.value[0].badge).toBe('ctx 12.3k · 3 tools');
    expect(usageBadge({ contextTokens: 800, toolCalls: 0 })).toBe('ctx 800');
    expect(usageBadge({})).toBeUndefined();
  });
});
