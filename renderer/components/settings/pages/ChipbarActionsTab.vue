<script setup lang="ts">
import AppButton from '../../common/AppButton.vue';
/**
 * ChipbarActionsTab.vue — Chip bar actions CRUD with reordering.
 */
import { ref, watch } from 'vue';
import { CHIPBAR_TEMPLATE_DEFINITIONS } from '../../../chipbar-templates.js';
import SettingsEmptyState from '../../common/SettingsEmptyState.vue';

export interface ChipbarAction {
  label: string;
  sequence: string;
}

const props = defineProps<{
  actions: ChipbarAction[];
}>();

const emit = defineEmits<{
  add: [];
  edit: [index: number];
  delete: [index: number];
  move: [fromIndex: number, toIndex: number];
}>();

const deleteConfirmIndex = ref<number | null>(null);

watch(() => props.actions, () => {
  deleteConfirmIndex.value = null;
});

function onDeleteClick(index: number): void {
  if (deleteConfirmIndex.value === index) {
    emit('delete', index);
    deleteConfirmIndex.value = null;
  } else {
    deleteConfirmIndex.value = index;
    setTimeout(() => {
      if (deleteConfirmIndex.value === index) {
        deleteConfirmIndex.value = null;
      }
    }, 3000);
  }
}

function sequencePreview(sequence: string): string {
  return sequence.length > 50 ? sequence.slice(0, 47) + '...' : sequence;
}
</script>

<template>
  <div class="settings-chipbar-panel">
    <div class="settings-panel__header">
      <span class="settings-panel__title">Chip Bar Actions</span>
      <AppButton variant="primary" size="sm" class="focusable" @click="emit('add')">
        + Add Action
      </AppButton>
    </div>

    <div class="settings-help">
      <p><strong>Chip Bar Actions</strong> are global quick-action buttons that appear in the chipbar below every terminal.</p>
      <p><strong>Global actions shown for every CLI.</strong></p>
      <p><strong>Template expansions:</strong></p>
      <ul class="settings-help__list">
        <li v-for="def in CHIPBAR_TEMPLATE_DEFINITIONS" :key="def.token">
          <code>{{ def.token }}</code> → {{ def.description }}
        </li>
      </ul>
      <p><strong>Installer-safe paths:</strong> <code>{inboxDir}</code> and <code>{plansDir}</code> resolve from the app's writable config directory.</p>
      <p><strong>Sequence syntax:</strong> Use {Enter}, {Ctrl+C}, {Wait 500}, etc.</p>
    </div>

    <div class="settings-list">
      <div
        v-for="(action, index) in actions"
        :key="index"
        class="settings-list-item"
        :data-action-index="index"
      >
        <div class="settings-list-item__info">
          <span class="settings-list-item__name">{{ action.label }}</span>
          <span class="settings-list-item__detail">{{ sequencePreview(action.sequence) }}</span>
        </div>
        <div class="settings-list-item__actions">
          <AppButton variant="ghost" size="sm"
            class="focusable"
            :disabled="index === 0"
            :tabindex="index === 0 ? -1 : 0"
            title="Move up"
            @click="emit('move', index, index - 1)"
          >
            ↑
          </AppButton>
          <AppButton variant="ghost" size="sm"
            class="focusable"
            :disabled="index === actions.length - 1"
            :tabindex="index === actions.length - 1 ? -1 : 0"
            title="Move down"
            @click="emit('move', index, index + 1)"
          >
            ↓
          </AppButton>
          <AppButton variant="secondary" size="sm" class="focusable" @click="emit('edit', index)">
            Edit
          </AppButton>
          <AppButton variant="danger" size="sm"
            class="focusable"
            @click="onDeleteClick(index)"
          >
            {{ deleteConfirmIndex === index ? 'Confirm?' : 'Delete' }}
          </AppButton>
        </div>
      </div>
      <SettingsEmptyState v-if="actions.length === 0" as="p">
        No chip bar actions configured
      </SettingsEmptyState>
    </div>
  </div>
</template>
