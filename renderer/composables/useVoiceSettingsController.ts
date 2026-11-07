import { ref } from 'vue';
import type { VoiceConfig } from '../../src/config/loader.js';
import { DEFAULT_VOICE_CONFIG } from '../../src/config/voice-config-manager.js';
import { voiceClient } from '../ipc/clients.js';
import { useToast } from './useToast.js';
import { trackSave } from './useAutosave.js';

type VoiceField = keyof VoiceConfig;

export function useVoiceSettingsController() {
  const settingsVoiceConfig = ref<VoiceConfig>({ ...DEFAULT_VOICE_CONFIG });

  async function loadVoiceConfig(): Promise<void> {
    try {
      settingsVoiceConfig.value = {
        ...DEFAULT_VOICE_CONFIG,
        ...(await voiceClient.voiceGetConfig()),
      };
    } catch {
      settingsVoiceConfig.value = { ...DEFAULT_VOICE_CONFIG };
    }
  }

  async function onVoiceUpdateField(field: VoiceField, value: string): Promise<void> {
    await trackSave(async () => {
      const result = await voiceClient.voiceSetConfig({ [field]: value });
      if (!result?.ok) throw new Error(result?.error || 'Failed to save voice settings');
      settingsVoiceConfig.value[field] = result.config?.[field] ?? value;
      useToast().addToast({
        message: 'Voice capability changed — reconnect MCP clients (or restart Helm) to apply.',
        type: 'info',
        key: 'voice-capability-changed',
      });
    });
  }

  return { settingsVoiceConfig, loadVoiceConfig, onVoiceUpdateField };
}
