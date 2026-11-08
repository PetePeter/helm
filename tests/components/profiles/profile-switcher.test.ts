/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import ProfileSwitcher from '../../../renderer/components/profiles/ProfileSwitcher.vue';
import { useInputRouter } from '../../../renderer/composables/useInputRouter.js';
import { useModalStack } from '../../../renderer/composables/useModalStack.js';

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  list: vi.fn(),
  switch: vi.fn(),
  onChanged: vi.fn(),
  onRegistryChanged: vi.fn(),
}));

vi.mock('../../../renderer/ipc/clients.js', () => ({
  profileClient: {
    profileActive: mocks.active,
    profileList: mocks.list,
    profileSwitch: mocks.switch,
    profileOnChanged: mocks.onChanged,
    profileOnRegistryChanged: mocks.onRegistryChanged,
  },
}));

vi.mock('../../../renderer/state.js', () => ({ state: { sessions: [] } }));
vi.mock('../../../renderer/runtime/terminal-provider.js', () => ({ getTerminalManager: () => null }));
vi.mock('../../../renderer/utils.js', () => ({
  toDirection: (button: string) => ({ DPadUp: 'up', DPadDown: 'down', DPadLeft: 'left', DPadRight: 'right' } as Record<string, string>)[button] ?? null,
  navigateFocus: vi.fn(),
}));
vi.mock('../../../renderer/bindings.js', () => ({
  processConfigBinding: vi.fn(),
  processConfigRelease: vi.fn(),
  releaseVoiceTalk: () => false,
}));
vi.mock('../../../renderer/plans/plan-screen.js', () => ({
  handlePlanScreenDpad: vi.fn(),
  handlePlanScreenAction: () => false,
}));
vi.mock('../../../renderer/screens/sessions.js', () => ({ handleSessionsScreenButton: () => false }));
vi.mock('../../../renderer/composables/useModalKeyboardBridge.js', () => ({ useModalKeyboardBridge: () => ({ handler: () => false }) }));
vi.mock('../../../renderer/stores/modal-bridge.js', () => ({ isAnyBridgeModalVisible: () => false }));

let wrapper: VueWrapper | null = null;

describe('ProfileSwitcher', () => {
  beforeEach(() => {
    mocks.active.mockReset().mockResolvedValue({ id: '2', name: 'Kids', hasPin: false, isAdmin: false });
    mocks.list.mockReset().mockResolvedValue([
      { id: '1', name: 'Me', hasPin: false, isActive: false },
      { id: '2', name: 'Kids', hasPin: false, isActive: true },
      { id: '3', name: 'Sibling', hasPin: true, isActive: false },
    ]);
    mocks.switch.mockReset().mockResolvedValue({ ok: true });
    mocks.onChanged.mockReset().mockReturnValue(vi.fn());
    mocks.onRegistryChanged.mockReset().mockReturnValue(vi.fn());
    useModalStack().clear();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    useModalStack().clear();
  });

  it('shows the active profile and selects a PIN protected profile with the gamepad', async () => {
    wrapper = mount(ProfileSwitcher, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[aria-label="Switch user profile"]').text()).toContain('Kids');

    const router = useInputRouter({
      settingsVisible: ref(false),
      activeView: ref('terminal'),
      bindingEditorVisible: ref(false),
      itemEditorVisible: ref(false),
      itemEditorRef: ref(null),
      settingsPanelRef: ref(null),
      navStore: { closeSettings() {}, closePlan() {}, navigateToSession() {} },
      openProfileSwitcher: () => (wrapper!.vm as unknown as { open: () => void }).open(),
    });
    router.handleButton('Back');
    await flushPromises();
    expect(document.body.querySelector('[role="dialog"][aria-label="Switch user profile"]')).not.toBeNull();
    router.handleButton('DPadDown');
    router.handleButton('DPadDown');
    router.handleButton('A');
    await wrapper.vm.$nextTick();
    expect(document.body.querySelector('input[type="password"]')).not.toBeNull();

    const pinInput = document.body.querySelector('input[type="password"]') as HTMLInputElement;
    pinInput.value = '2468';
    pinInput.dispatchEvent(new Event('input'));
    await wrapper.vm.$nextTick();
    router.handleButton('A');
    await flushPromises();
    expect(mocks.switch).toHaveBeenCalledWith('3', '2468');
  });

  it('shows an Admin badge for the active admin profile', async () => {
    mocks.active.mockResolvedValue({ id: '1', name: 'Me', hasPin: false, isAdmin: true });
    wrapper = mount(ProfileSwitcher);
    await flushPromises();
    expect(wrapper.get('.profile-admin-badge').text()).toBe('Admin');
  });
});
