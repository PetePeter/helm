import { describe, it, expect } from 'vitest';
import { buildPiperArgs, buildFfmpegArgs, PiperTts } from '../src/voice/piper-tts';

describe('buildPiperArgs', () => {
  it('produces the exact piper argument array', () => {
    expect(buildPiperArgs('C:/voices/en.onnx', 'C:/tmp/out.wav')).toEqual([
      '-m', 'C:/voices/en.onnx',
      '-f', 'C:/tmp/out.wav',
    ]);
  });
});

describe('buildFfmpegArgs', () => {
  it('produces the exact ffmpeg argument array (libopus, 96k)', () => {
    expect(buildFfmpegArgs('C:/tmp/in.wav', 'C:/tmp/out.ogg')).toEqual([
      '-y', '-i', 'C:/tmp/in.wav', '-c:a', 'libopus', '-b:a', '96k', 'C:/tmp/out.ogg',
    ]);
  });
});

describe('PiperTts.synthesize', () => {
  it('throws when piperVoicePath is missing', async () => {
    const tts = new PiperTts({
      piperPath: 'piper',
      piperVoicePath: '',
      ffmpegPath: 'ffmpeg',
      tmpDir: 'C:/tmp',
    });
    await expect(tts.synthesize('hello')).rejects.toThrow(/voice/i);
  });
});
