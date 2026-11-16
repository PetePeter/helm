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

/** An app-level action listed after the layout items (the main window's ☰ menu). */
export interface DockViewMenuAction {
  icon: string;
  label: string;
  run: () => void;
}

const props = withDefaults(defineProps<{
  open: boolean;
  items: readonly DockViewMenuItem[];
  /** Trigger text; the main window uses it as the app menu (☰) with app actions. */
  label?: string;
  actions?: readonly DockViewMenuAction[];
}>(), { label: 'View', actions: () => [] });

const emit = defineEmits<{
  open: [];
  toggle: [paneId: PaneId];
  reset: [];
  close: [];
}>();

function runAction(action: DockViewMenuAction): void {
  emit('close');
  action.run();
}

const openItems = computed(() => props.items.filter(item => !item.closed));
const closedItems = computed(() => props.items.filter(item => item.closed));
</script>

<template>
  <div class="dock-view-menu">
    <button
      class="sidebar-btn dock-view-menu__trigger"
      type="button"
      :title="actions.length ? 'Menu' : 'Show or hide workspace panes'"
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
      <template v-if="actions.length > 0">
        <div class="dock-view-menu__separator" role="separator"></div>
        <button
          v-for="action in actions"
          :key="action.label"
          class="dock-view-menu__item"
          type="button"
          role="menuitem"
          @click="runAction(action)"
        >
          <span class="dock-view-menu__icon" aria-hidden="true">{{ action.icon }}</span>
          <span class="dock-view-menu__label">{{ action.label }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Compact recovery menu for the registered dock panes. */
.dock-view-menu { position: relative; }
.dock-view-menu__trigger {
  font-size: 11px;
  font-weight: 600;
}
.dock-view-menu__popover {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  right: 0;
  width: 190px;
  padding: 5px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
}
.dock-view-menu__heading {
  padding: 5px 7px;
  color: var(--text-secondary);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.dock-view-menu__item {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 7px;
  padding: 6px 7px;
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  text-align: left;
  font-size: 12px;
}
.dock-view-menu__item:hover { background: var(--bg-tertiary); }
.dock-view-menu__icon { width: 16px; text-align: center; font-size: 13px; line-height: 1; }
.dock-view-menu__label { flex: 1; min-width: 0; }
/* Show the action only for the row being pointed at. */
.dock-view-menu__action { font-size: 10px; color: var(--text-dim); opacity: 0; }
.dock-view-menu__item:hover .dock-view-menu__action,
.dock-view-menu__item:focus-visible .dock-view-menu__action { opacity: 1; }
.dock-view-menu__item--closed .dock-view-menu__label,
.dock-view-menu__item--closed .dock-view-menu__icon { color: var(--text-dim); }
.dock-view-menu__badge {
  margin-left: 5px;
  padding: 0 5px;
  font-size: 10px;
  color: var(--accent-contrast);
  background: var(--accent);
  border-radius: 999px;
}
.dock-view-menu__separator {
  height: 1px;
  margin: 5px 0;
  background: var(--border);
}
.dock-view-menu__reset { color: var(--accent); }
/* The root lives in the app header's draggable shell. */
:global(.app-header) .dock-view-menu { -webkit-app-region: no-drag; }
</style>
