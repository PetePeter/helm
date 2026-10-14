<script setup lang="ts">
/**
 * Directory picker modal — select a working directory to spawn a CLI in.
 *
 * Master/detail: projects on the left, the focused project's dirs on the
 * right. Falls back to a single dir list when no dir has project metadata.
 * The caller passes directories for the already selected machine — machine
 * selection happens in Quick Spawn, before choosing a tool.
 *
 * Gamepad: D-pad up/down moves within a pane, left/right (or A / B) switches
 * pane, A on a dir spawns, B in the project pane cancels. Digits pick a dir
 * of the focused project. Keyboard routed via App.vue bridge → useModalStack.
 */
import { computed, ref, watch, nextTick } from 'vue';
import { SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { useModalAutofocus } from '../../composables/useModalAutofocus.js';
import { toDirection, getCliDisplayName } from '../../utils.js';
import { jumpKeyLabel, jumpButtonToPosition } from '../../utils/jump-keys.js';
import { groupDirsByProject, locatePath, type DirItem } from '../../utils/dir-picker-model.js';

type Pane = 'projects' | 'dirs';

const MODAL_ID = 'dir-picker';

const props = defineProps<{
  visible: boolean;
  cliType: string;
  items: DirItem[];
  preselectedPath?: string;
  machineId?: string;
  loading?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'select', path: string, machineId: string): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const pane = ref<Pane>('dirs');
const projectIndex = ref(0);
/** Focused dir within the focused project. */
const selectedIndex = ref(0);
const modalStack = useModalStack();
const overlayRef = ref<HTMLElement | null>(null);
const { focusIntoModal } = useModalAutofocus(overlayRef, '.dir-picker-item--focused, .dir-picker-project--active');

const projects = computed(() => groupDirsByProject(props.items));
const dirs = computed<DirItem[]>(() =>
  projects.value ? projects.value[projectIndex.value]?.dirs ?? [] : props.items,
);

async function focusCurrent(): Promise<void> {
  await nextTick();
  const id = pane.value === 'projects'
    ? `dir-picker-project-${projectIndex.value}`
    : `dir-picker-option-${selectedIndex.value}`;
  overlayRef.value?.querySelector<HTMLElement>(`#${id}`)?.focus();
}

function reset(): void {
  const groups = projects.value;
  if (!groups) {
    pane.value = 'dirs';
    projectIndex.value = 0;
    const idx = props.preselectedPath ? props.items.findIndex(d => d.path === props.preselectedPath) : -1;
    selectedIndex.value = Math.max(idx, 0);
    return;
  }
  const hit = locatePath(groups, props.preselectedPath);
  pane.value = hit ? 'dirs' : 'projects';
  projectIndex.value = hit?.projectIndex ?? 0;
  selectedIndex.value = hit?.dirIndex ?? 0;
}

watch(() => props.visible, (v) => {
  if (v) {
    reset();
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: SELECTION_KEYS });
    void focusIntoModal();
    void focusCurrent();
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

function setPane(next: Pane): void {
  if (!projects.value) return;
  pane.value = next;
  void focusCurrent();
}

function moveFocus(delta: number): void {
  if (pane.value === 'projects') {
    const last = (projects.value?.length ?? 1) - 1;
    projectIndex.value = Math.min(last, Math.max(0, projectIndex.value + delta));
    selectedIndex.value = 0;
  } else {
    selectedIndex.value = Math.min(dirs.value.length - 1, Math.max(0, selectedIndex.value + delta));
  }
  void focusCurrent();
}

function cancel(): void {
  emit('cancel');
  emit('update:visible', false);
}

function handleButton(button: string): boolean {
  const dir = toDirection(button);
  if (dir === 'up' || button === 'ShiftTab') moveFocus(-1);
  else if (dir === 'down' || button === 'Tab') moveFocus(1);
  else if (dir === 'right') setPane('dirs');
  else if (dir === 'left') setPane('projects');
  else if (button === 'A') {
    if (pane.value === 'projects') setPane('dirs');
    else selectDir(selectedIndex.value);
  } else if (button === 'B') {
    if (pane.value === 'dirs' && projects.value) setPane('projects');
    else cancel();
  } else {
    const pos = jumpButtonToPosition(button);
    if (pos !== null) selectDir(pos);
  }
  return true;
}

function selectProject(index: number): void {
  projectIndex.value = index;
  selectedIndex.value = 0;
  setPane('dirs');
}

function selectDir(index: number): void {
  const item = dirs.value[index];
  if (item) {
    emit('select', item.path, props.machineId ?? '');
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
      class="modal-overlay modal--visible dir-picker-overlay"
      role="dialog"
      aria-label="Select working directory"
      tabindex="-1"
    >
      <div class="modal" :class="{ 'dir-picker-modal--split': projects }">
        <div class="modal-header">
          <h3 class="modal-title">{{ getCliDisplayName(cliType) }} — Select Directory</h3>
        </div>
        <div v-if="loading" class="dir-picker-status">Loading directories…</div>
        <div v-else-if="error" class="dir-picker-status dir-picker-status--error">{{ error }}</div>
        <div v-else class="dir-picker-body">
          <div
            v-if="projects"
            class="dir-picker-projects"
            role="listbox"
            aria-label="Projects"
            :aria-activedescendant="`dir-picker-project-${projectIndex}`"
          >
            <div
              v-for="(project, i) in projects"
              :id="`dir-picker-project-${i}`"
              :key="project.key || project.title"
              class="dir-picker-project focusable"
              :class="{
                'dir-picker-project--focused': i === projectIndex,
                'dir-picker-project--active': pane === 'projects' && i === projectIndex,
                'dir-picker-project--other': !project.key,
              }"
              tabindex="-1"
              role="option"
              :aria-selected="i === projectIndex"
              @keydown="suppressActivationKey"
              @click="selectProject(i)"
            >
              <span class="dir-picker-project__name">{{ project.title }}</span>
              <span class="dir-picker-project__count">{{ project.dirs.length }}</span>
            </div>
          </div>
          <div
            class="dir-picker-list"
            id="dirPickerList"
            role="listbox"
            aria-label="Directories"
            :aria-activedescendant="dirs[selectedIndex] ? `dir-picker-option-${selectedIndex}` : undefined"
          >
            <div
              v-for="(item, i) in dirs"
              :id="`dir-picker-option-${i}`"
              :key="item.path"
              class="dir-picker-item focusable"
              :class="{ 'dir-picker-item--focused': pane === 'dirs' && i === selectedIndex }"
              tabindex="-1"
              role="option"
              :aria-selected="i === selectedIndex"
              @keydown="suppressActivationKey"
              @click="selectDir(i)"
            >
              <span v-if="jumpKeyLabel(i) != null" class="jump-key">{{ jumpKeyLabel(i) }}</span>
              <span class="dir-picker-item__body">
                <span class="dir-picker-item__name">
                  {{ item.name }}
                  <span v-if="item.isCanonical" class="dir-picker-item__badge">Main</span>
                </span>
                <span class="dir-picker-item__path">{{ item.path }}</span>
              </span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" tabindex="-1" @keydown="suppressActivationKey" @click="cancel">Cancel</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dir-picker-modal--split {
  width: min(760px, 92vw);
  max-width: none;
}

.dir-picker-body {
  display: flex;
  min-height: 0;
}

.dir-picker-body .dir-picker-list {
  flex: 1;
  min-width: 0;
  max-height: min(60vh, 480px);
}

.dir-picker-projects {
  flex: 0 0 220px;
  overflow-y: auto;
  max-height: min(60vh, 480px);
  padding: var(--spacing-sm);
  border-right: 1px solid var(--border);
}

.dir-picker-project {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.15s;
}

.dir-picker-project:hover,
.dir-picker-project--focused {
  background: var(--bg-tertiary);
}

.dir-picker-project--active {
  border-color: var(--accent);
}

.dir-picker-project__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--text-primary);
}

.dir-picker-project--other .dir-picker-project__name {
  color: var(--text-secondary);
}

.dir-picker-project__count {
  font-size: 11px;
  color: var(--text-secondary);
}

.dir-picker-status {
  padding: 12px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.dir-picker-status--error {
  color: var(--danger);
}

.dir-picker-item__badge {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 700;
  color: var(--accent);
}
</style>
