import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HelmTelegramService } from '../src/mcp/services/helm-telegram-service';
import type { TelegramBridge, TelegramSendToUserInput, TelegramSendToUserResult } from '../src/types/telegram-channel.js';
import type { TelegramCapabilities } from '../src/session/capability-detector.js';

const ttsMocks = vi.hoisted(() => ({
  synthesize: vi.fn(async () => ({ oggPath: 'C:/Temp/helm-voice.ogg' })),
}));

vi.mock('../src/voice/piper-tts.js', () => ({
  PiperTts: vi.fn().mockImplementation(function () {
    return {
      synthesize: ttsMocks.synthesize,
    };
  }),
}));

/** Fake CapabilityDetector returning a fixed capability snapshot. */
class FakeCapabilityDetector {
  constructor(private caps: TelegramCapabilities) {}
  getCapabilities(): TelegramCapabilities {
    return this.caps;
  }
  invalidateCache(): void {}
}

/** Fake bridge recording the last sendToUser input. */
class FakeBridge implements TelegramBridge {
  lastInput: TelegramSendToUserInput | null = null;
  constructor(private running: boolean) {}
  isRunning(): boolean {
    return this.running;
  }
  listChannels() {
    return [];
  }
  async createChannel(): Promise<never> {
    throw new Error('not used');
  }
  closeChannel() {
    return null;
  }
  async sendToUser(input: TelegramSendToUserInput): Promise<TelegramSendToUserResult> {
    this.lastInput = input;
    return { sent: true, documentId: 99 };
  }
}

const fakeConfigLoader = {
  getTelegramConfig: () => ({
    enabled: true,
    piperPath: 'piper',
    piperVoicePath: 'voice.onnx',
    ffmpegPath: 'ffmpeg',
  }),
} as any;

const fakeSessionManager = {
  getSession: (id: string) => (id === 'sess-1' ? { id: 'sess-1', name: 'Alpha' } : null),
  getAllSessions: () => [{ id: 'sess-1', name: 'Alpha' }],
} as any;

function makeService(caps: Partial<TelegramCapabilities>, bridge: FakeBridge | null) {
  const detector = new FakeCapabilityDetector({
    available: true,
    openwhisper: false,
    piper: false,
    ffmpeg: false,
    ...caps,
  }) as any;
  const svc = new HelmTelegramService(fakeConfigLoader, fakeSessionManager, detector);
  if (bridge) svc.setTelegramBridge(bridge);
  return svc;
}

describe('HelmTelegramService.getTelegramStatus capabilities', () => {
  it('maps flat detector flags + paths into the nested capabilities shape', () => {
    const svc = makeService(
      {
        openwhisper: true,
        openwhisperPath: 'ow',
        piper: true,
        piperPath: 'pp',
        ffmpeg: false,
      },
      new FakeBridge(true),
    );
    const caps = svc.getTelegramStatus().capabilities;
    expect(caps.openwhisper).toEqual({ available: true, path: 'ow' });
    expect(caps.piper).toEqual({ available: true, path: 'pp' });
    expect(caps.ffmpeg).toEqual({ available: false });
  });
});

describe('HelmTelegramService.sendTelegramVoice', () => {
  beforeEach(() => {
    ttsMocks.synthesize.mockClear();
  });

  it('returns reason when bot is not running', async () => {
    const svc = makeService({ piper: true, ffmpeg: true }, new FakeBridge(false));
    const res = await svc.sendTelegramVoice('sess-1', 'hi');
    expect(res).toEqual({ sent: false, reason: 'Telegram bot is not running' });
  });

  it('returns reason when piper is unavailable', async () => {
    const svc = makeService({ piper: false, ffmpeg: true }, new FakeBridge(true));
    const res = await svc.sendTelegramVoice('sess-1', 'hi');
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/piper/i);
  });

  it('returns reason when ffmpeg is unavailable', async () => {
    const svc = makeService({ piper: true, ffmpeg: false }, new FakeBridge(true));
    const res = await svc.sendTelegramVoice('sess-1', 'hi');
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/ffmpeg/i);
  });

  it('returns reason when text is empty', async () => {
    const svc = makeService({ piper: true, ffmpeg: true }, new FakeBridge(true));
    const res = await svc.sendTelegramVoice('sess-1', '   ');
    expect(res.sent).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it('returns reason when session is not found', async () => {
    const svc = makeService({ piper: true, ffmpeg: true }, new FakeBridge(true));
    const res = await svc.sendTelegramVoice('nope', 'hi');
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/Session not found/i);
  });

  it('synthesizes and sends a voice message for a valid session', async () => {
    const bridge = new FakeBridge(true);
    const svc = makeService({ piper: true, ffmpeg: true }, bridge);

    const res = await svc.sendTelegramVoice('sess-1', 'hello from helm');

    expect(res).toEqual({ sent: true });
    expect(ttsMocks.synthesize).toHaveBeenCalledWith('hello from helm');
    expect(bridge.lastInput).toEqual({
      sessionId: 'sess-1',
      text: '',
      filePath: 'C:/Temp/helm-voice.ogg',
      asVoice: true,
    });
  });
});
