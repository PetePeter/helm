/**
 * Browser recorder/player lifecycle with the platform constructors faked:
 * a release during a pending getUserMedia must never leave the mic open.
 */
import { describe, it, expect } from 'vitest';
import { createAudioPlayer, createBrowserMic, createMediaRecorder } from '../renderer/voice/browser-audio';

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

class FakeAudioContext {
  closed = false;
  failAnalyser = false;
  createAnalyser() {
    if (this.failAnalyser) throw new Error('no analyser');
    return { fftSize: 0, getFloatTimeDomainData: () => {} } as unknown as AnalyserNode;
  }
  createMediaStreamSource() { return { connect: () => {} } as unknown as MediaStreamAudioSourceNode; }
  async close() { this.closed = true; }
}

function micWith(stream: MediaStream, context: FakeAudioContext) {
  const constraints: MediaStreamConstraints[] = [];
  const mic = createBrowserMic({
    getUserMedia: async (c) => { constraints.push(c); return stream; },
    createRecorder: (s) => new FakeMediaRecorder(s) as unknown as MediaRecorder,
    createAudioContext: () => context as unknown as AudioContext,
  });
  return { mic, constraints };
}

describe('createBrowserMic', () => {
  it('asks for echo-cancelled audio and close() stops the tracks and the audio context', async () => {
    const { track, stream } = fakeStream();
    const context = new FakeAudioContext();
    const { mic, constraints } = micWith(stream, context);

    await mic.open(() => {});
    mic.close();

    expect(constraints[0].audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(track.stopped).toBe(true);
    expect(context.closed).toBe(true);
  });

  it('a failure after getUserMedia releases the mic and rethrows', async () => {
    const { track, stream } = fakeStream();
    const context = new FakeAudioContext();
    context.failAnalyser = true;
    const { mic } = micWith(stream, context);

    await expect(mic.open(() => {})).rejects.toThrow('no analyser');
    expect(track.stopped).toBe(true);
    expect(context.closed).toBe(true);
  });

  it('re-opening releases the previous stream first', async () => {
    const first = fakeStream();
    const context = new FakeAudioContext();
    const { mic } = micWith(first.stream, context);
    await mic.open(() => {});
    await mic.open(() => {});
    expect(first.track.stopped).toBe(true);
  });
});
