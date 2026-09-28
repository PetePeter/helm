/**
 * useOperatorChat — the app's one desktop operator chat, created on first use
 * (logic: operator/operator-chat.ts). `operatorView` is whether the operator's
 * pane shows the chat or its raw terminal; chat is the default.
 */
import { ref } from 'vue';
import { voiceClient } from '../ipc/clients.js';
import { createMediaRecorder } from '../voice/browser-audio.js';
import { createOperatorChat, type OperatorChat } from '../operator/operator-chat.js';

let chat: OperatorChat | null = null;

export const operatorView = ref<'chat' | 'terminal'>('chat');

/** The hold-to-talk combo; Settings → Operator writes it so a live chat never holds a stale key. */
export const operatorPttKey = ref('f9');

export function useOperatorChat(): OperatorChat {
  chat ??= createOperatorChat({ client: voiceClient, recorder: createMediaRecorder() });
  return chat;
}
