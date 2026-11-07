import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsManager } from '../src/config/settings-manager.js';

const tempDirs: string[] = [];

function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-voice-settings-'));
  tempDirs.push(dir);
  return dir;
}

function writeSettings(dir: string, settings: unknown): void {
  fs.writeFileSync(path.join(dir, 'settings.yaml'), YAML.stringify(settings), 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('voice settings migration', () => {
  it('moves legacy speech paths to voice and removes the retired section', () => {
    const dir = tempConfigDir();
    writeSettings(dir, {
      hapticFeedback: true,
      notifications: true,
      onboardingCompleted: true,
      telegram: {
        enabled: false,
        openWhisprPath: 'C:/OpenWhispr',
        openWhisprModelPath: 'C:/models/ggml.bin',
        piperPath: 'C:/piper.exe',
        piperVoicePath: 'C:/voice.onnx',
        ffmpegPath: 'C:/ffmpeg.exe',
      },
    });

    const settings = new SettingsManager(dir).load();
    const saved = YAML.parse(fs.readFileSync(path.join(dir, 'settings.yaml'), 'utf8'));

    expect(settings.voice).toEqual({
      openWhisprPath: 'C:/OpenWhispr',
      openWhisprModelPath: 'C:/models/ggml.bin',
      piperPath: 'C:/piper.exe',
      piperVoicePath: 'C:/voice.onnx',
      ffmpegPath: 'C:/ffmpeg.exe',
    });
    expect(saved).not.toHaveProperty('telegram');
    expect(saved.voice).toEqual(settings.voice);
  });

  it('keeps explicit voice values, fills missing fields once, and is idempotent', () => {
    const dir = tempConfigDir();
    writeSettings(dir, {
      hapticFeedback: true,
      notifications: true,
      onboardingCompleted: true,
      voice: { openWhisprPath: 'D:/preferred-whisper' },
      telegram: { openWhisprPath: 'C:/old-whisper', piperPath: 'C:/piper.exe' },
    });

    const firstLoad = new SettingsManager(dir).load();
    const firstSaved = fs.readFileSync(path.join(dir, 'settings.yaml'), 'utf8');
    const secondLoad = new SettingsManager(dir).load();
    const secondSaved = fs.readFileSync(path.join(dir, 'settings.yaml'), 'utf8');

    expect(firstLoad.voice).toMatchObject({
      openWhisprPath: 'D:/preferred-whisper',
      piperPath: 'C:/piper.exe',
    });
    expect(secondLoad.voice).toEqual(firstLoad.voice);
    expect(secondSaved).toBe(firstSaved);
  });

});
