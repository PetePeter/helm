<script setup lang="ts">
/**
 * Directory picker modal — select a working directory to spawn a CLI in.
 *
 * The caller passes directories for the already selected machine. Machine
 * selection happens in Quick Spawn, before choosing a tool.
 *
 * Gamepad D-pad up/down navigates (clamped), A selects, B cancels.
 * Keyboard routed via App.vue bridge → useModalStack → handleButton.
 */
import { computed, ref, watch, nextTick } from 'vue';
import { SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { useModalAutofocus } from '../../composables/useModalAutofocus.js';
import { toDirection, getCliDisplayName } from '../../utils.js';
import { jumpKeyLabel, jumpButtonToPosition } from '../../utils/jump-keys.js';

interface DirItem {
  name: string;
  path: string;
  projectId?: string;
  projectName?: string;
  isCanonical?: boolean;
}

const MODAL_ID = 'dir-picker';

const props = defineProps<{
  visible: boolean;
  cliType: string;
  items: DirItem[];
  preselectedPath?: string;
  machineId?: string;
  loading?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'select', path: string, machineId: string): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const selectedIndex = ref(0);
const modalStack = useModalStack();
const overlayRef = ref<HTMLElement | null>(null);
const { focusIntoModal } = useModalAutofocus(overlayRef, '.dir-picker-item--focused');

const sections = computed(() => {
  const shouldGroup = props.items.some(item => item.projectName);
  if (!shouldGroup) {
    return [{ title: '', items: props.items.map((item, index) => ({ item, index })) }];
  }

  const grouped = new Map<string, { title: string; items: Array<{ item: DirItem; index: number }> }>();
  props.items.forEach((item, index) => {
    const title = item.projectName || 'Other';
    const key = item.projectId || title;
    if (!grouped.has(key)) grouped.set(key, { title, items: [] });
    grouped.get(key)!.items.push({ item, index });
  });
  for (const section of grouped.values()) {
    section.items.sort((a, b) => {
      if (a.item.isCanonical && !b.item.isCanonical) return -1;
      if (!a.item.isCanonical && b.item.isCanonical) return 1;
      return 0;
    });
  }
  return [...grouped.values()];
});

async function focusCurrentItem(): Promise<void> {
  await nextTick();
  const target = overlayRef.value?.querySelector<HTMLElement>(`#dir-picker-option-${selectedIndex.value}`);
  target?.focus();
}

watch(() => props.visible, (v) => {
  if (v) {
    const preIdx = props.preselectedPath
      ? props.items.findIndex(d => d.path === props.preselectedPath)
      : -1;
    selectedIndex.value = preIdx >= 0 ? preIdx : 0;
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: SELECTION_KEYS });
    void focusIntoModal();
    void focusCurrentItem();
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

function handleButton(button: string): boolean {
  const dir = toDirection(button);
  if (dir === 'up' || button === 'ShiftTab') {
    selectedIndex.value = Math.max(0, selectedIndex.value - 1);
    void focusCurrentItem();
    return true;
  }
  if (dir === 'down' || button === 'Tab') {
    selectedIndex.value = Math.min(props.items.length - 1, selectedIndex.value + 1);
    void focusCurrentItem();
    return true;
  }
  if (button === 'A') {
    selectDir(selectedIndex.value);
    return true;
  }
  if (button === 'B') {
    emit('cancel');
    emit('update:visible', false);
    return true;
  }
  const pos = jumpButtonToPosition(button);
  if (pos !== null && pos < props.items.length) {
    selectDir(pos);
    return true;
  }
  return true;
}

function selectDir(index: number): void {
  const item = props.items[index];
  if (item) {
    emit('select', item.path, props.machineId ?? '');
    emit('update:visible', false);
  }
}

function suppressActivationKey(e: KeyboardEvent): void {
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
  }
}

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="overlayRef"
      class="modal-overlay modal--visible dir-picker-overlay"
      role="dialog"
      aria-label="Select working directory"
      tabindex="-1"
    >
      <div class="modal">
        <div class="modal-header">
          <h3 class="modal-title">{{ getCliDisplayName(cliType) }} — Select Directory</h3>
        </div>
        <div v-if="loading" class="dir-picker-status">Loading directories…</div>
        <div v-else-if="error" class="dir-picker-status dir-picker-status--error">{{ error }}</div>
        <div
          v-else
          class="dir-picker-list"
          id="dirPickerList"
          role="listbox"
          aria-label="Directories"
          :aria-activedescendant="items[selectedIndex] ? `dir-picker-option-${selectedIndex}` : undefined"
        >
          <template v-for="section in sections" :key="section.title || 'directories'">
            <div v-if="section.title" class="dir-picker-section" role="presentation">
              {{ section.title }}
            </div>
            <div
              v-for="{ item, index: i } in section.items"
              :id="`dir-picker-option-${i}`"
              :key="item.path"
              class="dir-picker-item focusable"
              :class="{ 'dir-picker-item--focused': i === selectedIndex }"
              tabindex="-1"
              role="option"
              :aria-selected="i === selectedIndex"
              @keydown="suppressActivationKey"
              @click="selectDir(i)"
            >
              <span v-if="jumpKeyLabel(i) != null" class="jump-key">{{ jumpKeyLabel(i) }}</span>
              <span class="dir-picker-item__body">
                <span class="dir-picker-item__name">
                  {{ item.name }}
                  <span v-if="item.isCanonical" class="dir-picker-item__badge">[Main]</span>
                </span>
                <span class="dir-picker-item__path">{{ item.path }}</span>
              </span>
            </div>
          </template>
        </div>
        <div class="modal-footer">
          <button class="btn" tabindex="-1" @keydown="suppressActivationKey" @click="emit('cancel'); emit('update:visible', false)">Cancel</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dir-picker-section {
  padding: 10px 12px 4px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.dir-picker-status {
  padding: 12px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.dir-picker-status--error {
  color: var(--danger);
}

.dir-picker-item__badge {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
}
</style>
