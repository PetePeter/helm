/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ProfilesTab from '../../../renderer/components/settings/pages/ProfilesTab.vue';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  setPin: vi.fn(),
  remove: vi.fn(),
  onRegistryChanged: vi.fn(),
}));

vi.mock('../../../renderer/ipc/clients.js', () => ({
  profileClient: {
    profileList: mocks.list,
    profileCreate: mocks.create,
    profileRename: mocks.rename,
    profileSetPin: mocks.setPin,
    profileDelete: mocks.remove,
    profileOnRegistryChanged: mocks.onRegistryChanged,
  },
}));

let wrapper: VueWrapper | null = null;
let profileRecords: Array<Record<string, unknown>>;

describe('ProfilesTab', () => {
  beforeEach(() => {
    profileRecords = [
      { id: '1', name: 'Me', hasPin: false, isActive: true, sessionCount: 1, recoverableSessionCount: 0, deviceCount: 0, canDelete: false },
      { id: '2', name: 'Kids', hasPin: true, isActive: false, sessionCount: 0, recoverableSessionCount: 0, deviceCount: 0, canDelete: true },
    ];
    mocks.list.mockReset().mockImplementation(async () => profileRecords);
    mocks.create.mockReset().mockResolvedValue({ id: '3', name: 'Guest', hasPin: false });
    mocks.rename.mockReset().mockImplementation(async (id: string, name: string) => {
      const profile = profileRecords.find(item => item.id === id);
      if (profile) profile.name = name;
      return { ok: true };
    });
    mocks.setPin.mockReset().mockImplementation(async (id: string, pin: string | null) => {
      const profile = profileRecords.find(item => item.id === id);
      if (profile) profile.hasPin = pin !== null;
      return { ok: true };
    });
    mocks.remove.mockReset().mockResolvedValue({ ok: true });
    mocks.onRegistryChanged.mockReset().mockReturnValue(vi.fn());
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('creates and renames profiles and lets the active profile set or clear its PIN', async () => {
    wrapper = mount(ProfilesTab);
    await flushPromises();

    await wrapper.get('[aria-label="New profile name"]').setValue('Guest');
    await wrapper.get('button[aria-label="Create profile"]').trigger('click');
    await flushPromises();
    expect(mocks.create).toHaveBeenCalledWith('Guest');

    await wrapper.get('[aria-label="Rename Kids"]').setValue('Children');
    await wrapper.get('button[aria-label="Save name for Kids"]').trigger('click');
    await flushPromises();
    expect(mocks.rename).toHaveBeenCalledWith('2', 'Children');

    await wrapper.get('[aria-label="New profile PIN"]').setValue('2468');
    await wrapper.get('button[aria-label="Set profile PIN"]').trigger('click');
    await flushPromises();
    expect(mocks.setPin).toHaveBeenCalledWith('1', '2468');

    await wrapper.get('button[aria-label="Clear profile PIN"]').trigger('click');
    await flushPromises();
    expect(mocks.setPin).toHaveBeenLastCalledWith('1', null);
  });
});
