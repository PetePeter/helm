<script setup lang="ts">
/** Shared, grouped desktop actions for a session row or terminal surface. */
import { computed, nextTick, ref, watch } from 'vue';
import { SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { toDirection } from '../../utils.js';
import { jumpKeyLabel, jumpButtonToPosition } from '../../utils/jump-keys.js';
import { buildContextMenuGroups, type ContextMenuContext, type ContextMenuItem } from '../../modals/context-menu-items.js';
import type { ContextMenuAction } from '../../../src/types/context-menu.js';

const MODAL_ID = 'context-menu';

const props = defineProps<{
  visible: boolean;
  hasSelection: boolean;
  targetSessionId: string | null;
  selectedText?: string;
  isSnappedOut: boolean;
  currentGroupName?: string | null;
  mode?: ContextMenuContext['mode'];
  sessionFlags?: ContextMenuContext['session'];
  position?: { x: number; y: number } | null;
}>();

const emit = defineEmits<{
  (e: 'action', action: ContextMenuAction): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const selectedIndex = ref(0);
const activeGroup = ref<string | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuPosition = ref<Record<string, string>>({ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' });
const modalStack = useModalStack();

const context = computed<ContextMenuContext>(() => ({
  mode: props.mode ?? 'terminal',
  targetSessionId: props.targetSessionId,
  hasSelection: props.hasSelection,
  isSnappedOut: props.isSnappedOut,
  currentGroupName: props.currentGroupName ?? null,
  session: props.sessionFlags ?? { locked: false, frozen: false, keepWarm: false, hiddenFromOverview: false },
}));
const groups = computed(() => buildContextMenuGroups(context.value));
const menuItems = computed<ContextMenuItem[]>(() => {
  if (activeGroup.value) {
    const group = groups.value.find(item => item.title === activeGroup.value);
    return [...(group?.items ?? []), { id: 'back', label: '‹ Back', enabled: true }];
  }
  return [
    ...groups.value.map(group => ({ id: `group:${group.title}`, label: `› ${group.title}`, enabled: true })),
    { id: 'cancel', label: '✖ Cancel', enabled: true },
  ];
});

const enabledIndices = computed(() =>
  menuItems.value.map((item, i) => item.enabled ? i : -1).filter(i => i >= 0),
);

const jumpLabels = computed(() => {
  const labels = new Map<number, number>();
  enabledIndices.value.forEach((menuIdx, pos) => {
    const label = jumpKeyLabel(pos);
    if (label !== null) labels.set(menuIdx, label);
  });
  return labels;
});

watch(() => [props.visible, props.mode, props.targetSessionId] as const, async ([visible]) => {
  activeGroup.value = null;
  if (!visible) {
    modalStack.pop(MODAL_ID);
    return;
  }
  selectedIndex.value = 0;
  modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: SELECTION_KEYS });
  await nextTick();
  positionMenu();
}, { immediate: true });

function positionMenu(): void {
  if (!props.position || !menuRef.value) {
    menuPosition.value = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
    return;
  }
  const rect = menuRef.value.getBoundingClientRect();
  const margin = 8;
  let left = props.position.x;
  let top = props.position.y;
  if (left + rect.width > window.innerWidth - margin) left -= rect.width;
  if (top + rect.height > window.innerHeight - margin) top -= rect.height;
  left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin));
  menuPosition.value = { left: `${left}px`, top: `${top}px`, transform: 'none' };
}

function findNextEnabled(fromIndex: number, direction: 1 | -1): number {
  const indices = enabledIndices.value;
  if (indices.length === 0) return fromIndex;
  const currentPos = indices.indexOf(fromIndex);
  if (currentPos < 0) return indices[0];
  return indices[(currentPos + direction + indices.length) % indices.length];
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
    if (activeGroup.value) {
      activeGroup.value = null;
      selectedIndex.value = 0;
    } else {
      dismiss();
    }
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
  if (item.id.startsWith('group:')) {
    activeGroup.value = item.id.slice('group:'.length);
    selectedIndex.value = enabledIndices.value[0] ?? 0;
    return;
  }
  if (item.id === 'back') {
    activeGroup.value = null;
    selectedIndex.value = enabledIndices.value[0] ?? 0;
    return;
  }
  if (item.id === 'cancel') {
    dismiss();
    return;
  }
  emit('action', {
    id: item.id,
    targetSessionId: context.value.targetSessionId,
    selectedText: props.selectedText ?? '',
  });
  emit('update:visible', false);
}

function dismiss(): void {
  emit('cancel');
  emit('update:visible', false);
}

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="modal-overlay modal--visible context-menu-overlay"
      @click.self="dismiss"
    >
      <div
        ref="menuRef"
        class="context-menu"
        :style="menuPosition"
        role="menu"
        :aria-label="`${mode === 'session' ? 'Session' : 'Terminal'} actions${activeGroup ? `: ${activeGroup}` : ''}`"
      >
        <div v-if="activeGroup" class="context-menu-header">{{ activeGroup }}</div>
        <button
          v-for="(item, i) in menuItems"
          :key="item.id"
          type="button"
          role="menuitem"
          class="context-menu-item"
          :class="{
            'context-menu-item--selected': i === selectedIndex,
            'context-menu-item--disabled': !item.enabled,
            'context-menu-item--cancel': item.id === 'cancel' || item.id === 'back',
          }"
          :data-action="item.id"
          :aria-disabled="!item.enabled"
          :aria-haspopup="item.id.startsWith('group:') ? 'menu' : undefined"
          :aria-expanded="item.id === `group:${activeGroup}` ? 'true' : undefined"
          :tabindex="i === selectedIndex ? 0 : -1"
          :disabled="!item.enabled"
          @click="executeItem(i)"
        >
          <span v-if="jumpLabels.has(i)" class="jump-key">{{ jumpLabels.get(i) }}</span>
          {{ item.label }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
