import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { CapabilityDetector } from '../src/session/capability-detector';

// Fake ConfigLoader for testing
class FakeConfigLoader {
  private telegramConfig: any;

  constructor(config: any = {}) {
    this.telegramConfig = {
      enabled: true,
      openWhisprPath: '',
      piperPath: '',
      ffmpegPath: '',
      ...config,
    };
  }

  getTelegramConfig() {
    return this.telegramConfig;
  }

  setTelegramConfig(updates: any) {
    this.telegramConfig = { ...this.telegramConfig, ...updates };
  }
}

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

describe('CapabilityDetector', () => {
  let detector: CapabilityDetector;
  let fakeConfigLoader: FakeConfigLoader;

  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('when Telegram is enabled', () => {
    describe('ffmpeg detection', () => {
      it('should return true for ffmpeg if configured path exists and is executable', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.accessSync).mockReturnValue(undefined);

        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities.ffmpeg).toBe(true);
      });

      it('should return false if ffmpeg path does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities.ffmpeg).toBe(false);
      });

      it('should return false if ffmpeg path is not accessible', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.accessSync).mockImplementation(() => {
          throw new Error('EACCES');
        });

        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities.ffmpeg).toBe(false);
      });

      it('should return false if ffmpeg path is empty', () => {
        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          ffmpegPath: '',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities.ffmpeg).toBe(false);
      });
    });

    describe('piper detection', () => {
      it('should return true for piper if configured path exists and is executable', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.accessSync).mockReturnValue(undefined);

        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          piperPath: '/usr/local/bin/piper',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities.piper).toBe(true);
      });

      it('should return false if piper path does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          piperPath: '/usr/local/bin/piper',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities.piper).toBe(false);
      });
    });

    describe('openwhisper detection', () => {
      it('should return true for openwhisper if configured path exists and is executable', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.accessSync).mockReturnValue(undefined);

        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          openWhisprPath: '/usr/local/bin/whisper',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities.openwhisper).toBe(true);
      });

      it('should return false if openwhisper path does not exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          openWhisprPath: '/usr/local/bin/whisper',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities.openwhisper).toBe(false);
      });
    });

    describe('available flag', () => {
      it('should return available=true when Telegram is enabled', () => {
        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          ffmpegPath: '/usr/bin/ffmpeg',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities.available).toBe(true);
      });
    });

    describe('combined capabilities', () => {
      it('should return all four flags in capabilities object', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.accessSync).mockReturnValue(undefined);

        fakeConfigLoader = new FakeConfigLoader({
          enabled: true,
          ffmpegPath: '/usr/bin/ffmpeg',
          piperPath: '/usr/bin/piper',
          openWhisprPath: '/usr/bin/whisper',
        });
        detector = new CapabilityDetector(fakeConfigLoader as any);

        const capabilities = detector.getCapabilities();
        expect(capabilities).toMatchObject({
          available: true,
          ffmpeg: true,
          piper: true,
          openwhisper: true,
        });
      });
    });
  });

  describe('when Telegram is disabled', () => {
    it('should return available=false when Telegram is disabled', () => {
      fakeConfigLoader = new FakeConfigLoader({
        enabled: false,
      });
      detector = new CapabilityDetector(fakeConfigLoader as any);

      const capabilities = detector.getCapabilities();
      expect(capabilities.available).toBe(false);
    });

    it('should return all tool flags as false when Telegram is disabled', () => {
      fakeConfigLoader = new FakeConfigLoader({
        enabled: false,
        ffmpegPath: '/usr/bin/ffmpeg',
        piperPath: '/usr/bin/piper',
        openWhisprPath: '/usr/bin/whisper',
      });
      detector = new CapabilityDetector(fakeConfigLoader as any);

      const capabilities = detector.getCapabilities();
      expect(capabilities.ffmpeg).toBe(false);
      expect(capabilities.piper).toBe(false);
      expect(capabilities.openwhisper).toBe(false);
    });

    it('still reports the voice tools themselves, for desktop voice', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.accessSync).mockReturnValue(undefined);
      fakeConfigLoader = new FakeConfigLoader({
        enabled: false,
        ffmpegPath: '/usr/bin/ffmpeg',
        piperPath: '/usr/bin/piper',
        openWhisprPath: '',
      });
      detector = new CapabilityDetector(fakeConfigLoader as any);

      expect(detector.getVoiceTools()).toEqual({ openwhisper: false, piper: true, ffmpeg: true });
    });
  });

  describe('caching behavior', () => {
    it('should cache results to avoid repeated filesystem calls', () => {
      const existsSyncMock = vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.accessSync).mockReturnValue(undefined);

      fakeConfigLoader = new FakeConfigLoader({
        enabled: true,
        ffmpegPath: '/usr/bin/ffmpeg',
      });
      detector = new CapabilityDetector(fakeConfigLoader as any);

      // First call
      detector.getCapabilities();
      const callCountAfterFirst = existsSyncMock.mock.calls.length;

      // Second call should use cache
      detector.getCapabilities();
      const callCountAfterSecond = existsSyncMock.mock.calls.length;

      expect(callCountAfterSecond).toBe(callCountAfterFirst);
    });

    it('should invalidate cache when getTelegramConfig changes', () => {
      const existsSyncMock = vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.accessSync).mockReturnValue(undefined);

      fakeConfigLoader = new FakeConfigLoader({
        enabled: true,
        ffmpegPath: '/usr/bin/ffmpeg',
      });
      detector = new CapabilityDetector(fakeConfigLoader as any);

      // First call
      detector.getCapabilities();
      const callCountAfterFirst = existsSyncMock.mock.calls.length;

      // Simulate config change by invalidating cache
      detector.invalidateCache();

      // Next call should revalidate
      detector.getCapabilities();
      const callCountAfterSecond = existsSyncMock.mock.calls.length;

      expect(callCountAfterSecond).toBeGreaterThan(callCountAfterFirst);
    });
  });
});
