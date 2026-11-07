import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { loadSessions } from '../src/session/session-persistence.js';

const tempDirs: string[] = [];

function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-legacy-telegram-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('legacy Telegram config migration', () => {
  it('keeps remote chat and voice settings while discarding Telegram settings and session state', () => {
    const dir = tempConfigDir();
    fs.writeFileSync(path.join(dir, 'settings.yaml'), YAML.stringify({
      hapticFeedback: true,
      notifications: true,
      onboardingCompleted: true,
      telegram: {
        enabled: true,
        piperPath: 'C:/legacy/piper.exe',
      },
      voice: { ffmpegPath: 'D:/preferred/ffmpeg.exe' },
      hookInjections: {
        telegramRules: 'Edited remote reply rules',
        telegramMode: 'Obsolete Telegram mode',
      },
      reminderDelivery: {
        telegramInstruction: 'off',
        telegramModeInstructions: 'pty',
      },
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'cli-types.yaml'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'bindings.yaml'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'input-config.yaml'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'sessions.yaml'), [
      'sessions:',
      '  - id: legacy-session',
      '    name: Legacy session',
      '    cliType: claude',
      '    processId: 1234',
      '    topicId: 77',
      '    chatBindings:',
      '      telegram: 77',
      '      lan: room-7',
      '',
    ].join('\n'), 'utf8');
    const topicsPath = path.join(dir, 'telegram-topics.yaml');
    fs.writeFileSync(topicsPath, 'topics: []\n', 'utf8');

    const loader = new ConfigLoader(dir);
    expect(() => loader.load()).not.toThrow();

    expect(loader.getVoiceConfig()).toMatchObject({
      piperPath: 'C:/legacy/piper.exe',
      ffmpegPath: 'D:/preferred/ffmpeg.exe',
    });
    expect(loader.getHookInjectionOverrides()).toEqual({ remoteChatRules: 'Edited remote reply rules' });
    expect(loader.getReminderDelivery()).toEqual({ remoteChatInstruction: 'off' });

    const savedSettings = YAML.parse(fs.readFileSync(path.join(dir, 'settings.yaml'), 'utf8'));
    expect(savedSettings).not.toHaveProperty('telegram');
    expect(savedSettings.hookInjections).toEqual({ remoteChatRules: 'Edited remote reply rules' });
    expect(savedSettings.reminderDelivery).toEqual({ remoteChatInstruction: 'off' });

    const [session] = loadSessions(path.join(dir, 'sessions.yaml'));
    expect(session).not.toHaveProperty('topicId');
    expect(session.chatBindings).toEqual({ lan: 'room-7' });
    expect(fs.existsSync(topicsPath)).toBe(true);
  });

  it('prefers renamed user settings when both legacy and current IDs exist', () => {
    const dir = tempConfigDir();
    fs.writeFileSync(path.join(dir, 'settings.yaml'), YAML.stringify({
      onboardingCompleted: true,
      hookInjections: {
        telegramRules: 'Old template',
        remoteChatRules: 'Current template',
      },
      reminderDelivery: {
        telegramInstruction: 'pty',
        remoteChatInstruction: 'off',
      },
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'cli-types.yaml'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'bindings.yaml'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'input-config.yaml'), '{}\n', 'utf8');

    const loader = new ConfigLoader(dir);
    loader.load();

    expect(loader.getHookInjectionOverrides()).toEqual({ remoteChatRules: 'Current template' });
    expect(loader.getReminderDelivery()).toEqual({ remoteChatInstruction: 'off' });
  });

  it('persists cleanup when Telegram settings contain no voice paths', () => {
    const dir = tempConfigDir();
    fs.writeFileSync(path.join(dir, 'settings.yaml'), YAML.stringify({
      onboardingCompleted: true,
      telegram: { enabled: true },
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'cli-types.yaml'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'bindings.yaml'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'input-config.yaml'), '{}\n', 'utf8');

    const loader = new ConfigLoader(dir);
    expect(() => loader.load()).not.toThrow();

    const savedSettings = YAML.parse(fs.readFileSync(path.join(dir, 'settings.yaml'), 'utf8'));
    expect(savedSettings).not.toHaveProperty('telegram');
  });
});
