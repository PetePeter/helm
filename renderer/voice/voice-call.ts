/**
 * Desktop voice call — hold-to-talk to the Helm operator (docs/voice-operator.md).
 *
 * The controller owns the call state; everything with a side effect (IPC,
 * microphone, speakers) is injected so it runs under test with fakes. A call is
 * "open" from the first talk until hang-up: while open, every operator reply is
 * spoken once, strictly in arrival order. Replies that land with no call open
 * are still shown — the phone may be the one talking — but never spoken.
 */
import { ref } from 'vue';

export type VoiceCallPhase = 'idle' | 'recording' | 'transcribing' | 'speaking';

export interface VoiceTranscriptLine {
  from: 'you' | 'helm';
  text: string;
}

type Fail = { ok: false; error: string };

export interface VoiceCallClient {
  voiceTranscribe(audio: Uint8Array, mimeType: string): Promise<{ ok: true; text: string } | Fail>;
  voiceSpeak(text: string): Promise<{ ok: true; audio: Uint8Array; mimeType: string } | Fail>;
  voiceAsk(text: string): Promise<{ ok: true } | Fail>;
  onVoiceOperatorReply(callback: (reply: { sessionId: string; text: string }) => void): () => void;
}

export interface VoiceRecorder {
  start(): Promise<void>;
  stop(): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export interface VoicePlayer {
  play(audio: Uint8Array, mimeType: string): Promise<void>;
  /** Cut the clip that is playing now short (resolves its play()). */
  stop(): void;
}

export interface VoiceCallDeps {
  client: VoiceCallClient;
  recorder: VoiceRecorder;
  player: VoicePlayer;
  hasOperator: () => boolean;
}

/** Keep the panel readable; the phone holds the full history. */
const MAX_TRANSCRIPT_LINES = 50;

export function createVoiceCall(deps: VoiceCallDeps) {
  const inCall = ref(false);
  const phase = ref<VoiceCallPhase>('idle');
  const transcript = ref<VoiceTranscriptLine[]>([]);
  const error = ref<string | null>(null);

  let recording = false;
  let speechQueue: Promise<void> = Promise.resolve();

  function append(line: VoiceTranscriptLine): void {
    transcript.value = [...transcript.value, line].slice(-MAX_TRANSCRIPT_LINES);
  }

  async function startTalk(): Promise<void> {
    if (recording) return;
    if (!deps.hasOperator()) {
      error.value = 'The Helm operator is off — enable it in Settings → Operator';
      return;
    }
    error.value = null;
    inCall.value = true;
    recording = true;
    phase.value = 'recording';
    try {
      await deps.recorder.start();
    } catch (err) {
      recording = false;
      phase.value = 'idle';
      error.value = `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function stopTalk(): Promise<void> {
    if (!recording) return;
    recording = false;
    phase.value = 'transcribing';
    try {
      const clip = await deps.recorder.stop();
      // Released before the mic even opened: nothing was said, nothing to report.
      if (clip.bytes.byteLength === 0) return;
      const heard = await deps.client.voiceTranscribe(clip.bytes, clip.mimeType);
      if (!heard.ok) { error.value = heard.error; return; }
      append({ from: 'you', text: heard.text });
      const asked = await deps.client.voiceAsk(heard.text);
      if (!asked.ok) error.value = asked.error;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (phase.value === 'transcribing') phase.value = 'idle';
    }
  }

  function toggleTalk(): Promise<void> {
    return recording ? stopTalk() : startTalk();
  }

  async function speak(text: string): Promise<void> {
    if (!inCall.value) return;
    const voiced = await deps.client.voiceSpeak(text);
    if (!voiced.ok) { error.value = voiced.error; return; }
    if (!inCall.value) return;
    if (!recording) phase.value = 'speaking';
    try {
      await deps.player.play(voiced.audio, voiced.mimeType);
    } finally {
      if (phase.value === 'speaking') phase.value = 'idle';
    }
  }

  const unsubscribe = deps.client.onVoiceOperatorReply((reply) => {
    append({ from: 'helm', text: reply.text });
    if (!inCall.value) return;
    speechQueue = speechQueue.then(() => speak(reply.text)).catch((err) => {
      error.value = err instanceof Error ? err.message : String(err);
    });
  });

  function hangUp(): void {
    inCall.value = false;
    deps.player.stop();
    if (recording) void stopTalk();
  }

  return { inCall, phase, transcript, error, startTalk, stopTalk, toggleTalk, hangUp, dispose: unsubscribe };
}

export type VoiceCall = ReturnType<typeof createVoiceCall>;
