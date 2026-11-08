/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import MobileTab from '../../../renderer/components/settings/pages/MobileTab.vue';

const mocks = vi.hoisted(() => ({ bindDevice: vi.fn(), profileList: vi.fn(), active: vi.fn() }));

vi.mock('../../../renderer/ipc/clients.js', () => ({
  profileClient: {
    profileList: mocks.profileList,
    profileActive: mocks.active,
    profileBindDevice: mocks.bindDevice,
    profileOnRegistryChanged: vi.fn().mockReturnValue(vi.fn()),
  },
}));

vi.mock('../../../renderer/composables/useMobileDevices.js', () => ({
  useMobileDevices: () => ({
    devices: ref([{ id: 'tablet', machineId: 'machine', name: 'Kids tablet', allow: [], enabled: true, online: false, createdAt: 1, userProfileId: '1' }]),
    ensureSubscribed: vi.fn(), refresh: vi.fn(), startPairing: vi.fn(), setAllowList: vi.fn(), setEnabled: vi.fn(), revoke: vi.fn(),
    apkRelease: ref(null), apkError: ref('offline'), loadApkRelease: vi.fn().mockResolvedValue(undefined),
    lan: ref({ enabled: false, port: 0, listening: false, addresses: [], pairingAddresses: [] }), setLanConfig: vi.fn(),
  }),
  type: {},
}));

vi.mock('../../../renderer/composables/useCopiedFlash.js', () => ({
  useCopiedFlash: () => ({ copied: ref(''), copy: vi.fn() }),
}));

let wrapper: VueWrapper | null = null;

describe('MobileTab profile binding', () => {
  beforeEach(() => {
    mocks.bindDevice.mockReset().mockResolvedValue({ ok: true });
    mocks.profileList.mockReset().mockResolvedValue([
      { id: '1', name: 'Me', hasPin: false, isAdmin: true, isActive: true, sessionCount: 0, recoverableSessionCount: 0, deviceCount: 0, canDelete: false },
      { id: '2', name: 'Kids', hasPin: true, isAdmin: false, isActive: false, sessionCount: 0, recoverableSessionCount: 0, deviceCount: 1, canDelete: false },
    ]);
    mocks.active.mockReset().mockResolvedValue({ id: '1', name: 'Me', hasPin: false, isAdmin: true });
  });

  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('assigns a paired tablet to a profile through the typed client', async () => {
    wrapper = mount(MobileTab);
    await flushPromises();
    const select = wrapper.get('[aria-label="Profile for Kids tablet"]');
    await select.setValue('2');
    await flushPromises();
    expect(mocks.bindDevice).toHaveBeenCalledWith('tablet', '2');
  });

  it('shows the bound admin profile and disables device and pairing controls for non-admins', async () => {
    mocks.active.mockResolvedValue({ id: '2', name: 'Kids', hasPin: true, isAdmin: false });
    wrapper = mount(MobileTab);
    await flushPromises();

    expect(wrapper.text()).toContain('Admin only');
    expect(wrapper.get('[aria-label="Profile for Kids tablet"]').element).toHaveProperty('disabled', true);
    expect(wrapper.get('.mobile-pair-btn').element).toHaveProperty('disabled', true);
    expect(wrapper.get('.mobile-enable-input').element).toHaveProperty('disabled', true);
    expect(wrapper.get('.mobile-admin-badge').text()).toBe('Admin');
  });
});
