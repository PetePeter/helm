import * as fs from 'fs';
import * as YAML from 'yaml';
import logger from '../utils/logger.js';
import { normalizeMcpPort } from './loader-helpers.js';
import type { FleetConfig, McpConfig, MobileLanConfig, OperatorConfig, SettingsConfig, VoiceConfig } from './loader.js';
import { DEFAULT_VOICE_CONFIG, VOICE_CONFIG_FIELDS } from './voice-config-manager.js';
import { getGlobalPersistencePaths } from '../session/persistence-paths.js';

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

/** Voice operator singleton — OFF, and no CLI type: ids are per-machine UUIDs. */
export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  enabled: false,
  cliType: '',
  compactEveryMinutes: 60,
  rules: '',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOwn(value: Record<string, unknown> | undefined, key: string): boolean {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * One-shot cleanup for settings written while Telegram existed: user data
 * (voice paths, remote-chat overrides) moves to its current key unless that
 * key is already set, then every stale key is dropped. Returns true when the
 * file needs rewriting.
 */
function dropLegacyTelegramKeys(raw: Record<string, unknown>): boolean {
  let changed = false;
  const moveAndDrop = (target: Record<string, unknown>, renames: Record<string, string | null>) => {
    for (const [legacy, current] of Object.entries(renames)) {
      if (!hasOwn(target, legacy)) continue;
      if (current && !hasOwn(target, current)) target[current] = target[legacy];
      delete target[legacy];
      changed = true;
    }
  };

  const legacySection = asRecord(raw.telegram);
  if (hasOwn(raw, 'telegram')) {
    const voice = { ...(asRecord(raw.voice) ?? {}) };
    for (const field of VOICE_CONFIG_FIELDS) {
      if (typeof voice[field] !== 'string' && typeof legacySection?.[field] === 'string') voice[field] = legacySection[field];
    }
    raw.voice = voice;
    delete raw.telegram;
    changed = true;
  }
  const hookInjections = asRecord(raw.hookInjections);
  if (hookInjections) moveAndDrop(hookInjections, { telegramRules: 'remoteChatRules', telegramMode: null });
  const reminderDelivery = asRecord(raw.reminderDelivery);
  if (reminderDelivery) moveAndDrop(reminderDelivery, { telegramInstruction: 'remoteChatInstruction', telegramModeInstructions: null });
  return changed;
}

export class SettingsManager {
  private pendingSave: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly configDir: string, private readonly debounceMs = 100) {}

  get settingsPath(): string {
    return getGlobalPersistencePaths(this.configDir).settingsFile;
  }

  load(): SettingsConfig {
    const settings = this.readYaml<SettingsConfig>(this.settingsPath);
    if (!settings) {
      throw new Error('Invalid settings.yaml: could not parse');
    }
    const needsOnboardingMigration = settings.onboardingCompleted === undefined;
    const droppedLegacyKeys = dropLegacyTelegramKeys(settings as unknown as Record<string, unknown>);
    const normalized = this.normalize(settings);
    // Bundled fresh-install settings explicitly contain false. An older user
    // settings file does not, so migrate it as completed rather than showing a
    // first-run wizard to someone upgrading an established installation.
    if (needsOnboardingMigration || droppedLegacyKeys) {
      this.write(normalized);
    }
    return normalized;
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
    if (typeof settings.onboardingCompleted !== 'boolean') settings.onboardingCompleted = true;
    if (settings.hapticFeedback === undefined) settings.hapticFeedback = true;
    if (settings.notifications === undefined) settings.notifications = true;

    const savedVoice = settings.voice as Partial<VoiceConfig> | undefined;
    const voice = { ...DEFAULT_VOICE_CONFIG };
    for (const field of VOICE_CONFIG_FIELDS) {
      const current = savedVoice?.[field];
      if (typeof current === 'string') voice[field] = current;
    }
    settings.voice = voice;

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
