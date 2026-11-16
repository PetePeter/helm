<script setup lang="ts">
import AppButton from './common/AppButton.vue';
import type { MemoryRecord } from '../../src/types/memory.js';

defineProps<{
  visible: boolean;
  record: MemoryRecord | null;
  neighbors: Array<{ id: string; label: string; status: string }>;
}>();

const emit = defineEmits<{
  close: [];
  delete: [];
  openAttachment: [id: string];
  deleteAttachment: [id: string];
}>();
</script>

<template>
  <Teleport to="body">
    <div v-if="visible && record" class="memory-detail-overlay" role="dialog" aria-label="Memory details">
      <article class="memory-detail-popout">
        <header class="memory-detail-header">
          <div>
            <span class="memory-kicker">Memory detail</span>
            <h2>{{ record.tldr }}</h2>
          </div>
          <button type="button" class="memory-icon-button" aria-label="Close memory details" @click="emit('close')">×</button>
        </header>
        <div class="memory-detail-meta">
          <span>ID: {{ record.id }}</span>
          <span>Created: {{ new Date(record.createdAt).toLocaleString() }}</span>
          <span>Updated: {{ new Date(record.updatedAt).toLocaleString() }}</span>
        </div>
        <pre class="memory-detail-content">{{ record.content }}</pre>
        <section v-if="neighbors.length > 0" class="memory-detail-section">
          <h3>Neighbors</h3>
          <ul>
            <li v-for="neighbor in neighbors" :key="neighbor.id + neighbor.status">
              {{ neighbor.label }} <span class="memory-status">{{ neighbor.status }}</span>
            </li>
          </ul>
        </section>
        <section v-if="record.attachments.length > 0" class="memory-detail-section">
          <h3>Attachments</h3>
          <ul>
            <li v-for="attachment in record.attachments" :key="attachment.id" class="memory-attachment-row">
              <span>{{ attachment.filename }} ({{ attachment.sizeBytes }} bytes)</span>
              <span>
                <button type="button" class="memory-link-button" @click="emit('openAttachment', attachment.id)">Open</button>
                <button type="button" class="memory-link-button memory-danger-link" @click="emit('deleteAttachment', attachment.id)">Delete</button>
              </span>
            </li>
          </ul>
        </section>
        <footer class="memory-detail-footer">
          <AppButton variant="danger" type="button" @click="emit('delete')">Delete memory</AppButton>
          <AppButton variant="secondary" type="button" @click="emit('close')">Close</AppButton>
        </footer>
      </article>
    </div>
  </Teleport>
</template>

<style scoped>
.memory-detail-overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, .72); }
.memory-detail-popout { width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; padding: 22px; color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--accent); box-shadow: 0 14px 60px rgba(0, 0, 0, .55); }
.memory-detail-header, .memory-detail-footer, .memory-attachment-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.memory-detail-header h2 { margin: 4px 0 0; }
.memory-kicker, .memory-status { color: var(--accent); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.memory-detail-meta { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0; color: var(--text-secondary); font-size: 12px; }
.memory-detail-content { max-height: 280px; overflow: auto; white-space: pre-wrap; font: inherit; line-height: 1.45; color: var(--text-primary); }
.memory-detail-section { margin-top: 18px; }
.memory-detail-section h3 { font-size: 13px; color: var(--text-secondary); }
.memory-detail-section ul { padding-left: 18px; }
.memory-detail-section li { margin: 5px 0; }
.memory-icon-button, .memory-link-button { border: 0; color: var(--accent); background: transparent; cursor: pointer; }
.memory-icon-button { font-size: 24px; }
.memory-link-button { margin-left: 8px; text-decoration: underline; }
.memory-danger-link { color: #ff7777; }
</style>
