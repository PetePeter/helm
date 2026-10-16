<script setup lang="ts">
/**
 * RuntimeGroupMoveSubmenu — the "🗂️ Move to group" picker opened from the session
 * context menu. Lists existing runtime groups (✓ marks the current one) plus a
 * "＋ New group…" entry. A single-level menu + gamepad model
 * (D-pad up/down cycles, A picks, B cancels, number/letter jump keys).
 */
import { ref, watch, computed } from 'vue';
import { SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { toDirection } from '../../utils.js';
import { jumpKeyLabel, jumpButtonToPosition } from '../../utils/jump-keys.js';

const MODAL_ID = 'runtime-group-move';

const props = defineProps<{
  visible: boolean;
  currentGroupId: string;
  groups: Array<{ id: string; name: string }>;
}>();

const emit = defineEmits<{
  (e: 'pick', groupId: string): void;
  (e: 'new-group'): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const selectedIndex = ref(0);
const modalStack = useModalStack();

// Items: [...groups, "New group…"] — the extra +1 is the trailing new-group entry.
const itemCount = computed(() => props.groups.length + 1);
const newGroupIndex = computed(() => props.groups.length);

watch(() => props.visible, (v) => {
  if (v) {
    selectedIndex.value = 0;
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: SELECTION_KEYS });
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

function handleButton(button: string): boolean {
  const dir = toDirection(button);
  if (dir === 'up') {
    selectedIndex.value = (selectedIndex.value - 1 + itemCount.value) % itemCount.value;
    return true;
  }
  if (dir === 'down') {
    selectedIndex.value = (selectedIndex.value + 1) % itemCount.value;
    return true;
  }
  if (button === 'A') {
    activate(selectedIndex.value);
    return true;
  }
  if (button === 'B') {
    emit('cancel');
    emit('update:visible', false);
    return true;
  }
  const pos = jumpButtonToPosition(button);
  if (pos !== null && pos < itemCount.value) {
    activate(pos);
    return true;
  }
  return true;
}

function activate(index: number): void {
  if (index === newGroupIndex.value) {
    emit('new-group');
  } else {
    const group = props.groups[index];
    if (group) emit('pick', group.id);
  }
  emit('update:visible', false);
}

function onItemClick(index: number): void {
  selectedIndex.value = index;
  activate(index);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="modal-overlay modal--visible"
      role="menu"
      aria-label="Move to group submenu"
    >
      <div class="context-menu">
        <div class="context-menu-header">Move to group</div>
        <div
          v-for="(group, i) in groups"
          :key="group.id"
          class="context-menu-item"
          :class="{ 'context-menu-item--selected': selectedIndex === i }"
          @click="onItemClick(i)"
        >
          <span v-if="jumpKeyLabel(i) != null" class="jump-key">{{ jumpKeyLabel(i) }}</span>
          {{ group.id === currentGroupId ? '✓ ' : '' }}🗂️ {{ group.name }}
        </div>
        <div v-if="groups.length === 0" class="context-menu-item context-menu-item--disabled">
          No groups yet
        </div>
        <div class="context-menu-separator"></div>
        <div
          class="context-menu-item"
          :class="{ 'context-menu-item--selected': selectedIndex === newGroupIndex }"
          @click="onItemClick(newGroupIndex)"
        >
          <span v-if="jumpKeyLabel(newGroupIndex) != null" class="jump-key">{{ jumpKeyLabel(newGroupIndex) }}</span>
          ＋ New group…
        </div>
      </div>
    </div>
  </Teleport>
</template>
