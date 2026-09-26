import { existsSync, accessSync, constants } from 'fs';
import type { ConfigLoader } from '../config/loader.js';

export interface TelegramCapabilities {
  available: boolean;
  openwhisper: boolean;
  openwhisperPath?: string;
  piper: boolean;
  piperPath?: string;
  ffmpeg: boolean;
  ffmpegPath?: string;
}

/** The three local voice binaries, independent of whether Telegram is on. */
export interface VoiceToolCapabilities {
  openwhisper: boolean;
  piper: boolean;
  ffmpeg: boolean;
}

export class CapabilityDetector {
  private cache: TelegramCapabilities | null = null;

  constructor(private configLoader: ConfigLoader) {}

  getCapabilities(): TelegramCapabilities {
    // Return cached result if available
    if (this.cache) {
      return this.cache;
    }

    const config = this.configLoader.getTelegramConfig();

    // If Telegram is disabled, all capabilities are false
    if (!config?.enabled) {
      this.cache = {
        available: false,
        openwhisper: false,
        piper: false,
        ffmpeg: false,
      };
      return this.cache;
    }

    // Check each tool path
    const openwhisper = this.verifyToolPath(config?.openWhisprPath);
    const piper = this.verifyToolPath(config?.piperPath);
    const ffmpeg = this.verifyToolPath(config?.ffmpegPath);
    const capabilities: TelegramCapabilities = {
      available: true,
      openwhisper,
      ...(openwhisper && config?.openWhisprPath ? { openwhisperPath: config.openWhisprPath } : {}),
      piper,
      ...(piper && config?.piperPath ? { piperPath: config.piperPath } : {}),
      ffmpeg,
      ...(ffmpeg && config?.ffmpegPath ? { ffmpegPath: config.ffmpegPath } : {}),
    };

    this.cache = capabilities;
    return capabilities;
  }

  /**
   * The voice tools alone, ungated and uncached. Desktop voice uses the same
   * binaries as Telegram but must not require the Telegram bot to be enabled.
   */
  getVoiceTools(): VoiceToolCapabilities {
    const config = this.configLoader.getTelegramConfig();
    return {
      openwhisper: this.verifyToolPath(config?.openWhisprPath),
      piper: this.verifyToolPath(config?.piperPath),
      ffmpeg: this.verifyToolPath(config?.ffmpegPath),
    };
  }

  invalidateCache(): void {
    this.cache = null;
  }

  private verifyToolPath(toolPath: string | undefined): boolean {
    // Empty or undefined path
    if (!toolPath || toolPath.trim() === '') {
      return false;
    }

    try {
      // Check if file exists
      if (!existsSync(toolPath)) {
        return false;
      }

      // Check if file is executable
      accessSync(toolPath, constants.X_OK);
      return true;
    } catch {
      // File not accessible/executable
      return false;
    }
  }
}
