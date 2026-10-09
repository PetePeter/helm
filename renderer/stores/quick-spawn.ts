/** Shared machine and tool selection for both Quick Spawn surfaces. */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { usePeers } from '../composables/usePeers.js';
import { sessionsState } from '../screens/sessions-state.js';
import { getCliDisplayName } from '../utils.js';

export interface QuickSpawnMachine {
  id: string;
  label: string;
}

export interface QuickSpawnTool {
  cliType: string;
  displayName: string;
  machineId: string;
}

export const useQuickSpawnStore = defineStore('quickSpawn', () => {
  const peers = usePeers();
  const machineId = ref('');
  const peerTools = ref<Array<{ id: string; name: string; kind?: 'cli' | 'api' | 'comfyui' }>>([]);
  const loading = ref(false);
  const error = ref('');
  const machineTabsFocused = ref(false);
  let requestId = 0;

  const machines = computed<QuickSpawnMachine[]>(() => [
    { id: '', label: 'This PC' },
    ...peers.spawnTargets.value.map(peer => ({ id: peer.id, label: peer.alias })),
  ]);
  const hasRemoteTargets = computed(() => peers.spawnTargets.value.length > 0);
  const tools = computed<QuickSpawnTool[]>(() => machineId.value
    ? peerTools.value.map(tool => ({ cliType: tool.id, displayName: tool.name, machineId: machineId.value }))
    : sessionsState.cliTypes.map(cliType => ({
      cliType,
      displayName: getCliDisplayName(cliType),
      machineId: '',
    })));

  function showLocalTools(): void {
    requestId++;
    machineId.value = '';
    peerTools.value = [];
    loading.value = false;
    error.value = '';
    sessionsState.spawnFocusIndex = 0;
  }

  async function selectMachine(id: string): Promise<void> {
    if (!id) {
      showLocalTools();
      return;
    }
    if (!peers.spawnTargets.value.some(peer => peer.id === id)) {
      showLocalTools();
      return;
    }
    if (machineId.value === id && (loading.value || peerTools.value.length > 0)) return;

    const currentRequest = ++requestId;
    machineId.value = id;
    peerTools.value = [];
    loading.value = true;
    error.value = '';
    sessionsState.spawnFocusIndex = 0;
    try {
      const tools = await peers.listPeerCliTypes(id);
      if (requestId !== currentRequest || machineId.value !== id) return;
      peerTools.value = tools;
      if (tools.length === 0) error.value = 'No tools available on that machine.';
    } catch (cause) {
      if (requestId === currentRequest && machineId.value === id) {
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      if (requestId === currentRequest && machineId.value === id) loading.value = false;
    }
  }

  function cycleMachine(step: number): void {
    const ids = machines.value.map(machine => machine.id);
    if (ids.length < 2) return;
    const at = Math.max(0, ids.indexOf(machineId.value));
    void selectMachine(ids[(at + step + ids.length) % ids.length]);
  }

  function setMachineTabsFocused(focused: boolean): void {
    machineTabsFocused.value = focused;
  }

  watch(peers.spawnTargets, targets => {
    if (machineId.value && !targets.some(peer => peer.id === machineId.value)) showLocalTools();
  });

  return {
    machineId,
    machines,
    hasRemoteTargets,
    tools,
    loading,
    error,
    machineTabsFocused,
    selectMachine,
    cycleMachine,
    setMachineTabsFocused,
  };
});
