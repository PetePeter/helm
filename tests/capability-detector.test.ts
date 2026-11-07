import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { CapabilityDetector } from '../src/session/capability-detector';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

describe('voice tool capability detection', () => {
  afterEach(() => vi.clearAllMocks());

  it('reports configured speech tools when their paths exist and are executable', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.accessSync).mockReturnValue(undefined);
    const detector = new CapabilityDetector({
      getVoiceConfig: () => ({
        openWhisprPath: '/tools/whisper',
        piperPath: '/tools/piper',
        ffmpegPath: '/tools/ffmpeg',
        openWhisprModelPath: '',
        piperVoicePath: '',
      }),
    } as never);

    expect(detector.getVoiceTools()).toEqual({ openwhisper: true, piper: true, ffmpeg: true });
  });

  it('returns false for missing, inaccessible, or unset tool paths', () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath) => filePath === '/tools/whisper');
    vi.mocked(fs.accessSync).mockImplementation(() => { throw new Error('EACCES'); });
    const detector = new CapabilityDetector({
      getVoiceConfig: () => ({
        openWhisprPath: '/tools/whisper',
        piperPath: '/tools/piper',
        ffmpegPath: '',
        openWhisprModelPath: '',
        piperVoicePath: '',
      }),
    } as never);

    expect(detector.getVoiceTools()).toEqual({ openwhisper: false, piper: false, ffmpeg: false });
  });
});
