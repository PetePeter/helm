<script setup lang="ts">
import { computed, nextTick, ref, watch, type Component } from 'vue';
import { PANE_CHAT, type PaneId } from '../../dock-types.js';

const props = defineProps<{
  paneId: PaneId;
  active: boolean;
  focused: boolean;
  focusRequestId?: number;
  component: Component | undefined;
}>();

const emit = defineEmits<{
  focus: [paneId: PaneId, focusedItemId?: string];
}>();

const paneRef = ref<HTMLElement | null>(null);
const componentProps = computed(() => ({
  paneId: props.paneId,
  ...(props.paneId === PANE_CHAT ? { paneActive: props.active } : {}),
}));

function focusedItemId(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const item = target.closest<HTMLElement>('[data-focus-id], .focusable, button, input, select, textarea, [contenteditable]');
  if (!item || !paneRef.value?.contains(item)) return undefined;
  return item.dataset.focusId
    ?? item.id
    ?? item.getAttribute('name')
    ?? item.getAttribute('aria-label')
    ?? (item.dataset.navIndex ? `nav:${item.dataset.navIndex}` : undefined);
}

function onFocusIn(event: FocusEvent): void {
  emit('focus', props.paneId, focusedItemId(event.target));
}

// A pane jump (shortcut, focus cycle) moves the dock's focus, not the caret.
// Panes whose point is typing mark their field `data-autofocus` to take it.
watch(() => [props.focused, props.focusRequestId] as const, async ([focused]) => {
  if (!focused) return;
  await nextTick();
  if (paneRef.value?.contains(document.activeElement)) return;
  paneRef.value?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
}, { immediate: true });
</script>

<template>
  <section
    :id="`dock-pane-${paneId}`"
    ref="paneRef"
    class="dock-pane"
    :class="{ 'dock-pane--active': active, 'dock-pane--focused': focused }"
    :data-dock-pane-id="paneId"
    :data-focus-id="paneId"
    :data-pane-content="paneId"
    :aria-label="`${paneId} pane`"
    :aria-hidden="!active"
    tabindex="-1"
    v-show="active"
    @focusin="onFocusIn"
  >
    <component :is="component" v-if="component" v-bind="componentProps" />
    <div v-else class="dock-pane__missing">Pane unavailable: {{ paneId }}</div>
  </section>
</template>

<style scoped>
.dock-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex: 1;
  overflow: hidden;
  position: relative;
  flex-direction: column;
  background: var(--bg-primary);
}
.dock-pane[aria-hidden="true"] { pointer-events: none; }
.dock-pane--focused { box-shadow: inset 0 0 0 1px var(--focus); }
.dock-pane__missing { padding: var(--spacing-md); color: var(--text-secondary); }
</style>
