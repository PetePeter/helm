/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
  voiceGetConfig: vi.fn(),
  voiceSetConfig: vi.fn(),
}));

vi.mock('../../renderer/ipc/clients.js', () => ({
  voiceClient: {
    voiceGetConfig: mocks.voiceGetConfig,
    voiceSetConfig: mocks.voiceSetConfig,
  },
}));

import { useVoiceSettingsController } from '../../renderer/composables/useVoiceSettingsController.js';
import VoiceTab from '../../renderer/components/settings/pages/VoiceTab.vue';

const initialConfig = {
  openWhisprPath: 'C:/ow',
  openWhisprModelPath: 'C:/model.bin',
  piperPath: 'C:/piper.exe',
  piperVoicePath: 'C:/voice.onnx',
  ffmpegPath: 'C:/ffmpeg.exe',
};

describe('useVoiceSettingsController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.voiceGetConfig.mockResolvedValue(initialConfig);
    mocks.voiceSetConfig.mockImplementation(async (updates: Partial<typeof initialConfig>) => ({
      ok: true,
      config: { ...initialConfig, ...updates },
    }));
  });

  it('loads the independent voice settings section', async () => {
    const controller = useVoiceSettingsController();

    await controller.loadVoiceConfig();

    expect(controller.settingsVoiceConfig.value).toMatchObject({
      openWhisprPath: 'C:/ow',
      openWhisprModelPath: 'C:/model.bin',
      piperVoicePath: 'C:/voice.onnx',
    });
    expect(mocks.voiceGetConfig).toHaveBeenCalledOnce();
  });

  it('saves a path through voice IPC and updates its own state', async () => {
    const controller = useVoiceSettingsController();
    await controller.loadVoiceConfig();

    await controller.onVoiceUpdateField('piperPath', 'D:/piper.exe');

    expect(mocks.voiceSetConfig).toHaveBeenCalledWith({ piperPath: 'D:/piper.exe' });
    expect(controller.settingsVoiceConfig.value.piperPath).toBe('D:/piper.exe');
  });

  it('preserves and saves another field edited while a blur save is pending', async () => {
    let resolveFirstSave!: (result: { ok: true; config: typeof initialConfig }) => void;
    const firstSave = new Promise<{ ok: true; config: typeof initialConfig }>((resolve) => {
      resolveFirstSave = resolve;
    });
    mocks.voiceSetConfig
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValueOnce({ ok: true, config: { ...initialConfig, openWhisprPath: 'D:/ow' } });

    const controller = useVoiceSettingsController();
    await controller.loadVoiceConfig();
    const host = defineComponent({
      setup: () => () => h(VoiceTab, {
        config: controller.settingsVoiceConfig.value,
        onUpdateField: controller.onVoiceUpdateField,
      }),
    });
    const wrapper = mount(host);

    await wrapper.find('[data-field="openWhisprPath"] input').setValue('D:/ow');
    await wrapper.find('[data-field="openWhisprPath"] input').trigger('blur');
    expect(mocks.voiceSetConfig).toHaveBeenNthCalledWith(1, { openWhisprPath: 'D:/ow' });

    const piperInput = wrapper.find('[data-field="piperPath"] input');
    await piperInput.setValue('D:/new-piper.exe');
    resolveFirstSave({ ok: true, config: { ...initialConfig, openWhisprPath: 'D:/ow' } });
    await flushPromises();
    await nextTick();

    expect((piperInput.element as HTMLInputElement).value).toBe('D:/new-piper.exe');

    await new Promise(resolve => setTimeout(resolve, 550));
    await flushPromises();
    expect(mocks.voiceSetConfig).toHaveBeenNthCalledWith(2, { piperPath: 'D:/new-piper.exe' });
    wrapper.unmount();
  });
});
