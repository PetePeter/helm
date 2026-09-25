<script setup lang="ts">
/**
 * UpdatesTab.vue: self-update settings — launch-time check on/off + Check now.
 */
import { onMounted, ref } from 'vue';
import { appClient, updateClient } from '../../ipc/clients.js';
import { checkForAppUpdateNow } from '../../composables/useUpdateCheck.js';

type UpdateCheckMode = 'auto' | 'manual';

const mode = ref<UpdateCheckMode>('auto');
const version = ref('');
const status = ref('');
const checking = ref(false);

onMounted(async () => {
  [mode.value, version.value] = await Promise.all([updateClient.updateGetMode(), appClient.appGetVersion()]);
});

async function onModeChange(event: Event): Promise<void> {
  const next = (event.target as HTMLSelectElement).value as UpdateCheckMode;
  const result = await updateClient.updateSetMode(next);
  if (result.success) mode.value = next;
  else status.value = result.error ?? 'Could not save setting';
}

async function onCheckNow(): Promise<void> {
  checking.value = true;
  status.value = 'Checking…';
  try {
    status.value = await checkForAppUpdateNow();
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <div class="settings-updates-panel">
    <div class="settings-panel__header">
      <span class="settings-panel__title">Updates</span>
    </div>

    <div class="settings-help">
      <p>Running <strong>Helm v{{ version }}</strong>. Updates come from GitHub releases; accepting one
        downloads, installs silently and restarts Helm with your sessions resumed.</p>
    </div>

    <label class="updates-setting">
      <span>Check for updates</span>
      <select class="btn btn--secondary btn--sm focusable" :value="mode" @change="onModeChange">
        <option value="auto">Automatically at launch</option>
        <option value="manual">Manually only</option>
      </select>
    </label>

    <div class="updates-setting">
      <button class="btn btn--primary btn--sm focusable" :disabled="checking" @click="onCheckNow">Check now</button>
      <span v-if="status" class="updates-status">{{ status }}</span>
    </div>
  </div>
</template>

<style scoped>
.updates-setting {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) 0;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.updates-status {
  color: var(--text-secondary);
}
</style>
