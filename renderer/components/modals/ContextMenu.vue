<script setup lang="ts">
/**
 * Context menu overlay — the terminal's right-click menu and the session row's
 * kebab (⋮). Items come from buildContextMenuItems (renderer/modals/context-menu-items.ts).
 * Gamepad D-pad up/down navigates (skipping disabled items), A executes, B cancels.
 */
import { ref, watch, computed } from 'vue';
import { SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { toDirection } from '../../utils.js';
import { jumpKeyLabel, jumpButtonToPosition } from '../../utils/jump-keys.js';
import { buildContextMenuItems, type ContextMenuContext, type ContextMenuItem } from '../../modals/context-menu-items.js';

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
  /** 'session' = the row kebab; 'terminal' (default) = right-click on the terminal. */
  mode?: ContextMenuContext['mode'];
  /** The context session's toggles, which pick labels and the frozen short list. */
  sessionFlags?: ContextMenuContext['session'];
}>();

const emit = defineEmits<{
  (e: 'action', action: string): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const selectedIndex = ref(0);
const modalStack = useModalStack();

const menuItems = computed<ContextMenuItem[]>(() => buildContextMenuItems({
  mode: props.mode ?? 'terminal',
  hasSelection: props.hasSelection,
  hasActiveSession: props.hasActiveSession,
  isSnappedOut: props.isSnappedOut,
  currentGroupName: props.currentGroupName ?? null,
  session: props.sessionFlags ?? { locked: false, frozen: false, keepWarm: false, hiddenFromOverview: false },
}));

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
