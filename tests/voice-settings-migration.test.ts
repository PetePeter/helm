import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
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
  it('moves all legacy Telegram paths to voice and persists the cleanup on an established install', () => {
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
    expect(saved.telegram).not.toHaveProperty('openWhisprPath');
    expect(saved.telegram).not.toHaveProperty('openWhisprModelPath');
    expect(saved.telegram).not.toHaveProperty('piperPath');
    expect(saved.telegram).not.toHaveProperty('piperVoicePath');
    expect(saved.telegram).not.toHaveProperty('ffmpegPath');
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

  it('projects canonical voice paths through Telegram reads without routing Telegram writes', () => {
    const dir = tempConfigDir();
    writeSettings(dir, {
      hapticFeedback: true,
      notifications: true,
      onboardingCompleted: true,
      telegram: { enabled: false, piperPath: 'C:/legacy-piper.exe' },
    });
    fs.writeFileSync(path.join(dir, 'cli-types.yaml'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'bindings.yaml'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'input-config.yaml'), '{}\n', 'utf8');

    const loader = new ConfigLoader(dir);
    loader.load();

    expect(loader.getVoiceConfig().piperPath).toBe('C:/legacy-piper.exe');
    expect(loader.getTelegramConfig().piperPath).toBe('C:/legacy-piper.exe');

    loader.setVoiceConfig({ ffmpegPath: 'D:/ffmpeg.exe' });
    expect(loader.getVoiceConfig()).toMatchObject({
      piperPath: 'C:/legacy-piper.exe',
      ffmpegPath: 'D:/ffmpeg.exe',
    });

    loader.setTelegramConfig({ piperPath: 'C:/ignored-telegram-write.exe' });

    expect(loader.getVoiceConfig().piperPath).toBe('C:/legacy-piper.exe');
    expect(loader.getVoiceConfig().ffmpegPath).toBe('D:/ffmpeg.exe');
    expect(loader.getTelegramConfig().piperPath).toBe('C:/legacy-piper.exe');
    const saved = YAML.parse(fs.readFileSync(path.join(dir, 'settings.yaml'), 'utf8'));
    expect(saved.telegram).not.toHaveProperty('piperPath');
  });
});
