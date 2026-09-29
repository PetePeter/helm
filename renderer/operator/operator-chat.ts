/**
 * Desktop operator chat — the phone's operator thread, on the PC
 * (docs/voice-operator.md). The conversation IS the chat journal: the backlog
 * comes from `voiceOperatorHistory`, new entries (either direction, from any
 * surface) from `onVoiceOperatorChat`, so the desktop and the phone can never
 * disagree. Sends go through `voiceAsk` — the same route hold-to-talk uses.
 *
 * Push-to-talk here only DICTATES: the transcript lands in the composer for the
 * user to edit and send. No call, no spoken replies — that is the Call button.
 *
 * Side effects are injected (like voice-call.ts) so the logic runs under test.
 */
import { ref } from 'vue';
import type { VoiceRecorder } from '../voice/voice-call.js';

type Fail = { ok: false; error: string };

export interface OperatorChatRecord {
  /** The session the entry belongs to; the live feed carries every chat-pane session. */
  sessionId?: string;
  text: string;
  at: number;
  /** Present on user turns (desktop or phone); absent on the operator's own messages. */
  originId?: string;
  /** Alerts / artifact notices — not conversation. `deleted` is a tombstone for `deletes`. */
  kind?: string;
  /** On a `deleted` tombstone: the seq of the bubble the user deleted. */
  deletes?: number;
  /** On an API-tool reply: model context size after the turn, and its tool calls. */
  contextTokens?: number;
  toolCalls?: number;
}

export interface OperatorChatEntry {
  seq: number;
  record: OperatorChatRecord;
}

export interface OperatorChatClient {
  voiceOperatorHistory(sessionId?: string): Promise<OperatorChatEntry[]>;
  onVoiceOperatorChat(callback: (entry: OperatorChatEntry) => void): () => void;
  voiceAsk(text: string, filePath?: string, sessionId?: string): Promise<{ ok: true } | Fail>;
  voiceTranscribe(audio: Uint8Array, mimeType: string): Promise<{ ok: true; text: string } | Fail>;
}

export interface OperatorChatDeps {
  client: OperatorChatClient;
  recorder: VoiceRecorder;
  /** The session this thread shows — the operator or an API tool. */
  sessionId: string;
}

export interface ChatBubble {
  seq: number;
  from: 'you' | 'helm';
  text: string;
  at: number;
  /** "ctx 12.3k · 4 tools" under an API-tool reply; absent elsewhere. */
  badge?: string;
}

/** The API-tool reply badge: context size (k above 1000) and, when any, tool calls. */
export function usageBadge(record: Pick<OperatorChatRecord, 'contextTokens' | 'toolCalls'>): string | undefined {
  if (record.contextTokens === undefined) return undefined;
  const ctx = record.contextTokens >= 1000 ? `${(record.contextTokens / 1000).toFixed(1)}k` : String(record.contextTokens);
  const tools = record.toolCalls ? ` · ${record.toolCalls} tool${record.toolCalls === 1 ? '' : 's'}` : '';
  return `ctx ${ctx}${tools}`;
}

/** What a composer keypress means: Enter sends, Shift/Ctrl+Enter is a newline. */
export function composerKeyAction(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'isComposing'>): 'send' | 'newline' | null {
  if (event.key !== 'Enter' || event.isComposing) return null;
  return event.shiftKey || event.ctrlKey || event.metaKey ? 'newline' : 'send';
}

function toBubble(entry: OperatorChatEntry): ChatBubble | null {
  if (entry.record.kind !== undefined) return null;
  const badge = usageBadge(entry.record);
  return {
    seq: entry.seq,
    from: entry.record.originId !== undefined ? 'you' : 'helm',
    text: entry.record.text,
    at: entry.record.at,
    ...(badge ? { badge } : {}),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createOperatorChat(deps: OperatorChatDeps) {
  const bubbles = ref<ChatBubble[]>([]);
  const draft = ref('');
  const attachment = ref<string | null>(null);
  const sending = ref(false);
  const recording = ref(false);
  const transcribing = ref(false);
  const error = ref<string | null>(null);
  let unsubscribe: (() => void) | null = null;

  /** Append in seq order, ignoring an entry already shown (backlog/live overlap). */
  function add(entry: OperatorChatEntry): void {
    // The live feed carries every chat-pane session; show only this one.
    if (entry.record.sessionId !== undefined && entry.record.sessionId !== deps.sessionId) return;
    if (entry.record.kind === 'deleted') {
      bubbles.value = bubbles.value.filter(b => b.seq !== entry.record.deletes);
      return;
    }
    const bubble = toBubble(entry);
    if (!bubble || bubbles.value.some(b => b.seq === bubble.seq)) return;
    bubbles.value = [...bubbles.value, bubble].sort((a, b) => a.seq - b.seq);
  }

  async function open(): Promise<void> {
    // Subscribe first so nothing lands in the gap while the backlog loads.
    unsubscribe ??= deps.client.onVoiceOperatorChat(add);
    for (const entry of await deps.client.voiceOperatorHistory(deps.sessionId)) add(entry);
  }

  function close(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  async function send(): Promise<void> {
    const text = draft.value.trim();
    if (!text || sending.value) return;
    sending.value = true;
    error.value = null;
    try {
      const result = await deps.client.voiceAsk(text, attachment.value ?? undefined, deps.sessionId);
      if (result.ok) {
        // The bubble arrives from the journal feed, like a phone turn does.
        draft.value = '';
        attachment.value = null;
      } else {
        error.value = result.error;
      }
    } catch (err) {
      error.value = message(err);
    } finally {
      sending.value = false;
    }
  }

  async function pttStart(): Promise<void> {
    if (recording.value || transcribing.value) return;
    error.value = null;
    recording.value = true;
    try {
      await deps.recorder.start();
    } catch (err) {
      recording.value = false;
      error.value = `Microphone unavailable: ${message(err)}`;
    }
  }

  async function pttStop(): Promise<void> {
    if (!recording.value) return;
    recording.value = false;
    transcribing.value = true;
    try {
      const clip = await deps.recorder.stop();
      if (clip.bytes.byteLength === 0) return;
      const heard = await deps.client.voiceTranscribe(clip.bytes, clip.mimeType);
      if (!heard.ok) { error.value = heard.error; return; }
      const text = heard.text.trim();
      if (text) draft.value = draft.value.trim() ? `${draft.value.trimEnd()} ${text}` : text;
    } catch (err) {
      error.value = message(err);
    } finally {
      transcribing.value = false;
    }
  }

  return { bubbles, draft, attachment, sending, recording, transcribing, error, open, close, send, pttStart, pttStop };
}

export type OperatorChat = ReturnType<typeof createOperatorChat>;
