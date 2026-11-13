<script setup lang="ts">
/**
 * View menu — the recovery path for closed panes.
 *
 * Open and closed panes are listed separately rather than as one checklist:
 * a closed pane is the only thing here the user is usually hunting for, and a
 * mixed list of ticked and unticked rows does not say "these are recoverable".
 */
import { computed } from 'vue';
import type { PaneId } from '../../dock-types.js';

export interface DockViewMenuItem {
  id: PaneId;
  title: string;
  icon?: string;
  closed: boolean;
}

const props = withDefaults(defineProps<{
  open: boolean;
  items: readonly DockViewMenuItem[];
  /** Trigger text; the main window uses it as the app menu (☰) with app actions slotted in. */
  label?: string;
}>(), { label: 'View' });

const slots = defineSlots<{ default?: () => unknown }>();

const emit = defineEmits<{
  open: [];
  toggle: [paneId: PaneId];
  reset: [];
  close: [];
}>();

const openItems = computed(() => props.items.filter(item => !item.closed));
const closedItems = computed(() => props.items.filter(item => item.closed));
</script>

<template>
  <div class="dock-view-menu">
    <button
      class="sidebar-btn dock-view-menu__trigger"
      type="button"
      :title="slots.default ? 'Menu' : 'Show or hide workspace panes'"
      aria-haspopup="menu"
      :aria-expanded="open"
      @keydown.esc="emit('close')"
      @click="emit(open ? 'close' : 'open')"
    >
      {{ label }}
      <span v-if="closedItems.length > 0" class="dock-view-menu__badge">{{ closedItems.length }}</span>
    </button>

    <div v-if="open" class="dock-view-menu__popover" role="menu" @keydown.esc="emit('close')">
      <div class="dock-view-menu__heading">Open panes</div>
      <button
        v-for="item in openItems"
        :key="item.id"
        class="dock-view-menu__item"
        type="button"
        role="menuitemcheckbox"
        aria-checked="true"
        @click="emit('toggle', item.id)"
      >
        <span class="dock-view-menu__icon" aria-hidden="true">{{ item.icon }}</span>
        <span class="dock-view-menu__label">{{ item.title }}</span>
        <span class="dock-view-menu__action" aria-hidden="true">Close</span>
      </button>

      <template v-if="closedItems.length > 0">
        <div class="dock-view-menu__heading">Closed panes</div>
        <button
          v-for="item in closedItems"
          :key="item.id"
          class="dock-view-menu__item dock-view-menu__item--closed"
          type="button"
          role="menuitemcheckbox"
          aria-checked="false"
          @click="emit('toggle', item.id)"
        >
          <span class="dock-view-menu__icon" aria-hidden="true">{{ item.icon }}</span>
          <span class="dock-view-menu__label">{{ item.title }}</span>
          <span class="dock-view-menu__action" aria-hidden="true">Reopen</span>
        </button>
      </template>

      <div class="dock-view-menu__separator" role="separator"></div>
      <button class="dock-view-menu__item dock-view-menu__reset" type="button" role="menuitem" @click="emit('reset')">
        Reset Layout
      </button>
      <template v-if="slots.default">
        <div class="dock-view-menu__separator" role="separator"></div>
        <slot />
      </template>
    </div>
  </div>
</template>
