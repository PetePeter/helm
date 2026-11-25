<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import AppButton from '../common/AppButton.vue';
import EmptyState from '../common/EmptyState.vue';
import SearchField from '../common/SearchField.vue';
import UserTaskDetail from './UserTaskDetail.vue';
import { useAppStore } from '../../stores/app.js';
import { useUserTasksStore } from '../../stores/user-tasks.js';
import { useToast } from '../../composables/useToast.js';
import type { UserTask } from '../../../src/types/user-task.js';
import {
  GENERAL_LABEL,
  authorLabel,
  groupTasks,
  matchesFilter,
  matchesSearch,
  tintFor,
  type UserTaskFilter,
  type UserTaskGrouping,
} from '../../user-tasks/user-task-board.js';

const appStore = useAppStore();
const store = useUserTasksStore();
const toast = useToast();

const FILTERS: Array<{ id: UserTaskFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'ai', label: 'AI' },
  { id: 'urgent', label: 'Urgent' },
  { id: 'done', label: 'Done' },
];

const filter = ref<UserTaskFilter>('all');
const grouping = ref<UserTaskGrouping>('project');
const query = ref('');
const selectedId = ref<string | null>(null);
const adding = ref(false);
const newTitle = ref('');
const newProject = ref('');
const newUrgent = ref(false);
const boardRef = ref<HTMLElement | null>(null);

const projectName = (id: string) => appStore.state.projects.find(p => p.id === id)?.name;
const visible = computed(() => store.tasks.filter(t => matchesFilter(t, filter.value) && matchesSearch(t, query.value)));
const columns = computed(() => groupTasks(visible.value, grouping.value, projectName));
const selected = computed(() => store.tasks.find(t => t.id === selectedId.value) ?? null);
const selectedTint = computed(() => columns.value.find(c => c.tasks.some(t => t.id === selectedId.value))?.tint ?? tintFor(selected.value?.projectId ?? ''));
const ticked = (task: UserTask) => task.checklist.filter(i => i.doneAt !== undefined).length;

/** Back to the listing: the board stayed mounted, so scroll is kept; focus returns to the note. */
async function closeDetail(): Promise<void> {
  const id = selectedId.value;
  selectedId.value = null;
  await nextTick();
  boardRef.value?.querySelector<HTMLElement>(`.utp__note[data-task-id="${CSS.escape(id ?? '')}"]`)?.focus();
}

async function addTask(): Promise<void> {
  const title = newTitle.value.trim();
  if (!title) return;
  try {
    await store.add({ title, urgent: newUrgent.value, ...(newProject.value ? { projectId: newProject.value } : {}) });
    newTitle.value = '';
    newUrgent.value = false;
    adding.value = false;
  } catch (error) {
    toast.addToast({ message: error instanceof Error ? error.message : String(error), type: 'error', duration: 6000 });
  }
}

async function startAdd(): Promise<void> {
  adding.value = true;
  await nextTick();
  boardRef.value?.querySelector<HTMLInputElement>('.utp__new-title')?.focus();
}

const doneCount = computed(() => store.tasks.filter(t => t.doneAt !== undefined).length);

async function clearDone(): Promise<void> {
  const n = doneCount.value;
  if (!n || !window.confirm(`Delete ${n} done task${n === 1 ? '' : 's'} and their attachments?`)) return;
  try { await store.removeDone(); }
  catch (error) { toast.addToast({ message: String(error), type: 'error', duration: 6000 }); }
}

async function toggleDone(id: string, done: boolean): Promise<void> {
  try { await store.update(id, { done }); }
  catch (error) { toast.addToast({ message: String(error), type: 'error', duration: 6000 }); }
}

/** Arrow keys walk the notes in reading order; Enter opens, X completes, N adds. */
function onKey(event: KeyboardEvent): void {
  if (selected.value || adding.value) return;
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, select')) return;
  const notes = [...(boardRef.value?.querySelectorAll<HTMLElement>('.utp__note') ?? [])];
  const index = notes.indexOf(document.activeElement as HTMLElement);
  const move = (next: number) => { event.preventDefault(); notes[Math.max(0, Math.min(notes.length - 1, next))]?.focus(); };
  const perRow = Math.max(1, Math.round((boardRef.value?.clientWidth ?? 600) / 200));
  switch (event.key) {
    case 'ArrowRight': return move(index + 1);
    case 'ArrowLeft': return move(index - 1);
    case 'ArrowDown': return move(index < 0 ? 0 : index + perRow);
    case 'ArrowUp': return move(index - perRow);
    case 'n': case 'N': event.preventDefault(); void startAdd(); return;
    case 'x': case 'X': {
      const id = notes[index]?.dataset.taskId;
      if (id) { event.preventDefault(); void toggleDone(id, filter.value !== 'done'); }
    }
  }
}

onMounted(() => { void store.load(); });
</script>

<template>
  <section ref="boardRef" class="utp" aria-label="User tasks" @keydown="onKey">
    <UserTaskDetail
      v-if="selected"
      :task="selected"
      :tint="selectedTint"
      :project-name="selected.projectId ? projectName(selected.projectId) ?? 'Unknown project' : GENERAL_LABEL"
      @close="closeDetail"
    />
    <div v-show="!selected" class="utp__list">
    <header class="utp__bar">
      <div class="utp__chips" role="group" aria-label="Filter">
        <button
          v-for="f in FILTERS"
          :key="f.id"
          type="button"
          class="utp__chip"
          :class="{ 'utp__chip--on': filter === f.id }"
          :aria-pressed="filter === f.id"
          @click="filter = f.id"
        >{{ f.label }}<span v-if="f.id === 'all' && store.openCount" class="utp__count">{{ store.openCount }}</span></button>
      </div>
      <select v-model="grouping" class="utp__select" aria-label="Group by">
        <option value="project">By project</option>
        <option value="author">By author</option>
      </select>
      <SearchField v-model="query" class="utp__search" placeholder="Search tasks" aria-label="Search tasks" />
      <AppButton v-if="filter === 'done' && doneCount" size="sm" variant="danger" @click="clearDone">Clear done ({{ doneCount }})</AppButton>
      <AppButton size="sm" @click="startAdd">+ Task</AppButton>
    </header>

    <form v-if="adding" class="utp__new" @submit.prevent="addTask" @keydown.esc.stop="adding = false">
      <input v-model="newTitle" class="utp__new-title" maxlength="200" placeholder="What do you need to do?" aria-label="New task title" />
      <select v-model="newProject" class="utp__select" aria-label="Project">
        <option value="">{{ GENERAL_LABEL }}</option>
        <option v-for="p in appStore.state.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <label class="utp__urgent"><input v-model="newUrgent" type="checkbox" /> Urgent</label>
      <AppButton size="sm" type="submit">Add</AppButton>
      <AppButton size="sm" variant="ghost" @click="adding = false">Cancel</AppButton>
    </form>

    <div class="utp__scroll">
      <EmptyState v-if="!store.loaded" title="Loading tasks" loading />
      <EmptyState v-else-if="store.error" title="Could not load tasks" :hint="store.error" icon="⚠️" />
      <EmptyState
        v-else-if="!visible.length"
        :title="filter === 'done' ? 'Nothing done yet' : 'Nothing for you to do'"
        hint="Tasks you add, or that an AI posts with user_task_add, appear here."
        icon="📌"
      />
      <div v-else class="utp__columns">
        <section v-for="col in columns" :key="col.key" class="utp__column" :aria-label="col.label">
          <h3 class="utp__column-title">{{ col.label }} <span class="utp__column-count">{{ col.tasks.length }}</span></h3>
          <div class="utp__notes">
            <button
              v-for="task in col.tasks"
              :key="task.id"
              type="button"
              class="utp__note"
              :class="[`utp__note--t${col.tint}`, {
                'utp__note--ai': task.author.kind === 'ai',
                'utp__note--done': task.doneAt !== undefined,
                'utp__note--urgent': task.urgent,
              }]"
              :data-task-id="task.id"
              @click="selectedId = task.id"
            >
              <span class="utp__note-title">{{ task.title }}</span>
              <span v-if="task.body" class="utp__note-excerpt">{{ task.body }}</span>
              <span class="utp__note-meta">
                <span>{{ task.author.kind === 'ai' ? '🤖' : '🧑' }} {{ authorLabel(task) }}</span>
                <span class="utp__note-badges">
                  <span v-if="task.attachments.length">📎{{ task.attachments.length }}</span>
                  <span v-if="task.checklist.length" class="utp__note-chip">☑ {{ ticked(task) }}/{{ task.checklist.length }}</span>
                </span>
              </span>
            </button>
          </div>
        </section>
      </div>
    </div>

    </div>
  </section>
</template>

<style scoped>
.utp { position: relative; display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; background: var(--bg-primary); }
.utp__list { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.utp__bar, .utp__new { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); align-items: center; padding: var(--spacing-sm) var(--spacing-md); border-bottom: 1px solid var(--border); }
.utp__chips { display: flex; gap: 4px; }
.utp__chip { background: var(--bg-secondary); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; cursor: pointer; font: inherit; font-size: 0.85rem; }
.utp__chip--on { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
.utp__count { margin-left: 6px; font-size: 0.75rem; opacity: 0.85; }
.utp__select, .utp__new-title { background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; font: inherit; }
.utp__new-title { flex: 1; min-width: 200px; }
.utp__search { flex: 1; min-width: 140px; }
.utp__urgent { display: inline-flex; gap: 4px; color: var(--text-secondary); }
.utp__scroll { flex: 1; min-height: 0; overflow: auto; padding: var(--spacing-md); }
.utp__columns { display: flex; flex-direction: column; gap: var(--spacing-lg, 18px); }
.utp__column-title { margin: 0 0 var(--spacing-sm); font-size: 0.9rem; color: var(--text-secondary); }
.utp__column-count { opacity: 0.7; font-weight: normal; }
.utp__notes { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.utp__note { position: relative; display: flex; flex-direction: column; justify-content: space-between; gap: 10px; min-height: 96px; padding: 10px; border: 0; border-radius: 4px; text-align: left; cursor: pointer; font: inherit; color: #1b1b1b; box-shadow: 2px 3px 0 rgba(0, 0, 0, 0.35); }
.utp__note:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.utp__note--t0 { background: #ffe680; }
.utp__note--t1 { background: #ffb3c7; }
.utp__note--t2 { background: #b6f0b1; }
.utp__note--t3 { background: #a9d4ff; }
.utp__note--t4 { background: #ffc98a; }
.utp__note--ai { border-top: 3px dashed #6e40c9; }
.utp__note--urgent::after { content: '❗'; position: absolute; top: 4px; right: 6px; }
.utp__note--done { opacity: 0.45; }
.utp__note--done .utp__note-title { text-decoration: line-through; }
.utp__note-title { font-size: 0.9rem; overflow-wrap: anywhere; padding-right: 14px; }
.utp__note-excerpt { font-size: 0.75rem; opacity: 0.75; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.utp__note-badges { display: inline-flex; gap: 6px; }
.utp__note-chip { background: rgba(0, 0, 0, 0.12); border-radius: 8px; padding: 0 6px; }
.utp__note-meta { display: flex; justify-content: space-between; gap: 6px; font-size: 0.75rem; opacity: 0.75; }
</style>
