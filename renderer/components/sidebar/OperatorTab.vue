<script setup lang="ts">
/**
 * OperatorTab.vue: the router-only "Helm" operator session voice clients talk
 * to (docs/voice-operator.md) — on/off, which CLI type runs it, where.
 */
import { onMounted, ref } from 'vue';
import { configClient } from '../../ipc/clients.js';
import { getCliDisplayName } from '../../utils.js';

interface OperatorConfig { enabled: boolean; cliType: string; workingDir: string; compactEveryMinutes: number }

const config = ref<OperatorConfig>({ enabled: false, cliType: '', workingDir: '', compactEveryMinutes: 60 });
const COMPACT_CHOICES = [
  { minutes: 0, label: 'Off' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 120, label: 'Every 2 hours' },
  { minutes: 240, label: 'Every 4 hours' },
];
const cliTypes = ref<string[]>([]);
const dirs = ref<Array<{ name: string; path: string }>>([]);
const status = ref('');

onMounted(async () => {
  const [loaded, types, workingDirs] = await Promise.all([
    configClient.configGetOperatorConfig(),
    configClient.configGetCliTypes(),
    configClient.configGetWorkingDirs(),
  ]);
  config.value = loaded;
  cliTypes.value = types ?? [];
  dirs.value = workingDirs ?? [];
});

async function save(updates: Partial<OperatorConfig>): Promise<void> {
  const result = await configClient.configSetOperatorConfig(updates);
  if (result.success) {
    config.value = { ...config.value, ...updates };
    status.value = '';
  } else {
    // The controls bind one-way: re-read so a failed save does not leave the
    // checkbox or dropdowns showing a value that was never stored.
    config.value = await configClient.configGetOperatorConfig();
    status.value = result.error ?? 'Could not save setting';
  }
}

const selectValue = (event: Event): string => (event.target as HTMLSelectElement).value;
</script>

<template>
  <div class="settings-operator-panel">
    <div class="settings-panel__header">
      <span class="settings-panel__title">Operator</span>
    </div>

    <div class="settings-help">
      <p>A single locked session named <strong>Helm</strong> that the phone and desktop talk to.
        It only routes your instructions to work sessions and relays their answers; it never does the work itself.</p>
    </div>

    <label class="operator-setting">
      <input
        type="checkbox"
        class="focusable"
        :checked="config.enabled"
        @change="save({ enabled: ($event.target as HTMLInputElement).checked })"
      />
      <span>Keep the Helm operator session running</span>
    </label>

    <label class="operator-setting">
      <span>CLI type</span>
      <select class="btn btn--secondary btn--sm focusable" :value="config.cliType" @change="save({ cliType: selectValue($event) })">
        <option value="" disabled>Choose a CLI type…</option>
        <option v-for="type in cliTypes" :key="type" :value="type">{{ getCliDisplayName(type) }}</option>
      </select>
    </label>

    <label class="operator-setting">
      <span>Working directory</span>
      <select class="btn btn--secondary btn--sm focusable" :value="config.workingDir" @change="save({ workingDir: selectValue($event) })">
        <option value="">CLI default</option>
        <option v-for="dir in dirs" :key="dir.path" :value="dir.path">{{ dir.name }}</option>
      </select>
    </label>

    <label class="operator-setting">
      <span>Auto-compact when idle</span>
      <select
        class="btn btn--secondary btn--sm focusable"
        :value="config.compactEveryMinutes"
        @change="save({ compactEveryMinutes: Number(selectValue($event)) })"
      >
        <option v-if="!COMPACT_CHOICES.some(c => c.minutes === config.compactEveryMinutes)" :value="config.compactEveryMinutes">
          Every {{ config.compactEveryMinutes }} minutes
        </option>
        <option v-for="choice in COMPACT_CHOICES" :key="choice.minutes" :value="choice.minutes">{{ choice.label }}</option>
      </select>
    </label>

    <span v-if="status" class="operator-status">{{ status }}</span>
  </div>
</template>

<style scoped>
.operator-setting {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) 0;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.operator-status {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}
</style>
