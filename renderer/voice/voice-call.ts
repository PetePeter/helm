/**
 * Desktop voice call — hold-to-talk to the Helm operator (docs/voice-operator.md).
 *
 * The controller owns the call state; everything with a side effect (IPC,
 * microphone, speakers) is injected so it runs under test with fakes. A call is
 * "open" from the first talk until hang-up: while open, every operator reply is
 * spoken once, strictly in arrival order. Replies that land with no call open
 * are still shown — the phone may be the one talking — but never spoken.
 *
 * Hands-free (startCall): the mic stays open and a Vad cuts it into segments;
 * each segment is transcribed and sent. The mic is paused while a reply plays
 * so Helm never hears itself, then listens again until hang-up.
 */
import { ref } from 'vue';
import { Vad } from './vad.js';

export type VoiceCallPhase = 'idle' | 'listening' | 'recording' | 'transcribing' | 'speaking';

export interface VoiceTranscriptLine {
  from: 'you' | 'helm';
  text: string;
}

type Fail = { ok: false; error: string };

export interface VoiceCallClient {
  voiceTranscribe(audio: Uint8Array, mimeType: string): Promise<{ ok: true; text: string } | Fail>;
  voiceSpeak(text: string): Promise<{ ok: true; audio: Uint8Array; mimeType: string } | Fail>;
  voiceAsk(text: string): Promise<{ ok: true } | Fail>;
  voiceLastOperatorReply(): Promise<string | null>;
  onVoiceOperatorReply(callback: (reply: { sessionId: string; text: string }) => void): () => void;
}

export interface VoiceRecorder {
  start(): Promise<void>;
  stop(): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

/** An always-open mic for hands-free calls; `take` pauses it, `listen` resumes. */
export interface VoiceMic {
  /** Open the mic; energies arrive (one per frame) only while listening. */
  open(onEnergy: (energy: number, atMs: number) => void): Promise<void>;
  /** Start a fresh recording and resume energy frames. */
  listen(): void;
  /** Stop recording and energy frames (mic stays open); returns what was recorded. */
  take(): Promise<{ bytes: Uint8Array; mimeType: string }>;
  close(): void;
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
  mic: VoiceMic;
  hasOperator: () => boolean;
  vad?: Vad;
  /** Quiet gap after a reply before the mic listens again (room echo tail). */
  resumeDelayMs?: number;
}

const DEFAULT_RESUME_DELAY_MS = 300;

const OPERATOR_OFF = 'The Helm operator is off — enable it in Settings → Operator';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Keep the panel readable; the phone holds the full history. */
const MAX_TRANSCRIPT_LINES = 50;

export function createVoiceCall(deps: VoiceCallDeps) {
  const inCall = ref(false);
  const phase = ref<VoiceCallPhase>('idle');
  const transcript = ref<VoiceTranscriptLine[]>([]);
  const error = ref<string | null>(null);
  const handsFree = ref(false);
  const vad = deps.vad ?? new Vad();
  const resumeDelayMs = deps.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS;
  /** Bumped by every call start and hang-up: async work from an older call is stale. */
  let callGeneration = 0;
  let opening = false;

  let recording = false;
  let speechQueue: Promise<void> = Promise.resolve();

  function append(line: VoiceTranscriptLine): void {
    transcript.value = [...transcript.value, line].slice(-MAX_TRANSCRIPT_LINES);
  }

  /** Transcribe a clip and send it to the operator; empty speech sends nothing. */
  async function send(clip: { bytes: Uint8Array; mimeType: string }): Promise<void> {
    if (clip.bytes.byteLength === 0) return;
    const heard = await deps.client.voiceTranscribe(clip.bytes, clip.mimeType);
    if (!heard.ok) { error.value = heard.error; return; }
    const text = heard.text.trim();
    if (!text) return;
    append({ from: 'you', text });
    const asked = await deps.client.voiceAsk(text);
    if (!asked.ok) error.value = asked.error;
  }

  async function startTalk(): Promise<void> {
    if (recording || handsFree.value) return;
    if (!deps.hasOperator()) {
      error.value = OPERATOR_OFF;
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
      error.value = `Microphone unavailable: ${message(err)}`;
    }
  }

  async function stopTalk(): Promise<void> {
    if (!recording) return;
    recording = false;
    phase.value = 'transcribing';
    try {
      // A release before the mic even opened yields an empty clip: nothing to send.
      await send(await deps.recorder.stop());
    } catch (err) {
      error.value = message(err);
    } finally {
      if (phase.value === 'transcribing') phase.value = 'idle';
    }
  }

  function toggleTalk(): Promise<void> {
    return recording ? stopTalk() : startTalk();
  }

  function listen(): void {
    vad.reset();
    deps.mic.listen();
    phase.value = 'listening';
  }

  async function onSegmentEnd(): Promise<void> {
    const generation = callGeneration;
    phase.value = 'transcribing';
    try {
      await send(await deps.mic.take());
    } catch (err) {
      error.value = message(err);
    } finally {
      if (generation === callGeneration && phase.value === 'transcribing') listen();
    }
  }

  /** Drop a recording that held no real speech and start a fresh one. */
  async function restartListening(): Promise<void> {
    const generation = callGeneration;
    await deps.mic.take();
    if (generation === callGeneration && phase.value === 'listening') listen();
  }

  function onEnergy(energy: number, atMs: number): void {
    const event = vad.feed(energy, atMs);
    if (event === 'end') void onSegmentEnd();
    else if (event === 'discard') void restartListening();
  }

  async function startCall(): Promise<void> {
    if (handsFree.value || opening) return;
    if (!deps.hasOperator()) { error.value = OPERATOR_OFF; return; }
    if (recording) await stopTalk();
    error.value = null;
    const generation = ++callGeneration;
    opening = true;
    try {
      await deps.mic.open(onEnergy);
    } catch (err) {
      if (generation === callGeneration) error.value = `Microphone unavailable: ${message(err)}`;
      return;
    } finally {
      if (generation === callGeneration) opening = false;
    }
    // Hung up (or toggled off) while the mic was opening.
    if (generation !== callGeneration) { deps.mic.close(); return; }
    handsFree.value = true;
    inCall.value = true;
    listen();
  }

  /** The `voice-call` binding: a press while opening or in a call hangs up. */
  function toggleCall(): Promise<void> {
    if (handsFree.value || opening) { hangUp(); return Promise.resolve(); }
    return startCall();
  }

  function resumeAfterReply(): void {
    const generation = callGeneration;
    setTimeout(() => {
      if (generation === callGeneration && phase.value === 'speaking') listen();
    }, resumeDelayMs);
  }

  async function speak(text: string): Promise<void> {
    if (!inCall.value) return;
    const voiced = await deps.client.voiceSpeak(text);
    if (!voiced.ok) { error.value = voiced.error; return; }
    if (!inCall.value) return;
    // Pause a hands-free mic so Helm never hears itself; mid-sentence speech is dropped.
    if (handsFree.value && phase.value === 'listening') await deps.mic.take();
    if (!recording) phase.value = 'speaking';
    try {
      await deps.player.play(voiced.audio, voiced.mimeType);
    } finally {
      if (phase.value === 'speaking') {
        if (handsFree.value) resumeAfterReply();
        else phase.value = 'idle';
      }
    }
  }

  const unsubscribe = deps.client.onVoiceOperatorReply((reply) => {
    append({ from: 'helm', text: reply.text });
    if (!inCall.value) return;
    speechQueue = speechQueue.then(() => speak(reply.text)).catch((err) => {
      error.value = message(err);
    });
  });

  // The transcript is memory-only; seed the last reply from the journal so it
  // outlives a restart. A live reply that already landed is newer — keep it.
  void deps.client.voiceLastOperatorReply().then((text) => {
    if (text && !transcript.value.some(line => line.from === 'helm')) {
      transcript.value = [{ from: 'helm', text }, ...transcript.value];
    }
  }).catch(() => undefined);

  function hangUp(): void {
    callGeneration += 1;
    opening = false;
    inCall.value = false;
    deps.player.stop();
    if (handsFree.value) {
      handsFree.value = false;
      vad.reset();
      deps.mic.close();
      phase.value = 'idle';
    }
    if (recording) void stopTalk();
  }

  return {
    inCall, handsFree, phase, transcript, error,
    startTalk, stopTalk, toggleTalk, startCall, toggleCall, hangUp, dispose: unsubscribe,
  };
}

export type VoiceCall = ReturnType<typeof createVoiceCall>;
