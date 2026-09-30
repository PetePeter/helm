<script setup lang="ts">
/**
 * Context menu overlay — Copy/Paste/Editor/New Session/etc.
 *
 * Items are conditionally enabled based on selection state and session state.
 * Gamepad D-pad up/down navigates (skipping disabled items), A executes, B cancels.
 */
import { ref, watch, computed } from 'vue';
import { SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { toDirection } from '../../utils.js';
import { jumpKeyLabel, jumpButtonToPosition } from '../../utils/jump-keys.js';

interface MenuItem {
  id: string;
  label: string;
  enabled: boolean;
}

const MODAL_ID = 'context-menu';

const props = defineProps<{
  visible: boolean;
  hasSelection: boolean;
  hasActiveSession: boolean;
  hasSequences: boolean;
  hasDrafts: boolean;
  isSnappedOut: boolean;
  /** Name of the runtime group the context session is in, or null when ungrouped. */
  currentGroupName?: string | null;
}>();

const emit = defineEmits<{
  (e: 'action', action: string): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const selectedIndex = ref(0);
const modalStack = useModalStack();

const menuItems = computed<MenuItem[]>(() => [
  { id: 'copy', label: '📋 Copy', enabled: props.hasSelection },
  { id: 'paste', label: '📎 Paste', enabled: props.hasActiveSession },
  { id: 'editor', label: '📝 Compose in Editor', enabled: props.hasActiveSession },
  { id: 'new-session', label: '🆕 New Session', enabled: true },
  { id: 'new-session-with-selection', label: '📌 New Session with Selection', enabled: props.hasSelection },
  { id: 'prompts', label: '⚡ Prompts…', enabled: props.hasActiveSession },
  { id: 'drafts', label: '📝 Drafts…', enabled: props.hasActiveSession },
  { id: 'quick-compact', label: '🗜️ Helm Compact', enabled: props.hasActiveSession },
  { id: 'clone-session', label: '🧬 Clone', enabled: props.hasActiveSession },
  { id: 'switch-cli', label: '🔀 Switch CLI…', enabled: props.hasActiveSession },
  { id: 'move-to-group', label: '🗂️ Move to group…', enabled: props.hasActiveSession },
  {
    id: 'remove-from-group',
    label: props.currentGroupName ? `↩ Remove from “${props.currentGroupName}”` : '↩ Remove from group',
    enabled: props.hasActiveSession && !!props.currentGroupName,
  },
  { id: 'snap-out', label: '📤 Snap Out', enabled: props.hasActiveSession && !props.isSnappedOut },
  { id: 'snap-back', label: '📥 Snap Back', enabled: props.isSnappedOut },
  { id: 'cancel', label: '✖ Cancel', enabled: true },
]);

const enabledIndices = computed(() =>
  menuItems.value.map((item, i) => item.enabled ? i : -1).filter(i => i >= 0),
);

/** Jump-number label per menu index — numbers enabled items in order. */
const jumpLabels = computed(() => {
  const labels = new Map<number, number>();
  enabledIndices.value.forEach((menuIdx, pos) => {
    const label = jumpKeyLabel(pos);
    if (label !== null) labels.set(menuIdx, label);
  });
  return labels;
});

watch(() => props.visible, (v) => {
  if (v) {
    // Select first enabled item
    selectedIndex.value = enabledIndices.value[0] ?? 0;
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: SELECTION_KEYS });
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

function findNextEnabled(fromIndex: number, direction: 1 | -1): number {
  const indices = enabledIndices.value;
  if (indices.length === 0) return fromIndex;
  const currentPos = indices.indexOf(fromIndex);
  if (currentPos < 0) return indices[0];
  const nextPos = (currentPos + direction + indices.length) % indices.length;
  return indices[nextPos];
}

function handleButton(button: string): boolean {
  const dir = toDirection(button);
  if (dir === 'up') {
    selectedIndex.value = findNextEnabled(selectedIndex.value, -1);
    return true;
  }
  if (dir === 'down') {
    selectedIndex.value = findNextEnabled(selectedIndex.value, 1);
    return true;
  }
  if (button === 'A') {
    executeItem(selectedIndex.value);
    return true;
  }
  if (button === 'B') {
    emit('cancel');
    emit('update:visible', false);
    return true;
  }
  const pos = jumpButtonToPosition(button);
  if (pos !== null && pos < enabledIndices.value.length) {
    executeItem(enabledIndices.value[pos]);
    return true;
  }
  return true;
}

function executeItem(index: number): void {
  const item = menuItems.value[index];
  if (!item || !item.enabled) return;
  if (item.id === 'cancel') {
    emit('cancel');
  } else {
    emit('action', item.id);
  }
  emit('update:visible', false);
}

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="modal-overlay modal--visible"
      role="menu"
      aria-label="Terminal context menu"
    >
      <div class="context-menu">
        <div
          v-for="(item, i) in menuItems"
          :key="item.id"
          class="context-menu-item"
          :class="{
            'context-menu-item--selected': i === selectedIndex,
            'context-menu-item--disabled': !item.enabled,
          }"
          :data-action="item.id"
          @click="item.enabled && executeItem(i)"
        >
          <span v-if="jumpLabels.has(i)" class="jump-key">{{ jumpLabels.get(i) }}</span>
          {{ item.label }}
        </div>
      </div>
    </div>
  </Teleport>
</template>
