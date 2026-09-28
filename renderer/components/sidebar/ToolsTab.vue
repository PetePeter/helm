<script setup lang="ts">
/**
 * ToolsTab.vue — CLI type management (list, add, edit, delete) plus the
 * Session List display settings.
 */
import SessionListSettings from './SessionListSettings.vue';

export interface ToolItem {
  key: string;
  name: string;
  command: string;
  hasInitialPrompt: boolean;
  initialPromptCount: number;
}

const props = defineProps<{
  tools: ToolItem[];
}>();

const emit = defineEmits<{
  add: [];
  edit: [key: string];
  clone: [key: string];
  delete: [key: string];
  move: [key: string, direction: 'up' | 'down'];
}>();
</script>

<template>
  <div class="settings-tools-panel">
    <div class="settings-list">
      <div
        v-for="(tool, index) in tools"
        :key="tool.key"
        class="settings-list-item"
      >
        <div class="tool-info">
          <span class="tool-name">{{ tool.name }}</span>
          <span class="tool-command">{{ tool.command }}</span>
          <span v-if="tool.hasInitialPrompt" class="tool-prompt-badge">
            📋 {{ tool.initialPromptCount }} prompt{{ tool.initialPromptCount !== 1 ? 's' : '' }}
          </span>
        </div>
        <div class="tool-actions">
          <button
            class="focusable"
            :disabled="index === 0"
            title="Move up"
            @click="emit('move', tool.key, 'up')"
          >&#9650;</button>
          <button
            class="focusable"
            :disabled="index === tools.length - 1"
            title="Move down"
            @click="emit('move', tool.key, 'down')"
          >&#9660;</button>
          <button class="focusable" @click="emit('clone', tool.key)">Clone</button>
          <button class="focusable" @click="emit('edit', tool.key)">Edit</button>
          <button class="focusable danger" @click="emit('delete', tool.key)">Delete</button>
        </div>
      </div>
    </div>

    <div v-if="tools.length === 0" class="tools-empty">
      No CLI types configured.
    </div>

    <div class="settings-tool-actions">
      <button class="focusable" @click="emit('add')">
        + Add CLI Type
      </button>
    </div>

    <SessionListSettings />
  </div>
</template>
