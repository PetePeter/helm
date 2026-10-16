<script setup lang="ts">
import { appClient, attachmentsClient, configClient, contextsClient, deliveryClient, dialogClient, eventsClient, incomingClient, keyboardClient, patternsClient, plansClient, projectsClient, schedulerClient, sessionsClient, systemClient, telegramClient, terminalClient, toolsClient } from '../../ipc/clients.js';
/**
 * ProjectsTab.vue — Project list CRUD with expandable directory management.
 *
 * Reads from the project IPC bridge (projectList/Update/Delete/AddDir/RemoveDir/SetMainDir).
 * Projects can be created explicitly and are also auto-created when directories
 * are opened; this tab lets users rename, reorganise directories, and delete projects.
 */
import { ref, onMounted } from 'vue';
import { useAppStore } from '../../stores/app.js';

interface ProjectRecord {
  id: string;
  name: string;
  canonicalPath: string;
  alternatePaths: string[];
  createdAt: number;
  updatedAt: number;
}

const projects = ref<ProjectRecord[]>([]);
const appStore = useAppStore();
const expandedIds = ref<Set<string>>(new Set());
const editingId = ref<string | null>(null);
const editingName = ref('');
const deleteConfirmId = ref<string | null>(null);
const errorMessage = ref('');

const emit = defineEmits<{
  changed: [];
}>();

async function refresh(): Promise<void> {
  try {
    projects.value = await projectsClient.projectList();
    appStore.setProjects(projects.value.map(project => ({
      id: project.id,
      name: project.name,
      canonicalPath: project.canonicalPath,
      alternatePaths: project.alternatePaths || [],
    })));
    emit('changed');
  } catch {
    projects.value = [];
    appStore.setProjects([]);
  }
}

onMounted(() => { void refresh(); });

function toggleExpand(id: string): void {
  if (expandedIds.value.has(id)) {
    expandedIds.value.delete(id);
  } else {
    expandedIds.value.add(id);
  }
}

function isExpanded(id: string): boolean {
  return expandedIds.value.has(id);
}

// ── Inline rename ──────────────────────────────────────────────────────────

function startEditing(project: ProjectRecord): void {
  editingId.value = project.id;
  editingName.value = project.name;
}

async function commitEdit(): Promise<void> {
  const id = editingId.value;
  const name = editingName.value.trim();
  editingId.value = null;
  if (!id || !name) return;

  try {
    const result = await projectsClient.projectUpdate(id, { name });
    if (result?.success === false) errorMessage.value = result.error || 'Project rename failed';
  } catch (error) { errorMessage.value = String(error); }
  await refresh();
}

function cancelEdit(): void {
  editingId.value = null;
}

// ── Delete (3-second hold-to-confirm) ──────────────────────────────────────

let deleteTimer: ReturnType<typeof setTimeout> | null = null;

function onDeleteClick(id: string): void {
  if (deleteConfirmId.value === id) {
    // Confirmed — delete
    deleteConfirmId.value = null;
    if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null; }
    void doDelete(id);
  } else {
    // First click — start 3s confirmation window
    deleteConfirmId.value = id;
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      if (deleteConfirmId.value === id) {
        deleteConfirmId.value = null;
      }
      deleteTimer = null;
    }, 3000);
  }
}

async function doDelete(id: string): Promise<void> {
  try {
    const result = await projectsClient.projectDelete(id);
    if (result?.success === false) errorMessage.value = result.error || 'Project delete failed';
  } catch (error) { errorMessage.value = String(error); }
  await refresh();
}

// ── Directory management ───────────────────────────────────────────────────

async function onAddProject(): Promise<void> {
  try {
    errorMessage.value = '';
    const dirPath = await dialogClient.dialogOpenFolder();
    if (!dirPath) return;
    const result = await projectsClient.projectCreate(dirPath);
    if (result?.success === false) {
      errorMessage.value = result.error || 'Project creation failed';
    }
  } catch (error) {
    errorMessage.value = String(error);
  }
  await refresh();
}

async function onAddDir(projectId: string): Promise<void> {
  try {
    errorMessage.value = '';
    const dirPath = await dialogClient.dialogOpenFolder();
    if (!dirPath) return;
    const result = await projectsClient.projectAddDir(projectId, dirPath);
    if (result?.success === false) errorMessage.value = result.error || 'Directory add failed';
  } catch (error) { errorMessage.value = String(error); }
  await refresh();
}

async function onRemoveDir(projectId: string, dirPath: string): Promise<void> {
  try {
    errorMessage.value = '';
    const result = await projectsClient.projectRemoveDir(projectId, dirPath);
    if (result?.success === false) errorMessage.value = result.error || 'Directory remove failed';
  } catch (error) { errorMessage.value = String(error); }
  await refresh();
}

async function onSetMainDir(projectId: string, dirPath: string): Promise<void> {
  try {
    errorMessage.value = '';
    const result = await projectsClient.projectSetMainDir(projectId, dirPath);
    if (result?.success === false) errorMessage.value = result.error || 'Set main directory failed';
  } catch (error) { errorMessage.value = String(error); }
  await refresh();
}
</script>

<template>
  <div class="settings-projects-panel">
    <div class="settings-panel__header">
      <span class="settings-panel__title">Projects</span>
      <button
        class="btn btn--secondary btn--sm focusable"
        title="Add project"
        @click="onAddProject"
      >+ Add Project</button>
    </div>

    <p v-if="errorMessage" class="settings-project-error">{{ errorMessage }}</p>

    <div class="settings-list">
      <div
        v-for="project in projects"
        :key="project.id"
        class="settings-project-item"
      >
        <!-- Header row -->
        <div class="settings-project-header">
          <button
            class="settings-project-toggle focusable"
            :class="{ 'settings-project-toggle--expanded': isExpanded(project.id) }"
            @click="toggleExpand(project.id)"
            title="Expand / Collapse"
          >{{ isExpanded(project.id) ? '▼' : '▶' }}</button>

          <span
            v-if="editingId === project.id"
            class="settings-project-name-edit"
          >
            <input
              v-model="editingName"
              class="focusable"
              type="text"
              @keydown.enter="commitEdit()"
              @keydown.escape="cancelEdit()"
              @blur="commitEdit()"
            />
          </span>
          <span
            v-else
            class="settings-project-name focusable"
            title="Double-click to rename"
            @dblclick="startEditing(project)"
          >{{ project.name }}</span>

          <button
            v-if="editingId !== project.id"
            class="btn btn--secondary btn--sm focusable"
            title="Rename project"
            @click="startEditing(project)"
          >Rename</button>

          <button
            class="btn btn--danger btn--sm focusable"
            title="Deletes this project and all Helm plans owned by it"
            @click="onDeleteClick(project.id)"
          >
            {{ deleteConfirmId === project.id ? 'Confirm?' : 'Delete' }}
          </button>
        </div>

        <!-- Expanded directory list -->
        <div v-if="isExpanded(project.id)" class="settings-project-dirs">
          <div class="settings-project-dir settings-project-dir--canonical">
            <span class="settings-project-dir__label">canonical</span>
            <span class="settings-project-dir__path">{{ project.canonicalPath }}</span>
          </div>
          <div
            v-for="altPath in project.alternatePaths"
            :key="altPath"
            class="settings-project-dir"
          >
            <span class="settings-project-dir__path">{{ altPath }}</span>
            <button
              class="btn btn--secondary btn--sm focusable"
              title="Set as main directory"
              @click="onSetMainDir(project.id, altPath)"
            >Set as Main</button>
            <button
              class="btn btn--ghost btn--sm focusable"
              title="Remove directory"
              @click="onRemoveDir(project.id, altPath)"
            >×</button>
          </div>
          <button
            class="btn btn--secondary btn--sm focusable settings-project-add-dir"
            @click="onAddDir(project.id)"
          >+ Add Directory</button>
        </div>
      </div>

      <p v-if="projects.length === 0" class="settings-empty">
        No projects yet.
      </p>
    </div>
  </div>
</template>

<style scoped>
.settings-projects-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.settings-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.settings-panel__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── Project item ─────────────────────────────────────────────────────────── */

.settings-project-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.settings-project-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary, #1a1a2e);
}

.settings-project-toggle {
  background: none;
  border: none;
  color: var(--text-secondary, #888);
  cursor: pointer;
  font-size: 10px;
  padding: 2px 4px;
  line-height: 1;
  transition: transform 0.15s ease;
}
.settings-project-toggle--expanded {
  color: var(--text-primary, #eee);
}

.settings-project-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary, #eee);
  cursor: default;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-project-name-edit {
  flex: 1;
}
.settings-project-name-edit input {
  width: 100%;
  padding: 2px 6px;
  font-size: 13px;
  background: var(--bg-primary, #111);
  color: var(--text-primary, #eee);
  border: 1px solid var(--accent);
  border-radius: 3px;
  outline: none;
}

.settings-project-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg-tertiary, #2a2a3e);
  color: var(--text-secondary, #888);
  text-transform: uppercase;
}

/* ── Expanded directory list ─────────────────────────────────────────────── */

.settings-project-dirs {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 8px 12px 8px 32px;
  background: var(--bg-primary, #111);
  border-top: 1px solid var(--border);
}

.settings-project-dir {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}
.settings-project-dir:last-of-type {
  border-bottom: none;
}

.settings-project-dir--canonical .settings-project-dir__path {
  font-weight: 600;
}

.settings-project-dir__label {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--accent);
  color: #fff;
  text-transform: uppercase;
  flex-shrink: 0;
}

.settings-project-dir__path {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary, #aaa);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-project-add-dir {
  margin-top: 8px;
  align-self: flex-start;
}

/* ── Empty state ──────────────────────────────────────────────────────────── */

.settings-empty {
  color: var(--text-secondary, #888);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}

.settings-project-error {
  color: var(--danger);
  font-size: 12px;
  margin: 0;
}
</style>
