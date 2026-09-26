/**
 * VoiceService — desktop hold-to-talk plumbing over the SHARED OpenWhispr/Piper
 * modules. Real service, real temp dir; only the STT/TTS engines are faked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VoiceService, type VoiceTools } from '../src/voice/voice-service';
import type { AudioTranscriber } from '../src/voice/openwhispr-transcriber';

let tempDir: string;
let tools: VoiceTools;
let seenInputs: string[];
let transcriber: AudioTranscriber;
let ttsCalls: string[];

function service(): VoiceService {
  return new VoiceService({
    getConfig: () => ({ openWhisprPath: 'ow', piperPath: 'piper', piperVoicePath: 'voice.onnx', ffmpegPath: 'ffmpeg' }),
    getTools: () => tools,
    tempDir,
    createTranscriber: () => transcriber,
    createTts: (_config, tmpDir) => ({
      synthesize: async (text: string) => {
        ttsCalls.push(text);
        const oggPath = path.join(tmpDir, `out-${ttsCalls.length}.ogg`);
        await fs.promises.writeFile(oggPath, Buffer.from('OggS-fake'));
        return { oggPath };
      },
    }),
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-voice-'));
  tools = { openwhisper: true, piper: true, ffmpeg: true };
  seenInputs = [];
  ttsCalls = [];
  transcriber = {
    transcribe: async (filePath: string) => {
      seenInputs.push(filePath);
      expect(fs.existsSync(filePath)).toBe(true);
      const transcriptPath = `${filePath}.transcript.txt`;
      await fs.promises.writeFile(transcriptPath, 'hello helm\n');
      return { text: 'hello helm', transcriptPath };
    },
  };
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('VoiceService.transcribe', () => {
  it('writes the audio under the temp dir, returns the text, and leaves nothing behind', async () => {
    const result = await service().transcribe(new Uint8Array([1, 2, 3]), 'audio/webm;codecs=opus');

    expect(result).toEqual({ ok: true, text: 'hello helm' });
    expect(seenInputs).toHaveLength(1);
    expect(path.dirname(seenInputs[0])).toBe(tempDir);
    expect(path.extname(seenInputs[0])).toBe('.webm');
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('deletes the temp audio when transcription throws', async () => {
    transcriber = {
      transcribe: async (filePath: string) => {
        seenInputs.push(filePath);
        throw new Error('whisper exploded');
      },
    };

    const result = await service().transcribe(new Uint8Array([1]), 'audio/webm');

    expect(result).toEqual({ ok: false, error: expect.stringContaining('whisper exploded') });
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('reports no speech when the transcriber hears nothing', async () => {
    transcriber = { transcribe: async () => null };

    const result = await service().transcribe(new Uint8Array([1]), 'audio/webm');

    expect(result.ok).toBe(false);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('refuses without spawning anything when OpenWhispr is not configured', async () => {
    tools = { openwhisper: false, piper: true, ffmpeg: true };

    const result = await service().transcribe(new Uint8Array([1]), 'audio/webm');

    expect(result).toEqual({ ok: false, error: expect.stringContaining('OpenWhispr') });
    expect(seenInputs).toEqual([]);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('rejects empty audio', async () => {
    const result = await service().transcribe(new Uint8Array([]), 'audio/webm');
    expect(result.ok).toBe(false);
    expect(seenInputs).toEqual([]);
  });
});

describe('VoiceService.speak', () => {
  it('returns the OGG bytes and deletes the synthesized file', async () => {
    const result = await service().speak('All done.');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('audio/ogg');
    expect(Buffer.from(result.audio).toString()).toBe('OggS-fake');
    expect(ttsCalls).toEqual(['All done.']);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('rejects empty text without synthesizing', async () => {
    const result = await service().speak('   ');
    expect(result).toEqual({ ok: false, error: expect.stringContaining('empty') });
    expect(ttsCalls).toEqual([]);
  });

  it('refuses when Piper or ffmpeg is missing', async () => {
    tools = { openwhisper: true, piper: false, ffmpeg: true };
    expect((await service().speak('hi')).ok).toBe(false);
    tools = { openwhisper: true, piper: true, ffmpeg: false };
    expect((await service().speak('hi')).ok).toBe(false);
    expect(ttsCalls).toEqual([]);
  });
});
