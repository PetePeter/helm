<script setup lang="ts">
import AppButton from '../../common/AppButton.vue';
import { ref } from 'vue';
import Badge from '../../common/Badge.vue';
import SettingsEmptyState from '../../common/SettingsEmptyState.vue';

export interface BindingEntry {
  button: string;
  action: string;
  label: string;
  detail: string;
}

export interface BindingProfileOption {
  id: string;
  name: string;
}

const props = defineProps<{
  bindings: BindingEntry[];
  profiles: BindingProfileOption[];
  profileId: string;
  addableButtons: string[];
  sortField: string;
  sortDirection: 'asc' | 'desc';
}>();

const emit = defineEmits<{
  addBinding: [button: string];
  editBinding: [button: string];
  deleteBinding: [button: string];
  selectProfile: [id: string];
  createProfile: [copyCurrent: boolean];
  renameProfile: [];
  deleteProfile: [];
  sortChange: [field: string, direction: 'asc' | 'desc'];
}>();

const pendingDelete = ref<string | null>(null);
const deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

function onAddBinding(event: Event): void {
  const target = event.target as HTMLSelectElement;
  if (!target.value) return;
  emit('addBinding', target.value);
  target.value = '';
}

const PROFILE_DELETE_KEY = '__profile__';

function onProfileChange(event: Event): void {
  emit('selectProfile', (event.target as HTMLSelectElement).value);
}

function onDeleteProfileClick(): void {
  if (pendingDelete.value === PROFILE_DELETE_KEY) {
    clearTimer(PROFILE_DELETE_KEY);
    pendingDelete.value = null;
    emit('deleteProfile');
    return;
  }
  armDelete(PROFILE_DELETE_KEY);
}

function onSortFieldChange(event: Event): void {
  const target = event.target as HTMLSelectElement;
  emit('sortChange', target.value, props.sortDirection);
}

function onToggleDirection(): void {
  emit('sortChange', props.sortField, props.sortDirection === 'asc' ? 'desc' : 'asc');
}

function onDeleteClick(button: string): void {
  if (pendingDelete.value === button) {
    clearTimer(button);
    pendingDelete.value = null;
    emit('deleteBinding', button);
    return;
  }
  armDelete(button);
}

/** Two-click confirm: the first click arms, a second within 3s commits. */
function armDelete(key: string): void {
  if (pendingDelete.value) clearTimer(pendingDelete.value);
  pendingDelete.value = key;
  const timer = setTimeout(() => {
    pendingDelete.value = null;
    deleteTimers.delete(key);
  }, 3000);
  deleteTimers.set(key, timer);
}

function clearTimer(button: string): void {
  const t = deleteTimers.get(button);
  if (t) { clearTimeout(t); deleteTimers.delete(button); }
}
</script>

<template>
  <div class="settings-bindings-panel">
    <div class="settings-panel__header">
      <span class="settings-panel__title">Binding Profiles</span>
      <div class="bindings-toolbar">
        <select class="app-select app-select--secondary app-select--sm bindings-profile-select focusable"

          :value="profileId"
          :disabled="profiles.length === 0"
          @change="onProfileChange"
        >
          <option v-if="profiles.length === 0" value="">No profiles</option>
          <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
        </select>
        <AppButton variant="primary" size="sm" class="bindings-profile-new focusable" @click="emit('createProfile', false)">+ New</AppButton>
        <template v-if="profileId">
          <AppButton variant="secondary" size="sm" class="bindings-profile-duplicate focusable" @click="emit('createProfile', true)">Duplicate</AppButton>
          <AppButton variant="secondary" size="sm" class="bindings-profile-rename focusable" @click="emit('renameProfile')">Rename</AppButton>
          <AppButton variant="danger" size="sm"
            class="bindings-profile-delete focusable"
            :title="pendingDelete === PROFILE_DELETE_KEY ? 'Click again to confirm — tools using it get no bindings' : 'Delete profile'"
            @click="onDeleteProfileClick"
          >{{ pendingDelete === PROFILE_DELETE_KEY ? 'Confirm?' : 'Delete' }}</AppButton>
        </template>
      </div>
    </div>

    <div v-if="profileId" class="bindings-toolbar">
        <select class="app-select app-select--primary app-select--sm bindings-add-select focusable"

          :disabled="addableButtons.length === 0"
          @change="onAddBinding"
        >
          <option value="">{{ addableButtons.length > 0 ? '+ Add Binding' : 'All buttons mapped' }}</option>
          <option v-for="button in addableButtons" :key="button" :value="button">{{ button }}</option>
        </select>
        <select class="app-select app-select--secondary app-select--sm bindings-sort-select focusable"

          :value="sortField"
          @change="onSortFieldChange"
        >
          <option value="button">Sort: Button</option>
          <option value="action">Sort: Action</option>
        </select>
        <AppButton variant="secondary" size="sm" class="bindings-sort-direction focusable" @click="onToggleDirection">
          {{ sortDirection === 'asc' ? '↑' : '↓' }}
        </AppButton>
    </div>

    <SettingsEmptyState v-if="!profileId">
      No binding profiles yet. Create one, then pick it per tool in the tool editor.
    </SettingsEmptyState>
    <SettingsEmptyState v-else-if="bindings.length === 0">
      No bindings in this profile.
    </SettingsEmptyState>

    <div class="bindings-display">
      <div
        v-for="binding in bindings"
        :key="binding.button"
        class="binding-card focusable"
        style="cursor: pointer"
        tabindex="0"
        @click="emit('editBinding', binding.button)"
        @keydown.enter="emit('editBinding', binding.button)"
      >
        <div class="binding-card__header">
          <span class="binding-card__button">{{ binding.button }}</span>
          <Badge class="binding-action" tone="neutral">{{ binding.action }}</Badge>
          <AppButton variant="danger" size="sm"
            class="binding-card__delete focusable"
            :title="pendingDelete === binding.button ? 'Click again to confirm' : `Remove ${binding.button}`"
            @click.stop="onDeleteClick(binding.button)"
          >{{ pendingDelete === binding.button ? '?' : '✕' }}</AppButton>
        </div>
        <div v-if="binding.detail" class="binding-card__details">{{ binding.detail }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bindings-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.settings-bindings-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.bindings-display {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.binding-card {
  position: relative;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--spacing-sm);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  transition: border-color 0.15s;
}

.binding-card:hover {
  border-color: var(--accent);
}

.binding-card__header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.binding-card__button {
  font-size: var(--font-size-lg);
  font-weight: 700;
  color: var(--accent);
  font-family: monospace;
}

.binding-action {
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  font-weight: 500;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.binding-action.badge--neutral.badge {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.binding-card__details {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-family: monospace;
}

.binding-card__delete {
  margin-left: auto;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 12px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: 4px;
  opacity: 0.6;
  flex-shrink: 0;
}

.binding-card__delete:hover,
.binding-card__delete:focus {
  opacity: 1;
}
</style>
