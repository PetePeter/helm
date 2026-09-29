/**
 * useOperatorChat — the desktop chat thread of a chat-pane session (the Helm
 * operator, or an API tool), created on first use (logic:
 * operator/operator-chat.ts). `operatorView` is whether such a pane shows the
 * chat or its raw terminal; chat is the default.
 */
import { ref } from 'vue';
import { voiceClient } from '../ipc/clients.js';
import { createMediaRecorder } from '../voice/browser-audio.js';
import { createOperatorChat, type OperatorChat } from '../operator/operator-chat.js';

/** One thread per chat-pane session (the operator, each API tool), kept across pane switches. */
const chats = new Map<string, OperatorChat>();

export const operatorView = ref<'chat' | 'terminal'>('chat');

/** The hold-to-talk combo; Settings → Operator writes it so a live chat never holds a stale key. */
export const operatorPttKey = ref('f9');

export function useOperatorChat(sessionId: string): OperatorChat {
  let chat = chats.get(sessionId);
  if (!chat) {
    chat = createOperatorChat({ client: voiceClient, recorder: createMediaRecorder(), sessionId });
    chats.set(sessionId, chat);
  }
  return chat;
}
