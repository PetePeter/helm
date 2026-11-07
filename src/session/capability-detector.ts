import { existsSync, accessSync, constants } from 'fs';
import type { ConfigLoader } from '../config/loader.js';

/** The local voice binaries used by desktop speech and calls. */
export interface VoiceToolCapabilities {
  openwhisper: boolean;
  piper: boolean;
  ffmpeg: boolean;
}

export class CapabilityDetector {
  constructor(private configLoader: ConfigLoader) {}

  getVoiceTools(): VoiceToolCapabilities {
    const config = this.configLoader.getVoiceConfig();
    return {
      openwhisper: this.verifyToolPath(config.openWhisprPath),
      piper: this.verifyToolPath(config.piperPath),
      ffmpeg: this.verifyToolPath(config.ffmpegPath),
    };
  }

  private verifyToolPath(toolPath: string | undefined): boolean {
    if (!toolPath || toolPath.trim() === '') return false;
    try {
      if (!existsSync(toolPath)) return false;
      accessSync(toolPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}
