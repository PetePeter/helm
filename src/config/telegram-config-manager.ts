import { DEFAULT_TELEGRAM_CONFIG } from './settings-manager.js';
import { VOICE_CONFIG_FIELDS } from './voice-config-manager.js';
import type { SettingsConfig, TelegramConfig, TelegramSettingsConfig } from './loader.js';

export class TelegramConfigManager {
  constructor(
    private readonly getSettings: () => SettingsConfig | null,
    private readonly saveSettings: () => void,
  ) {}

  get(): TelegramSettingsConfig {
    return this.getSettings()?.telegram ?? { ...DEFAULT_TELEGRAM_CONFIG };
  }

  set(updates: Partial<TelegramConfig>): void {
    const settings = this.getSettings();
    if (!settings) return;
    const telegramUpdates = Object.fromEntries(
      Object.entries(updates).filter(([key]) => !VOICE_CONFIG_FIELDS.some(field => field === key)),
    ) as Partial<TelegramSettingsConfig>;
    settings.telegram = {
      ...(settings.telegram ?? { ...DEFAULT_TELEGRAM_CONFIG }),
      ...telegramUpdates,
    };
    this.saveSettings();
  }
}
