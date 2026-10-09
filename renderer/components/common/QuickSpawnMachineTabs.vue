<script setup lang="ts">
import type { QuickSpawnMachine } from '../../stores/quick-spawn.js';

defineProps<{
  machines: QuickSpawnMachine[];
  activeMachineId: string;
  visible: boolean;
  loading?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  select: [machineId: string];
  tabsFocus: [];
  tabsBlur: [];
}>();

function onFocusout(event: FocusEvent): void {
  const current = event.currentTarget;
  const next = event.relatedTarget;
  if (!(current instanceof HTMLElement) || !(next instanceof Node) || !current.contains(next)) {
    emit('tabsBlur');
  }
}
</script>

<template>
  <div
    v-if="visible"
    class="dir-picker-machines quick-spawn-machine-tabs"
    role="tablist"
    aria-label="Machine"
    @focusin="emit('tabsFocus')"
    @focusout="onFocusout"
  >
    <button
      v-for="machine in machines"
      :key="machine.id || 'local'"
      class="btn btn--sm dir-picker-machine"
      :class="{ 'dir-picker-machine--active': machine.id === activeMachineId }"
      type="button"
      role="tab"
      :aria-selected="machine.id === activeMachineId"
      @click="emit('select', machine.id)"
    >{{ machine.label }}</button>
  </div>
  <div v-if="loading" class="quick-spawn-status">Loading tools…</div>
  <div v-else-if="error" class="quick-spawn-status quick-spawn-status--error">{{ error }}</div>
</template>

<style scoped>
.dir-picker-machines {
  display: flex;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-sm) 0;
  flex-wrap: wrap;
}

.dir-picker-machine--active {
  background: var(--accent);
  color: var(--bg-primary);
}

.quick-spawn-status {
  padding: var(--spacing-md);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.quick-spawn-status--error {
  color: var(--danger);
}
</style>
