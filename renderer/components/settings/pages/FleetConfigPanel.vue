<script setup lang="ts">
/**
 * FleetConfigPanel.vue — in-app cross-machine fleet config (P-0658).
 * An enabled checkbox, a port, and live status. Emits `update` with a partial on
 * each change; the parent persists + hot-applies (no app restart). Port is
 * normalised to the default when invalid.
 *
 * There is deliberately NO host input: the bind host is a wildcard in every real
 * deployment, and the status line already shows the concrete addresses a peer
 * must dial — which is the only thing a user can act on. The value is still
 * honoured from settings.yaml for anyone who needs to pin one interface.
 */
import { ref, watch, computed } from 'vue';

export interface FleetConfig {
  enabled: boolean;
  host: string;
  port: number;
}

const DEFAULT_PORT = 47474;

export interface FleetStatus {
  enabled: boolean;
  running: boolean;
  error: string | null;
  addresses: string[];
  allInterfaces: boolean;
}

const props = defineProps<{ config: FleetConfig; status?: FleetStatus }>();
const emit = defineEmits<{ update: [updates: Partial<FleetConfig>] }>();

const localEnabled = ref(props.config.enabled);
const localPort = ref(props.config.port);

watch(() => props.config, (c) => {
  localEnabled.value = c.enabled;
  localPort.value = c.port;
});

function onToggleEnabled(): void {
  emit('update', { enabled: localEnabled.value });
}

function commitPort(): void {
  const port = normalizePort(String(localPort.value));
  localPort.value = port;
  emit('update', { port });
}

function normalizePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_PORT;
  }
  return parsed;
}

// Status reflects the ROUND-TRIPPED, server-confirmed config (props.config), NOT
// the local form refs — so it shows "Running" only after the IPC persist + live
// hot-apply confirms, and reverts to "Off" if a change fails to apply. The form
// inputs stay bound to the local refs for editing.
//
// A failed start must be VISIBLE here. Reporting "Running" while the stack is
// dead (which is what happened when mDNS crashed at startup) leaves the user
// with nothing to debug against.
const statusText = computed(() => {
  if (!props.config.enabled) return 'Off';
  if (props.status && !props.status.running) return 'Failed to start';
  return 'Running';
});
const statusOn = computed(() => props.config.enabled && props.status?.running !== false);
const statusFailed = computed(() => props.config.enabled && props.status?.running === false);

/**
 * The addresses another machine can actually pair against. "0.0.0.0" is correct
 * and unusable — nobody can type it into the other Helm.
 */
const addressLines = computed(() => props.status?.addresses ?? []);

async function copyAddress(address: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(address);
  } catch {
    /* clipboard unavailable — the text is selectable anyway */
  }
}
</script>

<template>
  <div class="fleet-config-panel">
    <div class="tg-section">
      <h3 class="tg-section-title">Fleet</h3>
      <div class="tg-form-row">
        <label class="tg-label">Enable cross-machine fleet</label>
        <input
          v-model="localEnabled"
          type="checkbox"
          class="focusable"
          @change="onToggleEnabled"
        />
      </div>
      <div class="tg-form-row">
        <label class="tg-label">Port</label>
        <input
          v-model.number="localPort"
          type="number"
          class="fcp-input focusable"
          min="1"
          max="65535"
          step="1"
          @change="commitPort"
          @blur="commitPort"
        />
      </div>
      <div class="fcp-status-row">
        <span class="fcp-status-label">Status</span>
        <span
          class="fcp-status-value"
          :class="{ 'fcp-status-value--on': statusOn, 'fcp-status-value--error': statusFailed }"
        >{{ statusText }}</span>
      </div>

      <p v-if="props.status?.error" class="fcp-error">{{ props.status.error }}</p>

      <div v-if="config.enabled && addressLines.length" class="fcp-addresses">
        <span class="fcp-status-label">Pair from another machine using</span>
        <button
          v-for="address in addressLines"
          :key="address"
          class="fcp-address focusable"
          type="button"
          title="Copy"
          @click="copyAddress(address)"
        >{{ address }}</button>
      </div>
      <p v-else-if="config.enabled && props.status?.allInterfaces" class="fcp-hint">
        No LAN address found — this machine may not be on a network.
      </p>

      <p class="fcp-hint">
        Applied live — no restart needed. The other machine must allow TCP {{ config.port }}
        and UDP 5353 (mDNS) through its firewall.
      </p>
    </div>
  </div>
</template>

<style scoped>
.fleet-config-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tg-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-primary);
}
.tg-section-title {
  margin: 0;
  font-size: 0.88rem;
  color: var(--text-primary);
}
.tg-form-row {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
.tg-label {
  font-size: 0.85rem;
  color: var(--text-primary);
}
.fcp-input {
  min-width: 140px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.85rem;
}
.fcp-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.fcp-status-label {
  font-size: 0.8rem;
  color: var(--text-secondary);
}
.fcp-status-value {
  font-size: 0.82rem;
  color: var(--text-secondary);
  font-family: ui-monospace, "Cascadia Code", monospace;
}
.fcp-status-value--on {
  color: #44cc44;
}
.fcp-hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-secondary);
  line-height: 1.35;
}
.fcp-status-value--error { color: #ff6666; }
.fcp-error {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(255, 102, 102, 0.12);
  border: 1px solid rgba(255, 102, 102, 0.4);
  color: var(--text-primary);
  font-size: 0.76rem;
  font-family: ui-monospace, "Cascadia Code", monospace;
  overflow-wrap: anywhere;
}
.fcp-addresses {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.fcp-address {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 0.8rem;
  cursor: pointer;
}
.fcp-address:hover { border-color: var(--accent); }
</style>
