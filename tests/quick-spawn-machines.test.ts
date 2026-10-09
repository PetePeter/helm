/**
 * Machine-first Quick Spawn state and mounted surfaces.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import QuickSpawnPane from '../renderer/components/dock/QuickSpawnPane.vue';
import QuickSpawnModal from '../renderer/components/modals/QuickSpawnModal.vue';
import { HELM_PANE_CONTEXT, type HelmPaneContext } from '../renderer/dock-pane-context.js';
import { sessionsState } from '../renderer/screens/sessions-state.js';
import { handleSpawnZone, handleSpawnZoneButton } from '../renderer/screens/sessions-spawn.js';
import { usePeers, resetPeersStateForTesting } from '../renderer/composables/usePeers.js';
import { useQuickSpawnStore } from '../renderer/stores/quick-spawn.js';

const activePeer = (id: string, alias: string) => ({
  id,
  machineId: `${id}-machine`,
  alias,
  address: `${id}:47474`,
  direction: 'bidirectional' as const,
  inbound: false,
  peerAllowsMe: true,
  enabled: true,
  online: true,
});

function setPeerTools(load: (peerId: string) => Promise<Array<{ id: string; name: string; kind: 'cli' }>>): void {
  Object.defineProperty(window, 'helm', {
    configurable: true,
    value: { peers: { peerCliTypes: load } },
  });
}

function paneContext(onSpawn = vi.fn()): HelmPaneContext {
  return {
    terminalContainerRef: { value: null },
    sidebar: { onSpawn } as unknown as HelmPaneContext['sidebar'],
    planWorkspace: {} as HelmPaneContext['planWorkspace'],
    groups: {} as HelmPaneContext['groups'],
    showArtifactsForSession: vi.fn(),
    popOutArtifacts: vi.fn(),
  };
}

let pinia: ReturnType<typeof createPinia>;
const wrappers: Array<{ unmount: () => void }> = [];

beforeEach(() => {
  resetPeersStateForTesting();
  pinia = createPinia();
  setActivePinia(pinia);
  sessionsState.cliTypes = ['local-cli'];
  sessionsState.activeFocus = 'sessions';
  usePeers().configuredPeers.value = [];
  setPeerTools(async () => [{ id: 'peer-cli-id', name: 'Peer CLI', kind: 'cli' }]);
});

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  disposePinia(pinia);
  usePeers().configuredPeers.value = [];
  resetPeersStateForTesting();
  delete (window as Window & { helm?: unknown }).helm;
  document.body.innerHTML = '';
});

describe('quick spawn machine state', () => {
  it('loads the selected peer tools and drops a late answer after leaving that tab', async () => {
    usePeers().configuredPeers.value = [activePeer('a', 'A'), activePeer('b', 'B')];
    let resolveA!: (tools: Array<{ id: string; name: string; kind: 'cli' }>) => void;
    setPeerTools(peerId => peerId === 'a'
      ? new Promise(resolve => { resolveA = resolve; })
      : Promise.resolve([{ id: 'b-tool-id', name: 'B tool', kind: 'cli' }]));
    const store = useQuickSpawnStore();

    const pendingA = store.selectMachine('a');
    expect(store.loading).toBe(true);
    await store.selectMachine('b');
    resolveA([{ id: 'a-tool-id', name: 'A tool', kind: 'cli' }]);
    await pendingA;

    expect(store.machineId).toBe('b');
    expect(store.tools).toEqual([{ cliType: 'b-tool-id', displayName: 'B tool', machineId: 'b' }]);
  });

  it('falls back to This PC when the active peer goes offline', async () => {
    usePeers().configuredPeers.value = [activePeer('b', 'B')];
    const store = useQuickSpawnStore();
    await store.selectMachine('b');

    usePeers().configuredPeers.value = [{ ...activePeer('b', 'B'), online: false }];
    await nextTick();

    expect(store.machineId).toBe('');
    expect(store.tools).toEqual([{ cliType: 'local-cli', displayName: 'local-cli', machineId: '' }]);
  });

  it('retries a peer tool request after an error', async () => {
    usePeers().configuredPeers.value = [activePeer('b', 'B')];
    let attempts = 0;
    setPeerTools(async () => {
      attempts++;
      if (attempts === 1) throw new Error('Tool access denied');
      return [{ id: 'peer-cli-id', name: 'Peer CLI', kind: 'cli' }];
    });
    const store = useQuickSpawnStore();

    await store.selectMachine('b');
    expect(store.error).toBe('Tool access denied');

    await store.selectMachine('b');

    expect(attempts).toBe(2);
    expect(store.tools).toEqual([{ cliType: 'peer-cli-id', displayName: 'Peer CLI', machineId: 'b' }]);
    expect(store.error).toBe('');
    expect(store.loading).toBe(false);
  });
});

describe('machine-first Quick Spawn surfaces', () => {
  it('modal tabs load that machine’s tools and selection emits its machine and tool id', async () => {
    usePeers().configuredPeers.value = [activePeer('b', 'Box')];
    const wrapper = mount(QuickSpawnModal, {
      props: { visible: true, cliTypes: ['local-cli'], machineAware: true },
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { teleport: true } },
    });
    wrappers.push(wrapper);

    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map(tab => tab.text())).toEqual(['This PC', 'Box']);
    await tabs[1].trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.dir-picker-item__name').map(item => item.text())).toEqual(['Peer CLI']);
    await wrapper.find('.dir-picker-item').trigger('click');

    expect(wrapper.emitted('select')).toEqual([['peer-cli-id', 'b']]);
  });

  it('modal arrows and bumpers cycle machine tabs', async () => {
    usePeers().configuredPeers.value = [activePeer('b', 'Box')];
    const wrapper = mount(QuickSpawnModal, {
      props: { visible: true, cliTypes: ['local-cli'], machineAware: true },
      global: { plugins: [pinia], stubs: { teleport: true } },
    });
    wrappers.push(wrapper);
    const store = useQuickSpawnStore();

    (wrapper.vm as any).handleButton('RightBumper');
    await flushPromises();
    expect(store.machineId).toBe('b');
    (wrapper.vm as any).handleButton('DPadLeft');
    expect(store.machineId).toBe('');
  });

  it('modal tab focus does not leave the dock machine tabs focused after close', async () => {
    usePeers().configuredPeers.value = [activePeer('b', 'Box')];
    setPeerTools(async () => [
      { id: 'peer-cli-id', name: 'Peer CLI', kind: 'cli' },
      { id: 'peer-cli-id-2', name: 'Peer CLI 2', kind: 'cli' },
    ]);
    const wrapper = mount(QuickSpawnModal, {
      props: { visible: true, cliTypes: ['local-cli'], machineAware: true },
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { teleport: true } },
    });
    wrappers.push(wrapper);
    const store = useQuickSpawnStore();

    const peerTab = wrapper.findAll('[role="tab"]')[1];
    await peerTab.trigger('focusin');
    await peerTab.trigger('click');
    await flushPromises();
    expect(store.machineId).toBe('b');
    expect(store.machineTabsFocused).toBe(false);

    await wrapper.setProps({ visible: false });
    wrapper.unmount();
    sessionsState.activeFocus = 'spawn';
    sessionsState.spawnFocusIndex = 0;
    handleSpawnZone('DPadRight', 'right');

    expect(sessionsState.spawnFocusIndex).toBe(1);
    expect(store.machineId).toBe('b');
  });

  it('dock keyboard and gamepad navigation cycle machine tabs when they are focused', async () => {
    usePeers().configuredPeers.value = [activePeer('b', 'Box')];
    const store = useQuickSpawnStore();
    store.setMachineTabsFocused(true);

    handleSpawnZone('DPadRight', 'right');
    await flushPromises();
    expect(store.machineId).toBe('b');

    handleSpawnZoneButton('LeftBumper');
    await flushPromises();
    expect(store.machineId).toBe('');

    handleSpawnZoneButton('RightBumper');
    await flushPromises();
    expect(store.machineId).toBe('b');
  });

  it('shows loading and a peer refusal in the modal', async () => {
    usePeers().configuredPeers.value = [activePeer('b', 'Box')];
    let rejectPeer!: (cause: Error) => void;
    setPeerTools(() => new Promise((_resolve, reject) => { rejectPeer = reject; }));
    const wrapper = mount(QuickSpawnModal, {
      props: { visible: true, cliTypes: ['local-cli'], machineAware: true },
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { teleport: true } },
    });
    wrappers.push(wrapper);

    await wrapper.findAll('[role="tab"]')[1].trigger('click');
    expect(wrapper.text()).toContain('Loading tools');
    rejectPeer(new Error('Peer refused tools'));
    await flushPromises();

    expect(wrapper.text()).toContain('Peer refused tools');
  });

  it('dock pane shares machine selection and lists peer-owned tools', async () => {
    usePeers().configuredPeers.value = [activePeer('b', 'Box')];
    const onSpawn = vi.fn();
    const wrapper = mount(QuickSpawnPane, {
      global: {
        plugins: [pinia],
        provide: { [HELM_PANE_CONTEXT]: paneContext(onSpawn) },
      },
    });
    wrappers.push(wrapper);
    const modal = mount(QuickSpawnModal, {
      props: { visible: true, cliTypes: ['local-cli'], machineAware: true },
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { teleport: true } },
    });
    wrappers.push(modal);

    const peerTab = wrapper.findAll('[role="tab"]')[1];
    await peerTab.trigger('focusin');
    expect(sessionsState.activeFocus).toBe('spawn');
    expect(useQuickSpawnStore().machineTabsFocused).toBe(true);
    await peerTab.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.spawn-label').map(item => item.text())).toEqual(['Peer CLI']);
    expect(modal.findAll('.dir-picker-item__name').map(item => item.text())).toEqual(['Peer CLI']);
    await wrapper.find('.spawn-btn').trigger('click');

    expect(onSpawn).toHaveBeenCalledWith('peer-cli-id', 'b');
  });

  it('clears the dock tab focus flag when the pane unmounts', async () => {
    usePeers().configuredPeers.value = [activePeer('b', 'Box')];
    const wrapper = mount(QuickSpawnPane, {
      global: {
        plugins: [pinia],
        provide: { [HELM_PANE_CONTEXT]: paneContext() },
      },
    });
    wrappers.push(wrapper);

    await wrapper.findAll('[role="tab"]')[1].trigger('focusin');
    expect(useQuickSpawnStore().machineTabsFocused).toBe(true);

    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);

    expect(useQuickSpawnStore().machineTabsFocused).toBe(false);
  });

  it('renders no machine tabs on either surface without spawn targets', () => {
    const modal = mount(QuickSpawnModal, {
      props: { visible: true, cliTypes: ['local-cli'], machineAware: true },
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { teleport: true } },
    });
    const pane = mount(QuickSpawnPane, {
      global: {
        plugins: [pinia],
        provide: { [HELM_PANE_CONTEXT]: paneContext() },
      },
    });
    wrappers.push(modal, pane);

    expect(modal.findAll('[role="tab"]')).toHaveLength(0);
    expect(pane.findAll('[role="tab"]')).toHaveLength(0);
  });
});
