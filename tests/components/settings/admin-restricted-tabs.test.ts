/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import OperatorTab from '../../../renderer/components/settings/pages/OperatorTab.vue';
import MobileTab from '../../../renderer/components/settings/pages/MobileTab.vue';
import UpdatesTab from '../../../renderer/components/settings/pages/UpdatesTab.vue';
import { resetMobileDevicesStateForTesting } from '../../../renderer/composables/useMobileDevices.js';

const ipc = vi.hoisted(() => ({
  role: { isAdmin: false },
  configGetOperatorConfig: vi.fn(),
  configGetCliTypes: vi.fn(),
  mobileList: vi.fn(),
  mobilePairingState: vi.fn(),
  mobileLanConfig: vi.fn(),
  mobileApkRelease: vi.fn(),
}));

vi.mock('../../../renderer/ipc/clients.js', () => ({
  profileClient: {
    profileActive: async () => ({ id: '2', name: 'Kids', hasPin: false, isAdmin: ipc.role.isAdmin }),
    profileList: async () => [],
    profileOnRegistryChanged: () => () => undefined,
  },
  configClient: {
    configGetOperatorConfig: (...args: any[]) => ipc.configGetOperatorConfig(...args),
    configGetCliTypes: (...args: any[]) => ipc.configGetCliTypes(...args),
    configSetOperatorConfig: vi.fn(async () => ({ success: true })),
  },
  mobileClient: {
    mobileList: (...args: any[]) => ipc.mobileList(...args),
    mobilePairingState: (...args: any[]) => ipc.mobilePairingState(...args),
    mobileLanConfig: (...args: any[]) => ipc.mobileLanConfig(...args),
    mobileApkRelease: (...args: any[]) => ipc.mobileApkRelease(...args),
    mobileSetLanConfig: vi.fn(), mobileSetAllowList: vi.fn(), mobileSetEnabled: vi.fn(),
    mobileRevoke: vi.fn(), mobileStartPairing: vi.fn(), mobileConfirmPairing: vi.fn(), mobileCancelPairing: vi.fn(),
  },
  eventsClient: {
    onMobileDevicesChanged: vi.fn(), onMobilePairingState: vi.fn(),
  },
  updateClient: {
    updateGetMode: async () => 'auto',
    updateSetMode: vi.fn(async () => ({ success: true })),
  },
  appClient: { appGetVersion: async () => '1.0.0' },
}));

vi.mock('../../../renderer/composables/useUpdateCheck.js', () => ({
  checkForAppUpdateNow: vi.fn(async () => 'No updates'),
  installStatus: '',
  installUpdate: vi.fn(),
  updateOffer: { version: '2.0.0' },
}));

const wrappers: VueWrapper[] = [];
beforeEach(() => {
  ipc.role.isAdmin = false;
  ipc.configGetOperatorConfig.mockReset().mockRejectedValue(new Error('Admin only'));
  ipc.configGetCliTypes.mockReset().mockRejectedValue(new Error('Admin only'));
  ipc.mobileList.mockReset().mockRejectedValue(new Error('Admin only'));
  ipc.mobilePairingState.mockReset().mockRejectedValue(new Error('Admin only'));
  ipc.mobileLanConfig.mockReset().mockRejectedValue(new Error('Admin only'));
  ipc.mobileApkRelease.mockReset().mockResolvedValue({ ok: false, reason: 'Unavailable' });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  resetMobileDevicesStateForTesting();
});

describe('admin-only settings controls', () => {
  it('disables operator configuration with an Admin only hint for non-admins', async () => {
    const wrapper = mount(OperatorTab);
    wrappers.push(wrapper);
    await flushPromises();

    expect(ipc.configGetOperatorConfig).not.toHaveBeenCalled();
    expect(ipc.configGetCliTypes).not.toHaveBeenCalled();
    expect(wrapper.find('input[type="checkbox"]').element).toHaveProperty('disabled', true);
    expect(wrapper.findAll('select').every(select => (select.element as HTMLSelectElement).disabled)).toBe(true);
    expect(wrapper.find('textarea').element).toHaveProperty('disabled', true);
    expect(wrapper.text()).toContain('Admin only');
  });

  it('skips admin-only mobile reads for non-admins without leaking rejected IPC promises', async () => {
    const wrapper = mount(MobileTab);
    wrappers.push(wrapper);
    await flushPromises();

    expect(ipc.mobileList).not.toHaveBeenCalled();
    expect(ipc.mobilePairingState).not.toHaveBeenCalled();
    expect(ipc.mobileLanConfig).not.toHaveBeenCalled();
  });

  it('disables update mode and install while leaving update checks available', async () => {
    const wrapper = mount(UpdatesTab);
    wrappers.push(wrapper);
    await flushPromises();

    expect(wrapper.find('select').element).toHaveProperty('disabled', true);
    expect(wrapper.get('.updates-install').element).toHaveProperty('disabled', true);
    expect(wrapper.findAll('button').find(button => button.text().includes('Check now'))?.element)
      .toHaveProperty('disabled', false);
    expect(wrapper.text()).toContain('Admin only');
  });
});
