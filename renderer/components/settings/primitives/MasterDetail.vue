<script setup lang="ts">
/**
 * MasterDetail.vue — list column + detail pane, the two gamepad panes of a
 * master/detail settings page. Selection is v-model; the page owns the data
 * and renders the detail through the slot.
 */
import SettingsPane from './SettingsPane.vue';

export interface MasterDetailItem {
  id: string;
  name: string;
  detail?: string;
  tag?: string;
}

defineProps<{
  items: ReadonlyArray<MasterDetailItem>;
  modelValue: string | null;
  listTitle: string;
  emptyText?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [id: string] }>();
</script>

<template>
  <div class="master-detail">
    <SettingsPane class="master-detail__list">
      <div class="master-detail__list-head">
        <span>{{ listTitle }}</span>
        <slot name="list-actions" />
      </div>
      <div class="master-detail__rows" role="listbox">
        <button
          v-for="item in items"
          :key="item.id"
          class="master-detail__row focusable"
          :class="{ 'master-detail__row--active': item.id === modelValue }"
          role="option"
          :aria-selected="item.id === modelValue"
          :data-focus-id="item.id"
          @click="emit('update:modelValue', item.id)"
        >
          <slot name="row" :item="item">
            <span class="master-detail__avatar">{{ item.name.slice(0, 2).toUpperCase() }}</span>
            <span class="master-detail__text">
              <span class="master-detail__name">{{ item.name }}</span>
              <span v-if="item.detail" class="master-detail__detail">{{ item.detail }}</span>
            </span>
            <span v-if="item.tag" class="master-detail__tag">{{ item.tag }}</span>
          </slot>
        </button>
        <p v-if="items.length === 0" class="master-detail__empty">{{ emptyText ?? 'Nothing here yet.' }}</p>
      </div>
    </SettingsPane>
    <SettingsPane class="master-detail__detail-pane">
      <slot v-if="modelValue" name="detail" />
      <p v-else class="master-detail__empty">Select an item.</p>
    </SettingsPane>
  </div>
</template>

<style scoped>
.master-detail { display: grid; grid-template-columns: 260px minmax(0, 1fr); flex: 1; min-height: 0; min-width: 0; }
.master-detail__list {
  display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--border); padding: 0 6px;
}
.master-detail__list-head {
  display: flex; justify-content: space-between; align-items: center; gap: var(--spacing-sm);
  padding: 12px 8px 10px; font-size: var(--font-size-sm); color: var(--text-secondary); font-weight: 600;
}
.master-detail__rows { flex: 1; overflow-y: auto; padding-bottom: var(--spacing-sm); }
.master-detail__row {
  display: flex; gap: 10px; align-items: center; width: 100%;
  padding: 8px; margin-bottom: 2px; border: 0; border-radius: var(--radius-md);
  background: transparent; color: var(--text-primary); font: inherit; text-align: left; cursor: pointer;
}
.master-detail__row:hover { background: var(--bg-hover); }
.master-detail__row--active, .master-detail__row--active:hover { background: var(--accent-tint); }
.master-detail__row--active .master-detail__name { color: var(--accent); }
.master-detail__row:focus { outline: none; box-shadow: var(--focus-ring); }
.master-detail__avatar {
  width: 28px; height: 28px; flex: none; display: grid; place-items: center;
  border-radius: var(--radius-md); background: var(--bg-hover);
  font: 600 11px var(--font-mono); color: var(--text-secondary);
}
.master-detail__row--active .master-detail__avatar { background: var(--accent-tint); color: var(--accent); }
.master-detail__text { display: flex; flex-direction: column; min-width: 0; }
.master-detail__name { font-size: var(--font-size-md); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.master-detail__detail {
  font-size: 11px; color: var(--text-dim); font-family: var(--font-mono);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.master-detail__tag {
  margin-left: auto; font-size: var(--font-size-xs); color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: 10px; padding: 1px 7px; white-space: nowrap;
}
.master-detail__detail-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow-y: auto; }
.master-detail__empty { color: var(--text-dim); padding: var(--spacing-md); margin: 0; }
</style>
