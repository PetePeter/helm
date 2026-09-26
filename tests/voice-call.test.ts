/**
 * createVoiceCall — the renderer half of desktop voice. Real controller over a
 * fake IPC bridge, a fake recorder and a fake speaker.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createVoiceCall, type VoiceCallClient, type VoiceRecorder, type VoicePlayer } from '../renderer/voice/voice-call';

type ReplyListener = (reply: { sessionId: string; text: string }) => void;

class FakeClient implements VoiceCallClient {
  listener: ReplyListener | null = null;
  asked: string[] = [];
  spoken: string[] = [];
  transcript = 'status please';
  transcribeError: string | null = null;
  /** Resolve speak() calls in whatever order the test chooses. */
  pendingSpeaks: Array<() => void> = [];
  holdSpeak = false;

  async voiceTranscribe(_audio: Uint8Array, _mimeType: string) {
    return this.transcribeError ? { ok: false as const, error: this.transcribeError } : { ok: true as const, text: this.transcript };
  }
  async voiceSpeak(text: string) {
    this.spoken.push(text);
    if (this.holdSpeak) await new Promise<void>(resolve => this.pendingSpeaks.push(resolve));
    return { ok: true as const, audio: new TextEncoder().encode(text), mimeType: 'audio/ogg' };
  }
  async voiceAsk(text: string) {
    this.asked.push(text);
    return { ok: true as const };
  }
  onVoiceOperatorReply(callback: ReplyListener) {
    this.listener = callback;
    return () => { this.listener = null; };
  }
  reply(text: string) {
    this.listener?.({ sessionId: 'op', text });
  }
}

class FakeRecorder implements VoiceRecorder {
  recording = false;
  async start() { this.recording = true; }
  async stop() {
    this.recording = false;
    return { bytes: new Uint8Array([1, 2]), mimeType: 'audio/webm' };
  }
}

class FakePlayer implements VoicePlayer {
  played: string[] = [];
  stops = 0;
  async play(audio: Uint8Array) { this.played.push(new TextDecoder().decode(audio)); }
  stop() { this.stops += 1; }
}

let client: FakeClient;
let recorder: FakeRecorder;
let player: FakePlayer;
let operatorOn: boolean;

function make() {
  return createVoiceCall({ client, recorder, player, hasOperator: () => operatorOn });
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  client = new FakeClient();
  recorder = new FakeRecorder();
  player = new FakePlayer();
  operatorOn = true;
});

describe('voice call hold-to-talk', () => {
  it('press records, release transcribes and asks the operator', async () => {
    const call = make();

    await call.startTalk();
    expect(recorder.recording).toBe(true);
    expect(call.inCall.value).toBe(true);
    expect(call.phase.value).toBe('recording');

    await call.stopTalk();
    expect(recorder.recording).toBe(false);
    expect(client.asked).toEqual(['status please']);
    expect(call.transcript.value).toEqual([{ from: 'you', text: 'status please' }]);
    expect(call.phase.value).toBe('idle');
  });

  it('refuses to record while no operator exists', async () => {
    operatorOn = false;
    const call = make();

    await call.startTalk();

    expect(recorder.recording).toBe(false);
    expect(call.error.value).toMatch(/operator/i);
  });

  it('surfaces a transcription failure and asks nothing', async () => {
    client.transcribeError = 'OpenWhispr is not configured';
    const call = make();

    await call.startTalk();
    await call.stopTalk();

    expect(client.asked).toEqual([]);
    expect(call.error.value).toBe('OpenWhispr is not configured');
  });

  it('toggleTalk starts then stops (the keyboard hotkey path)', async () => {
    const call = make();
    await call.toggleTalk();
    expect(recorder.recording).toBe(true);
    await call.toggleTalk();
    expect(client.asked).toEqual(['status please']);
  });
});

describe('voice call operator replies', () => {
  it('speaks each reply exactly once, in arrival order', async () => {
    client.holdSpeak = true;
    const call = make();
    await call.startTalk();
    await call.stopTalk();

    client.reply('first');
    client.reply('second');
    await flush();
    // Serialized: the second is not synthesized until the first has played.
    expect(client.spoken).toEqual(['first']);
    client.pendingSpeaks.shift()!();
    await flush(); await flush();
    expect(client.spoken).toEqual(['first', 'second']);
    client.pendingSpeaks.shift()!();
    await flush(); await flush();

    expect(player.played).toEqual(['first', 'second']);
    expect(call.transcript.value.map(line => line.text)).toEqual(['status please', 'first', 'second']);
  });

  it('shows but does not speak replies when no call is open', async () => {
    const call = make();

    client.reply('while away');
    await flush();

    expect(client.spoken).toEqual([]);
    expect(call.transcript.value).toEqual([{ from: 'helm', text: 'while away' }]);
  });

  it('hangUp cuts off the clip that is already playing', async () => {
    const call = make();
    await call.startTalk();
    await call.stopTalk();

    call.hangUp();

    expect(player.stops).toBe(1);
    expect(call.inCall.value).toBe(false);
  });

  it('a release before the mic opened reports nothing and asks nothing', async () => {
    recorder.stop = async () => ({ bytes: new Uint8Array(), mimeType: 'audio/webm' });
    const call = make();
    await call.startTalk();
    await call.stopTalk();

    expect(client.asked).toEqual([]);
    expect(call.error.value).toBeNull();
  });

  it('hangUp stops speaking later replies and dispose unsubscribes', async () => {
    const call = make();
    await call.startTalk();
    await call.stopTalk();
    call.hangUp();

    client.reply('after hang up');
    await flush();
    expect(client.spoken).toEqual([]);

    call.dispose();
    expect(client.listener).toBeNull();
  });
});
