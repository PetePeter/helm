<script setup lang="ts">
/**
 * Quick spawn CLI type picker modal.
 *
 * Shows a list of available CLI types. Gamepad D-pad up/down navigates
 * (clamped, not wrapping), A selects, B cancels.
 * Keyboard routed via App.vue bridge → useModalStack → handleButton.
 */
import { computed, ref, watch, nextTick } from 'vue';
import { SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { useModalAutofocus } from '../../composables/useModalAutofocus.js';
import { toDirection, getCliDisplayName } from '../../utils.js';
import { jumpKeyLabel, jumpButtonToPosition } from '../../utils/jump-keys.js';
import QuickSpawnMachineTabs from '../common/QuickSpawnMachineTabs.vue';
import { useQuickSpawnStore } from '../../stores/quick-spawn.js';

const MODAL_ID = 'quick-spawn';

const props = defineProps<{
  visible: boolean;
  cliTypes: string[];
  preselectedCliType?: string;
  machineAware?: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', cliType: string, machineId?: string): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const selectedIndex = ref(0);
const quickSpawn = useQuickSpawnStore();
const availableTools = computed(() => props.machineAware
  ? quickSpawn.tools
  : props.cliTypes.map(cliType => ({ cliType, displayName: getCliDisplayName(cliType), machineId: '' })));
const modalStack = useModalStack();
const overlayRef = ref<HTMLElement | null>(null);
const { focusIntoModal } = useModalAutofocus(overlayRef, '.dir-picker-item--focused');

async function focusCurrentItem(): Promise<void> {
  await nextTick();
  const target = overlayRef.value?.querySelector<HTMLElement>(`#quick-spawn-option-${selectedIndex.value}`);
  target?.focus();
}

watch(() => props.visible, (v) => {
  if (v) {
    // Pre-select matching CLI type if given
    const preIdx = props.preselectedCliType
      ? availableTools.value.findIndex(tool => tool.cliType === props.preselectedCliType)
      : -1;
    selectedIndex.value = preIdx >= 0 ? preIdx : 0;
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: SELECTION_KEYS });
    void focusIntoModal();
    void focusCurrentItem();
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

watch(() => [props.machineAware, quickSpawn.machineId, availableTools.value], () => {
  if (!props.visible) return;
  const preIdx = props.preselectedCliType
    ? availableTools.value.findIndex(tool => tool.cliType === props.preselectedCliType)
    : -1;
  selectedIndex.value = preIdx >= 0 ? preIdx : 0;
  void focusCurrentItem();
});

function handleButton(button: string): boolean {
  const dir = toDirection(button);
  if (props.machineAware && (dir === 'left' || button === 'LeftBumper')) {
    quickSpawn.cycleMachine(-1);
    return true;
  }
  if (props.machineAware && (dir === 'right' || button === 'RightBumper')) {
    quickSpawn.cycleMachine(1);
    return true;
  }
  if (dir === 'up' || button === 'ShiftTab') {
    selectedIndex.value = Math.max(0, selectedIndex.value - 1);
    void focusCurrentItem();
    return true;
  }
  if (dir === 'down' || button === 'Tab') {
    selectedIndex.value = Math.min(availableTools.value.length - 1, selectedIndex.value + 1);
    void focusCurrentItem();
    return true;
  }
  if (button === 'A') {
    selectItem(selectedIndex.value);
    return true;
  }
  if (button === 'B') {
    emit('cancel');
    emit('update:visible', false);
    return true;
  }
  const pos = jumpButtonToPosition(button);
  if (pos !== null && pos < availableTools.value.length) {
    selectItem(pos);
    return true;
  }
  return true;
}

function selectItem(index: number): void {
  const tool = availableTools.value[index];
  if (tool) {
    if (props.machineAware) emit('select', tool.cliType, tool.machineId);
    else emit('select', tool.cliType);
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
      class="modal-overlay modal--visible quick-spawn-overlay"
      role="dialog"
      aria-label="Quick spawn tool picker"
      tabindex="-1"
    >
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">Select CLI type</div>
        </div>
        <QuickSpawnMachineTabs
          :machines="quickSpawn.machines"
          :active-machine-id="quickSpawn.machineId"
          :visible="Boolean(machineAware && quickSpawn.hasRemoteTargets)"
          :loading="Boolean(machineAware && quickSpawn.loading)"
          :error="machineAware ? quickSpawn.error : ''"
          @select="quickSpawn.selectMachine"
        />
        <div
          v-if="!machineAware || (!quickSpawn.loading && !quickSpawn.error)"
          class="dir-picker-list"
          id="quickSpawnList"
          role="listbox"
          aria-label="CLI types"
          :aria-activedescendant="availableTools[selectedIndex] ? `quick-spawn-option-${selectedIndex}` : undefined"
        >
          <div
            v-for="(tool, i) in availableTools"
            :id="`quick-spawn-option-${i}`"
            :key="`${tool.machineId}:${tool.cliType}`"
            class="dir-picker-item focusable"
            :class="{ 'dir-picker-item--focused': i === selectedIndex }"
            tabindex="-1"
            role="option"
            :aria-selected="i === selectedIndex"
            @keydown="suppressActivationKey"
            @click="selectItem(i)"
          >
            <span v-if="jumpKeyLabel(i) != null" class="jump-key">{{ jumpKeyLabel(i) }}</span>
            <span class="dir-picker-item__body">
              <span class="dir-picker-item__name">{{ tool.displayName }}</span>
              
            </span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" tabindex="-1" @keydown="suppressActivationKey" @click="emit('cancel'); emit('update:visible', false)">Cancel</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.quick-spawn-overlay .dir-picker-list {
  max-height: min(60vh, 420px);
}
.quick-spawn-overlay .dir-picker-item {
  min-height: 44px;
}
</style>
