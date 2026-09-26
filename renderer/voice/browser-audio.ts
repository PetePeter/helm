/**
 * Browser microphone + speaker for the desktop voice call. The platform
 * constructors are injectable so the lifecycle rules below run under test.
 *
 * Recorder rule: a stop() that lands while getUserMedia is still pending must
 * not leak an open mic — stop() waits for the pending start, and a start that
 * resolves after being cancelled releases its tracks without ever recording.
 */
import type { VoicePlayer, VoiceRecorder } from './voice-call.js';

export interface MediaRecorderDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder: (stream: MediaStream) => MediaRecorder;
}

const browserRecorderDeps: MediaRecorderDeps = {
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createRecorder: (stream) => new MediaRecorder(stream),
};

const EMPTY_CLIP = { bytes: new Uint8Array(), mimeType: 'audio/webm' };

function releaseTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** MediaRecorder hold-to-talk. The mic is released after every clip. */
export function createMediaRecorder(deps: MediaRecorderDeps = browserRecorderDeps): VoiceRecorder {
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let pendingStart: Promise<void> | null = null;
  let cancelled = false;

  async function open(): Promise<void> {
    const stream = await deps.getUserMedia({ audio: true });
    if (cancelled) { releaseTracks(stream); return; }
    chunks = [];
    recorder = deps.createRecorder(stream);
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    recorder.start();
  }

  return {
    start() {
      cancelled = false;
      const started = open();
      pendingStart = started;
      return started.finally(() => { if (pendingStart === started) pendingStart = null; });
    },
    async stop() {
      cancelled = true;
      await pendingStart?.catch(() => {});
      const active = recorder;
      recorder = null;
      if (!active) return EMPTY_CLIP;
      return new Promise((resolve) => {
        active.onstop = async () => {
          releaseTracks(active.stream);
          const blob = new Blob(chunks, { type: active.mimeType || 'audio/webm' });
          resolve({ bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type });
        };
        active.stop();
      });
    },
  };
}

export interface AudioPlayerDeps {
  createAudio: (url: string) => HTMLAudioElement;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
}

const browserPlayerDeps: AudioPlayerDeps = {
  createAudio: (url) => new Audio(url),
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
};

/** Plays one clip to completion; stop() cuts the current clip short. */
export function createAudioPlayer(deps: AudioPlayerDeps = browserPlayerDeps): VoicePlayer {
  let finishCurrent: (() => void) | null = null;
  let current: HTMLAudioElement | null = null;

  return {
    play(audio, mimeType) {
      const url = deps.createUrl(new Blob([audio as BlobPart], { type: mimeType }));
      const element = deps.createAudio(url);
      current = element;
      return new Promise<void>((resolve) => {
        const done = () => {
          if (current === element) { current = null; finishCurrent = null; }
          deps.revokeUrl(url);
          resolve();
        };
        finishCurrent = done;
        element.onended = done;
        element.onerror = done;
        element.play().catch(done);
      });
    },
    stop() {
      current?.pause();
      finishCurrent?.();
    },
  };
}
