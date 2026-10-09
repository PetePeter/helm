import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelmTelegramService } from '../src/mcp/services/helm-telegram-service';
import { ChatBroker } from '../src/session/chat/chat-broker.js';
import type { ChatOutboundMessage } from '../src/session/chat/chat-bridge.js';
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

describe('HelmTelegramService.sendTelegramChat usage badge', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm-chat-usage-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A CLI session whose transcript holds one Claude reply of `tokens` context. */
  function cliSession(tokens: number | null, cliType = 'claude'): Record<string, unknown> {
    if (tokens === null) return { id: 'cli-1', name: 'Cli', cliType };
    const cliTranscriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(cliTranscriptPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [], usage: { input_tokens: tokens, output_tokens: 0 } },
    }));
    return { id: 'cli-1', name: 'Cli', cliType, cliTranscriptPath };
  }

  /** The service over a real broker with one recording chat surface. */
  function chatService(session: Record<string, unknown>, cliTypes: Record<string, { contextWindow?: number }> = {}) {
    const sent: ChatOutboundMessage[] = [];
    const broker = new ChatBroker();
    broker.register({
      provider: 'recorder',
      isAvailable: () => true,
      sendToSession: async (message) => {
        sent.push(message);
        return { sent: true };
      },
    });
    const svc = new HelmTelegramService(
      { ...fakeConfigLoader, getCliTypeEntry: (id: string) => cliTypes[id] } as any,
      { getSession: (id: string) => (id === session.id ? session : null) } as any,
      new FakeCapabilityDetector({ available: true, openwhisper: false, piper: false, ffmpeg: false }) as any,
    );
    svc.setChatBroker(broker);
    return { svc, sent };
  }

  it('fills a CLI session\'s reply with the context size from its transcript', async () => {
    const { svc, sent } = chatService(cliSession(60_000));
    expect(await svc.sendTelegramChat('cli-1', 'done')).toEqual({ sent: true });
    expect(sent[0].usage).toEqual({ contextTokens: 60_000 });
  });

  it('adds the CLI type\'s configured window when the transcript names none', async () => {
    const { svc, sent } = chatService(cliSession(60_000), { claude: { contextWindow: 200_000 } });
    await svc.sendTelegramChat('cli-1', 'done');
    expect(sent[0].usage).toEqual({ contextTokens: 60_000, contextWindow: 200_000 });
  });

  it('keeps Codex\'s reported model window ahead of the configured fallback', async () => {
    const cliTranscriptPath = join(dir, 'codex-transcript.jsonl');
    writeFileSync(cliTranscriptPath, JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-10-10T09:30:00Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { total_tokens: 125_000 }, model_context_window: 250_000 },
      },
    }));
    const { svc, sent } = chatService(
      { id: 'cli-1', name: 'Codex', cliType: 'codex', cliTranscriptPath },
      { codex: { contextWindow: 200_000 } },
    );

    await svc.sendTelegramChat('cli-1', 'done');
    expect(sent[0].usage).toEqual({ contextTokens: 125_000, contextWindow: 250_000 });
  });

  it('keeps the usage an API session passed rather than reading a transcript', async () => {
    const { svc, sent } = chatService(cliSession(60_000), { claude: { contextWindow: 200_000 } });
    await svc.sendTelegramChat('cli-1', 'done', undefined, { contextTokens: 1234, toolCalls: 2 });
    expect(sent[0].usage).toEqual({ contextTokens: 1234, toolCalls: 2, contextWindow: 200_000 });
  });

  it('preserves API tool-call usage when the reported context count is zero', async () => {
    const apiSession = { id: 'cli-1', name: 'API', cliType: 'api', apiTool: true };
    const { svc, sent } = chatService(apiSession, { api: { contextWindow: 200_000 } });

    await svc.sendTelegramChat('cli-1', 'done', undefined, { contextTokens: 0, toolCalls: 2 });
    expect(sent[0].usage).toEqual({ contextTokens: 0, toolCalls: 2, contextWindow: 200_000 });
  });

  it('still sends, without a badge, when the session has no transcript', async () => {
    const { svc, sent } = chatService(cliSession(null), { claude: { contextWindow: 200_000 } });
    expect(await svc.sendTelegramChat('cli-1', 'done')).toEqual({ sent: true });
    expect(sent[0]).toEqual({ sessionId: 'cli-1', text: 'done' });
  });
});
