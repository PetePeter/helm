import type { SettingsConfig, VoiceConfig } from './loader.js';

export const VOICE_CONFIG_FIELDS: readonly (keyof VoiceConfig)[] = [
  'openWhisprPath',
  'openWhisprModelPath',
  'piperPath',
  'piperVoicePath',
  'ffmpegPath',
];

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  openWhisprPath: '',
  openWhisprModelPath: '',
  piperPath: '',
  piperVoicePath: '',
  ffmpegPath: '',
};

export class VoiceConfigManager {
  constructor(
    private readonly getSettings: () => SettingsConfig | null,
    private readonly saveSettings: () => void,
  ) {}

  get(): VoiceConfig {
    return { ...DEFAULT_VOICE_CONFIG, ...(this.getSettings()?.voice ?? {}) };
  }

  set(updates: Partial<VoiceConfig>): void {
    const settings = this.getSettings();
    if (!settings) return;
    settings.voice = { ...this.get(), ...updates };
    this.saveSettings();
  }
}
