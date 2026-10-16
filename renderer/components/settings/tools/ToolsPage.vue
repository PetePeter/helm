<script setup lang="ts">
/**
 * ToolsPage.vue — Settings → Tools: CLI types on the left, the selected one
 * edited in place on the right. Add and Clone write the new type at once and
 * select it; every edit autosaves through `save`.
 */
import { computed, ref, watch } from 'vue';
import MasterDetail from '../primitives/MasterDetail.vue';
import ToolEditor, { type ToolEditorValues } from './ToolEditor.vue';
import type { ToolEditorBridgeData } from '../../../stores/modal-bridge.js';

export interface ToolItem {
  key: string;
  name: string;
  command: string;
  hasInitialPrompt: boolean;
  initialPromptCount: number;
}

const props = defineProps<{
  tools: ToolItem[];
  bindingProfiles: Array<{ id: string; name: string }>;
  validateName: (name: string, excludeKey?: string) => string | null;
  load: (key: string) => Promise<ToolEditorBridgeData | null>;
  save: (key: string, values: ToolEditorValues) => Promise<boolean>;
  add: () => Promise<string | null>;
  clone: (key: string) => Promise<string | null>;
  remove: (key: string) => Promise<void>;
  move: (key: string, direction: 'up' | 'down') => Promise<void>;
}>();

const selectedKey = ref<string | null>(null);
/** Clear the prior form before loading so it cannot outlive its selection. */
const editing = ref<{ key: string; data: ToolEditorBridgeData } | null>(null);
const loadFailed = ref(false);
const confirmingDelete = ref(false);

const items = computed(() => props.tools.map((tool) => ({
  id: tool.key,
  name: tool.name,
  detail: tool.command,
  tag: tool.initialPromptCount ? `${tool.initialPromptCount} prompt${tool.initialPromptCount === 1 ? '' : 's'}` : undefined,
})));
const selectedIndex = computed(() => props.tools.findIndex((tool) => tool.key === selectedKey.value));
const selectedName = computed(() => props.tools[selectedIndex.value]?.name ?? '');
const validateSelectedName = (name: string) => props.validateName(name, editing.value?.key);

// Keep a valid selection as the list changes (first load, delete).
watch(() => props.tools, (tools) => {
  if (!tools.some((tool) => tool.key === selectedKey.value)) selectedKey.value = tools[0]?.key ?? null;
}, { immediate: true });

watch(selectedKey, async (key) => {
  confirmingDelete.value = false;
  editing.value = null;
  loadFailed.value = false;
  if (!key) return;
  try {
    const data = await props.load(key);
    if (selectedKey.value !== key) return;
    if (data) editing.value = { key, data };
    else loadFailed.value = true;
  } catch {
    if (selectedKey.value === key) loadFailed.value = true;
  }
}, { immediate: true });

async function onAdd(): Promise<void> {
  const id = await props.add();
  if (id) selectedKey.value = id;
}

async function onClone(): Promise<void> {
  if (!selectedKey.value) return;
  const id = await props.clone(selectedKey.value);
  if (id) selectedKey.value = id;
}

async function onDelete(): Promise<void> {
  if (!selectedKey.value) return;
  if (!confirmingDelete.value) { confirmingDelete.value = true; return; }
  confirmingDelete.value = false;
  await props.remove(selectedKey.value);
}
</script>

<template>
  <MasterDetail v-model="selectedKey" :items="items" list-title="CLI types" empty-text="No CLI types configured.">
    <template #list-actions>
      <button class="btn btn--sm btn--primary focusable" @click="onAdd">+ Add</button>
    </template>
    <template #detail>
      <div class="tools-page__head">
        <h3 class="tools-page__title">{{ selectedName }}</h3>
        <button class="btn btn--sm focusable" :disabled="selectedIndex <= 0" title="Move up" @click="move(selectedKey!, 'up')">Up</button>
        <button class="btn btn--sm focusable" :disabled="selectedIndex >= tools.length - 1" title="Move down" @click="move(selectedKey!, 'down')">Down</button>
        <button class="btn btn--sm focusable" @click="onClone">Clone</button>
        <button class="btn btn--sm btn--danger focusable" @click="onDelete">{{ confirmingDelete ? 'Confirm delete' : 'Delete' }}</button>
      </div>
      <ToolEditor
        v-if="editing"
        :tool-key="editing.key"
        :initial-data="editing.data"
        :binding-profiles="bindingProfiles"
        :validate-name="validateSelectedName"
        :save="save"
      />
      <p v-else-if="loadFailed" role="alert">Unable to load this tool's settings.</p>
    </template>
  </MasterDetail>
</template>

<style scoped>
.tools-page__head {
  display: flex; align-items: center; gap: var(--spacing-sm);
  padding: 14px 22px; border-bottom: 1px solid var(--border);
}
.tools-page__title {
  flex: 1; min-width: 0; margin: 0; font-size: var(--font-size-lg); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
</style>
