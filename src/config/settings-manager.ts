import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import logger from '../utils/logger.js';
import { normalizeMcpPort } from './loader-helpers.js';
import type { FleetConfig, McpConfig, MobileLanConfig, SettingsConfig, TelegramConfig } from './loader.js';

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
  autoStart: false,
  botToken: '',
  instanceName: 'Home',
  chatId: null,
  allowedUserIds: [],
  safeModeDefault: true,
  notifyOnComplete: true,
  notifyOnIdle: true,
  notifyOnError: true,
  notifyOnCrash: true,
  openWhisprPath: '',
  openWhisprModelPath: '',
  piperPath: '',
  piperVoicePath: '',
  ffmpegPath: '',
};

export const DEFAULT_MCP_CONFIG: McpConfig = {
  enabled: false,
  port: 47373,
  authToken: '',
};

/** Fleet transport defaults — OFF; binds nothing unless explicitly enabled. */
export const DEFAULT_FLEET_CONFIG: FleetConfig = {
  enabled: false,
  host: '0.0.0.0',
  port: 47474,
};

/**
 * Phone LAN transport defaults — OFF; binds nothing unless explicitly enabled.
 * 47475 is distinct from the fleet's 47474 on purpose: different protocols to
 * different kinds of peer, so a firewall rule never means two things at once.
 */
export const DEFAULT_MOBILE_LAN_CONFIG: MobileLanConfig = {
  enabled: false,
  port: 47475,
};

export class SettingsManager {
  private pendingSave: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly configDir: string, private readonly debounceMs = 100) {}

  get settingsPath(): string {
    return path.join(this.configDir, 'settings.yaml');
  }

  load(): SettingsConfig {
    const settings = this.readYaml<SettingsConfig>(this.settingsPath);
    if (!settings) {
      throw new Error('Invalid settings.yaml: could not parse');
    }
    return this.normalize(settings);
  }

  save(settings: SettingsConfig): void {
    this.flush();
    this.pendingSave = setTimeout(() => this.write(settings), this.debounceMs);
    this.pendingSave.unref?.();
  }

  saveNow(settings: SettingsConfig): void {
    this.flush();
    this.write(settings);
  }

  flush(): void {
    if (!this.pendingSave) return;
    clearTimeout(this.pendingSave);
    this.pendingSave = null;
  }

  private normalize(settings: SettingsConfig): SettingsConfig {
    if (settings.hapticFeedback === undefined) settings.hapticFeedback = true;
    if (settings.notifications === undefined) settings.notifications = true;

    const savedTelegram = settings.telegram;
    settings.telegram = {
      ...DEFAULT_TELEGRAM_CONFIG,
      ...(savedTelegram ?? {}),
      autoStart: typeof savedTelegram?.autoStart === 'boolean'
        ? savedTelegram.autoStart
        : savedTelegram?.enabled === true,
    };

    settings.mcp = {
      ...DEFAULT_MCP_CONFIG,
      ...(settings.mcp ?? {}),
      enabled: settings.mcp?.enabled === true,
      port: normalizeMcpPort(settings.mcp?.port),
      authToken: typeof settings.mcp?.authToken === 'string' ? settings.mcp.authToken : '',
    };
    return settings;
  }

  private readYaml<T>(filePath: string): T {
    if (!fs.existsSync(filePath)) {
      logger.error(`[Config] Configuration file not found: ${filePath}`);
      throw new Error(`Configuration file not found: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    try {
      const parsed = YAML.parse(content) as T;
      if (!parsed) {
        logger.error(`[Config] Empty or invalid YAML in: ${filePath}`);
        throw new Error(`Failed to parse configuration file: ${filePath}`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Failed to parse')) throw error;
      logger.error(`[Config] YAML parse error in ${filePath}:`, error);
      throw new Error(`Failed to parse configuration file: ${filePath} - ${error}`);
    }
  }

  private write(settings: SettingsConfig): void {
    fs.writeFileSync(this.settingsPath, YAML.stringify(settings), 'utf8');
  }
}
