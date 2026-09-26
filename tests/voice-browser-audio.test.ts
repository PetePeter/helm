/**
 * Browser recorder/player lifecycle with the platform constructors faked:
 * a release during a pending getUserMedia must never leave the mic open.
 */
import { describe, it, expect } from 'vitest';
import { createAudioPlayer, createMediaRecorder } from '../renderer/voice/browser-audio';

class FakeTrack { stopped = false; stop() { this.stopped = true; } }

function fakeStream() {
  const track = new FakeTrack();
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
}

class FakeMediaRecorder {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = 'audio/webm';
  started = false;
  constructor(readonly stream: MediaStream) {}
  start() { this.started = true; }
  stop() {
    this.ondataavailable?.({ data: new Blob([new Uint8Array([7, 8])]) });
    this.onstop?.();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('createMediaRecorder', () => {
  it('records a clip and releases the mic after stop', async () => {
    const { track, stream } = fakeStream();
    const recorders: FakeMediaRecorder[] = [];
    const recorder = createMediaRecorder({
      getUserMedia: async () => stream,
      createRecorder: (s) => { const r = new FakeMediaRecorder(s); recorders.push(r); return r as unknown as MediaRecorder; },
    });

    await recorder.start();
    const clip = await recorder.stop();

    expect(recorders[0].started).toBe(true);
    expect(Array.from(clip.bytes)).toEqual([7, 8]);
    expect(track.stopped).toBe(true);
  });

  it('a stop during a pending getUserMedia closes the late stream and never records', async () => {
    const { track, stream } = fakeStream();
    const media = deferred<MediaStream>();
    let created = 0;
    const recorder = createMediaRecorder({
      getUserMedia: () => media.promise,
      createRecorder: (s) => { created += 1; return new FakeMediaRecorder(s) as unknown as MediaRecorder; },
    });

    const starting = recorder.start();
    const stopping = recorder.stop();
    media.resolve(stream);
    await starting;
    const clip = await stopping;

    expect(created).toBe(0);
    expect(track.stopped).toBe(true);
    expect(clip.bytes.byteLength).toBe(0);
  });
});

describe('createAudioPlayer', () => {
  it('stop pauses the playing clip, resolves play and revokes its URL', async () => {
    const revoked: string[] = [];
    let paused = false;
    const player = createAudioPlayer({
      createUrl: () => 'blob:1',
      revokeUrl: (url) => revoked.push(url),
      createAudio: () => ({
        play: () => Promise.resolve(),
        pause: () => { paused = true; },
      }) as unknown as HTMLAudioElement,
    });

    const playing = player.play(new Uint8Array([1]), 'audio/ogg');
    player.stop();
    await playing;

    expect(paused).toBe(true);
    expect(revoked).toEqual(['blob:1']);
  });
});
