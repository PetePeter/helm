/**
 * useVoiceCall — the app's one desktop voice call, lazily created on first use
 * so nothing subscribes or touches the microphone until voice is actually used.
 * Browser recorder/player: voice/browser-audio.ts; logic: voice/voice-call.ts.
 */
import { state } from '../state.js';
import { voiceClient } from '../ipc/clients.js';
import { createVoiceCall, type VoiceCall } from '../voice/voice-call.js';
import { createAudioPlayer, createMediaRecorder } from '../voice/browser-audio.js';

let call: VoiceCall | null = null;

export function useVoiceCall(): VoiceCall {
  call ??= createVoiceCall({
    client: voiceClient,
    recorder: createMediaRecorder(),
    player: createAudioPlayer(),
    hasOperator: () => state.sessions.some(session => session.role === 'operator'),
  });
  return call;
}
