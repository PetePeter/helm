/**
 * createVoiceCall — the renderer half of desktop voice. Real controller over a
 * fake IPC bridge, a fake recorder and a fake speaker.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createVoiceCall, type VoiceCallClient, type VoiceRecorder, type VoicePlayer, type VoiceMic } from '../renderer/voice/voice-call';

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
  lastReply: string | null = null;
  async voiceLastOperatorReply() {
    return this.lastReply;
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

class FakeMic implements VoiceMic {
  onEnergy: ((energy: number, atMs: number) => void) | null = null;
  open_ = false;
  listening = false;
  takes = 0;
  async open(onEnergy: (energy: number, atMs: number) => void) { this.onEnergy = onEnergy; this.open_ = true; }
  listen() { this.listening = true; }
  async take() {
    this.listening = false;
    this.takes += 1;
    return { bytes: new Uint8Array([9]), mimeType: 'audio/webm' };
  }
  close() { this.open_ = false; this.listening = false; this.onEnergy = null; }
  /** Say something: loud for 500ms, then silence past the hangover. */
  talk(start: number) {
    for (let t = start; t < start + 500; t += 20) if (this.listening) this.onEnergy?.(0.5, t);
    for (let t = start + 500; t < start + 1500; t += 20) if (this.listening) this.onEnergy?.(0.001, t);
  }
}

let client: FakeClient;
let mic: FakeMic;
let recorder: FakeRecorder;
let player: FakePlayer;
let operatorOn: boolean;

function make() {
  return createVoiceCall({ client, recorder, player, mic, hasOperator: () => operatorOn, resumeDelayMs: 0 });
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  client = new FakeClient();
  recorder = new FakeRecorder();
  player = new FakePlayer();
  mic = new FakeMic();
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

  // Regression: the sidebar's "last reply" was blank after every restart — the
  // transcript lived only in memory while the reply sat in the chat journal.
  it('shows the persisted last reply from before a restart, unspoken', async () => {
    client.lastReply = 'On it.';
    const call = make();
    await flush();

    expect(call.transcript.value).toEqual([{ from: 'helm', text: 'On it.' }]);
    expect(client.spoken).toEqual([]);
  });

  it('a live reply that lands first is not buried by the persisted one', async () => {
    client.lastReply = 'old';
    const call = make();
    client.reply('new');
    await flush();

    expect(call.transcript.value).toEqual([{ from: 'helm', text: 'new' }]);
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

describe('voice call hands-free', () => {
  it('listens, sends each spoken segment, speaks the reply with the mic paused, then listens again', async () => {
    const call = make();
    await call.startCall();
    expect(call.handsFree.value).toBe(true);
    expect(call.phase.value).toBe('listening');
    expect(mic.listening).toBe(true);

    mic.talk(0);
    await flush(); await flush();
    expect(client.asked).toEqual(['status please']);
    expect(call.phase.value).toBe('listening');
    expect(mic.listening).toBe(true);

    let listeningWhilePlaying: boolean | null = null;
    player.play = async (audio: Uint8Array) => { listeningWhilePlaying = mic.listening; player.played.push(new TextDecoder().decode(audio)); };
    client.reply('all green');
    await flush(); await flush(); await flush();
    expect(player.played).toEqual(['all green']);
    expect(listeningWhilePlaying).toBe(false);
    expect(mic.listening).toBe(true);

    mic.talk(5000);
    await flush(); await flush();
    expect(client.asked).toEqual(['status please', 'status please']);
  });

  it('an empty transcript asks nothing and keeps listening', async () => {
    client.transcript = '   ';
    const call = make();
    await call.startCall();
    mic.talk(0);
    await flush(); await flush();
    expect(client.asked).toEqual([]);
    expect(mic.listening).toBe(true);
  });

  it('refuses to start with no operator', async () => {
    operatorOn = false;
    const call = make();
    await call.startCall();
    expect(mic.open_).toBe(false);
    expect(call.error.value).toMatch(/operator/i);
  });

  it('hang up releases the mic and ends the call; toggleCall flips it', async () => {
    const call = make();
    await call.toggleCall();
    expect(mic.open_).toBe(true);
    await call.toggleCall();
    expect(mic.open_).toBe(false);
    expect(call.inCall.value).toBe(false);
    expect(call.handsFree.value).toBe(false);
    expect(call.phase.value).toBe('idle');
  });

  it('a blip is dropped and listening restarts with a fresh recording', async () => {
    const call = make();
    await call.startCall();
    for (let t = 0; t < 60; t += 20) mic.onEnergy?.(0.5, t);
    for (let t = 60; t < 1000; t += 20) mic.onEnergy?.(0.001, t);
    await flush();
    expect(mic.takes).toBe(1);
    expect(mic.listening).toBe(true);
    expect(client.asked).toEqual([]);
    expect(call.phase.value).toBe('listening');
  });

  it('toggling twice while the mic is still opening cancels the call and closes the mic', async () => {
    let finishOpen!: () => void;
    let closes = 0;
    mic.open = () => new Promise<void>(resolve => { finishOpen = resolve; });
    mic.close = () => { closes += 1; };
    const call = make();
    const first = call.toggleCall();
    await call.toggleCall();
    finishOpen();
    await first;
    expect(closes).toBe(1);
    expect(call.inCall.value).toBe(false);
    expect(call.handsFree.value).toBe(false);
    expect(mic.listening).toBe(false);
  });

  it('hang up during open closes the mic once it opens', async () => {
    let finishOpen!: () => void;
    let closes = 0;
    mic.open = () => new Promise<void>(resolve => { finishOpen = resolve; });
    mic.close = () => { closes += 1; };
    const call = make();
    const started = call.startCall();
    call.hangUp();
    finishOpen();
    await started;
    expect(closes).toBe(1);
    expect(call.inCall.value).toBe(false);
  });

  it('hang up mid-transcribe does not resume listening', async () => {
    let finishTranscribe!: () => void;
    const transcribe = client.voiceTranscribe.bind(client);
    client.voiceTranscribe = async (a, m) => { await new Promise<void>(r => { finishTranscribe = r; }); return transcribe(a, m); };
    const call = make();
    await call.startCall();
    mic.talk(0);
    await flush();
    expect(call.phase.value).toBe('transcribing');
    call.hangUp();
    finishTranscribe();
    await flush(); await flush();
    expect(mic.listening).toBe(false);
    expect(call.phase.value).toBe('idle');
  });

  it('a mic failure reports and leaves no call open', async () => {
    mic.open = async () => { throw new Error('denied'); };
    const call = make();
    await call.startCall();
    expect(call.inCall.value).toBe(false);
    expect(call.error.value).toMatch(/denied/);
  });
});
