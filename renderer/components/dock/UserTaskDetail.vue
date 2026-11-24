<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import AppButton from '../common/AppButton.vue';
import { useAppStore } from '../../stores/app.js';
import { useNavigationStore } from '../../stores/navigation.js';
import { useUserTasksStore } from '../../stores/user-tasks.js';
import { useRecycleBin } from '../../composables/useRecycleBin.js';
import { useToast } from '../../composables/useToast.js';
import { artifactsClient } from '../../ipc/clients.js';
import { buildArtifactDocument, buildMarkdownDocument } from '../../artifacts/build-artifact-document.js';
import { authorLabel } from '../../user-tasks/user-task-board.js';
import { USER_TASK_CHECKLIST_ITEM_MAX, USER_TASK_CHECKLIST_MAX, type UserTask, type UserTaskAttachment, type UserTaskChecklistItemInput } from '../../../src/types/user-task.js';

/** `tint` is the board's post-it colour index for this task's column, shown as a dot. */
const props = defineProps<{ task: UserTask; projectName: string; tint: number }>();
const emit = defineEmits<{ close: [] }>();

const appStore = useAppStore();
const navStore = useNavigationStore();
const store = useUserTasksStore();
const recycleBin = useRecycleBin();
const toast = useToast();

const editing = ref(false);
const title = ref('');
const body = ref('');
const urgent = ref(false);
const items = ref<UserTaskChecklistItemInput[]>([]);
const newItem = ref('');
const expanded = ref(false);
const viewing = ref<UserTaskAttachment | null>(null);
const frameSrc = ref('');
const imageSrc = ref('');

const isDone = computed(() => props.task.doneAt !== undefined);
const ticked = computed(() => props.task.checklist.filter(i => i.doneAt !== undefined).length);
const allTicked = computed(() => props.task.checklist.length > 0 && ticked.value === props.task.checklist.length);
/** Long descriptions start clamped so the checklist stays near the top. */
const longBody = computed(() => props.task.body.length > 420 || props.task.body.split('\n').length > 7);
const aiAuthor = computed(() => props.task.author.kind === 'ai' ? props.task.author : null);
const liveSession = computed(() => {
  const id = aiAuthor.value?.sessionId;
  return id ? appStore.state.sessions.find(s => s.id === id) : undefined;
});
const binEntry = computed(() => {
  const id = aiAuthor.value?.sessionId;
  return id && !liveSession.value ? recycleBin.entries.value.find(e => e.sessionId === id) : undefined;
});

function fmt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function startEdit(): void {
  title.value = props.task.title;
  body.value = props.task.body;
  urgent.value = props.task.urgent;
  items.value = props.task.checklist.map(i => ({ id: i.id, text: i.text }));
  editing.value = true;
}

async function run(action: () => Promise<unknown>, after?: () => void): Promise<void> {
  try {
    await action();
    after?.();
  } catch (error) {
    toast.addToast({ message: error instanceof Error ? error.message : String(error), type: 'error', duration: 6000 });
  }
}

const save = () => run(() => store.update(props.task.id, {
  title: title.value,
  body: body.value,
  urgent: urgent.value,
  checklist: items.value.filter(i => i.text.trim()),
}), () => { editing.value = false; });
const check = (itemId: string, done: boolean) => run(() => store.check(props.task.id, itemId, done));
const keep = (except?: string) => props.task.checklist.filter(i => i.id !== except).map(i => ({ id: i.id, text: i.text }));
const removeItem = (itemId: string) => run(() => store.update(props.task.id, { checklist: keep(itemId) }));
/** Inline rename: commit on blur/Enter; an emptied row reverts rather than deleting. */
function renameItem(itemId: string, input: HTMLInputElement): void {
  const text = input.value.trim();
  const current = props.task.checklist.find(i => i.id === itemId);
  if (!current || text === current.text) return;
  if (!text) { input.value = current.text; return; }
  void run(() => store.update(props.task.id, {
    checklist: props.task.checklist.map(i => ({ id: i.id, text: i.id === itemId ? text : i.text })),
  }));
}
function cancelRename(event: KeyboardEvent, text: string): void {
  const input = event.target as HTMLInputElement;
  input.value = text;
  input.blur();
}
const addItem = () => {
  const text = newItem.value.trim();
  if (!text) return;
  void run(() => store.update(props.task.id, { checklist: [...keep(), { text }] }), () => { newItem.value = ''; });
};
function moveItem(index: number, delta: number): void {
  const to = index + delta;
  if (to < 0 || to >= items.value.length) return;
  const next = [...items.value];
  [next[index], next[to]] = [next[to], next[index]];
  items.value = next;
}
const toggleDone = () => run(() => store.update(props.task.id, { done: !isDone.value }), () => emit('close'));
const remove = () => run(() => store.remove(props.task.id), () => emit('close'));
const jump = () => run(async () => { emit('close'); await navStore.navigateToSession(liveSession.value!.id); });
const restore = () => run(() => recycleBin.restore(binEntry.value!.id));

/** AI-authored text and HTML render only inside the opaque-origin artifact frame. */
async function open(attachment: UserTaskAttachment): Promise<void> {
  frameSrc.value = '';
  imageSrc.value = '';
  if (/^image\/(png|jpeg|gif|webp)$/.test(attachment.contentType)) {
    const read = await store.readAttachment(props.task.id, attachment.id);
    imageSrc.value = `data:${attachment.contentType};base64,${read.content}`;
    viewing.value = attachment;
    return;
  }
  if (!attachment.contentType.startsWith('text/') && attachment.contentType !== 'application/json') {
    await run(() => store.openAttachment(props.task.id, attachment.id));
    return;
  }
  await run(async () => {
    const read = await store.readAttachment(props.task.id, attachment.id);
    const doc = attachment.contentType === 'text/html'
      ? buildArtifactDocument(read.content)
      : attachment.contentType === 'text/markdown'
        ? buildMarkdownDocument(read.content)
        : buildMarkdownDocument('```\n' + read.content.replace(/```/g, '`​``') + '\n```');
    const nonce = await artifactsClient.artifactPrepareRender(doc);
    frameSrc.value = `helm-artifact://doc/?k=${encodeURIComponent(nonce)}`;
    viewing.value = attachment;
  });
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  if (viewing.value) viewing.value = null;
  else if (editing.value) editing.value = false;
  else emit('close');
}

watch(() => props.task.id, () => { editing.value = false; viewing.value = null; expanded.value = false; });
onMounted(() => { recycleBin.ensureSubscribed(); window.addEventListener('keydown', onKey, true); });
onUnmounted(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <section class="utd" :aria-label="task.title">
    <header class="utd__head">
      <button type="button" class="utd__back" @click="emit('close')">← Tasks</button>
      <template v-if="!editing">
        <h2 class="utd__title"><span class="utd__dot" :class="`utd__dot--t${tint}`" aria-hidden="true"></span>{{ task.urgent ? '❗ ' : '' }}{{ task.title }}</h2>
        <div class="utd__sub">{{ projectName }}<span v-if="isDone"> · done {{ fmt(task.doneAt!) }}</span></div>
      </template>
      <template v-else>
        <input v-model="title" class="utd__input" maxlength="200" aria-label="Title" />
        <label class="utd__check"><input v-model="urgent" type="checkbox" /> Urgent</label>
      </template>
    </header>

    <div v-if="viewing" class="utd__viewer">
      <div class="utd__viewer-bar">
        <strong>{{ viewing.title }}</strong>
        <AppButton size="sm" variant="ghost" @click="viewing = null">← Back</AppButton>
      </div>
      <img v-if="imageSrc" class="utd__image" :src="imageSrc" :alt="viewing.title" />
      <iframe v-else class="utd__frame" :src="frameSrc" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    </div>

    <div v-else class="utd__body">
      <textarea v-if="editing" v-model="body" class="utd__textarea" maxlength="4000" rows="6" aria-label="Details"></textarea>
      <template v-else-if="task.body">
        <p class="utd__text" :class="{ 'utd__text--clamp': longBody && !expanded }">{{ task.body }}</p>
        <button v-if="longBody" type="button" class="utd__more" @click="expanded = !expanded">{{ expanded ? 'Show less ▴' : 'Show more ▾' }}</button>
      </template>

      <template v-if="editing">
        <h3 class="utd__h3">Checklist</h3>
        <ol class="utd__edit-items">
          <li v-for="(item, i) in items" :key="item.id ?? `new-${i}`" class="utd__edit-item">
            <input v-model="item.text" class="utd__input" :maxlength="USER_TASK_CHECKLIST_ITEM_MAX" :aria-label="`Item ${i + 1}`" />
            <AppButton size="sm" variant="ghost" :disabled="i === 0" aria-label="Move up" @click="moveItem(i, -1)">↑</AppButton>
            <AppButton size="sm" variant="ghost" :disabled="i === items.length - 1" aria-label="Move down" @click="moveItem(i, 1)">↓</AppButton>
            <AppButton size="sm" variant="ghost" aria-label="Remove item" @click="items.splice(i, 1)">✕</AppButton>
          </li>
        </ol>
        <AppButton v-if="items.length < USER_TASK_CHECKLIST_MAX" size="sm" variant="ghost" @click="items.push({ text: '' })">＋ Add item</AppButton>
      </template>
      <template v-else-if="task.checklist.length || !isDone">
        <div class="utd__checklist-head">
          <h3 class="utd__h3">Checklist</h3>
          <span v-if="task.checklist.length" class="utd__count">{{ ticked }} / {{ task.checklist.length }}</span>
          <div v-if="task.checklist.length" class="utd__bar"><i :style="{ width: `${100 * ticked / task.checklist.length}%` }"></i></div>
        </div>
        <ul class="utd__items">
          <li v-for="item in task.checklist" :key="item.id" class="utd__item" :class="{ 'utd__item--done': item.doneAt !== undefined }">
            <input
              class="utd__item-check"
              type="checkbox"
              :checked="item.doneAt !== undefined"
              :aria-label="`Done: ${item.text}`"
              @change="check(item.id, ($event.target as HTMLInputElement).checked)"
            />
            <input
              class="utd__item-text"
              :value="item.text"
              :maxlength="USER_TASK_CHECKLIST_ITEM_MAX"
              :aria-label="`Item: ${item.text}`"
              @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
              @keydown.esc.stop.prevent="cancelRename($event, item.text)"
              @blur="renameItem(item.id, ($event.target as HTMLInputElement))"
            />
            <button type="button" class="utd__item-remove" :aria-label="`Remove ${item.text}`" @click="removeItem(item.id)">✕</button>
          </li>
        </ul>
        <form v-if="task.checklist.length < USER_TASK_CHECKLIST_MAX" class="utd__add" @submit.prevent="addItem">
          <input v-model="newItem" class="utd__input" :maxlength="USER_TASK_CHECKLIST_ITEM_MAX" placeholder="＋ Add item" aria-label="New checklist item" />
        </form>
      </template>

      <dl class="utd__meta">
        <dt>From</dt>
        <dd>
          <template v-if="aiAuthor">
            🤖 {{ aiAuthor.name }}<span v-if="aiAuthor.cliType"> ({{ aiAuthor.cliType }})</span>
            <AppButton v-if="liveSession" size="sm" variant="ghost" @click="jump">Jump ▸</AppButton>
            <template v-else-if="binEntry">
              <span class="utd__gone">closed</span>
              <AppButton size="sm" variant="ghost" @click="restore">Restore from bin</AppButton>
            </template>
            <span v-else-if="aiAuthor.sessionId" class="utd__gone">session gone</span>
          </template>
          <template v-else>🧑 {{ authorLabel(task) }}</template>
        </dd>
        <template v-if="aiAuthor?.dir"><dt>Folder</dt><dd class="utd__mono">{{ aiAuthor.dir }}</dd></template>
        <dt>Created</dt><dd>{{ fmt(task.createdAt) }}</dd>
        <template v-if="task.updatedAt !== task.createdAt"><dt>Updated</dt><dd>{{ fmt(task.updatedAt) }}</dd></template>
      </dl>

      <template v-if="task.attachments.length">
        <h3 class="utd__h3">Attachments</h3>
        <ul class="utd__atts">
          <li v-for="a in task.attachments" :key="a.id" class="utd__att-row">
            <button type="button" class="utd__att" @click="open(a)">
              <span>{{ a.kind === 'plan' ? '🗺' : a.kind === 'artifact' ? '📄' : '📎' }} {{ a.title }}</span>
              <span class="utd__att-meta">{{ a.kind === 'plan' ? 'snapshot' : a.contentType }} · {{ Math.max(1, Math.round(a.sizeBytes / 1024)) }} KB</span>
            </button>
            <AppButton variant="ghost" :aria-label="`Save ${a.title}`" @click="run(() => store.saveAttachment(task.id, a.id))">Save</AppButton>
          </li>
        </ul>
      </template>
    </div>

    <footer class="utd__foot">
      <template v-if="editing">
        <AppButton variant="ghost" @click="editing = false">Cancel</AppButton>
        <AppButton @click="save">Save</AppButton>
      </template>
      <template v-else>
        <AppButton variant="danger" size="sm" @click="remove">Delete</AppButton>
        <span class="utd__spacer"></span>
        <AppButton variant="secondary" @click="startEdit">Edit</AppButton>
        <AppButton :class="{ 'utd__done--ready': allTicked && !isDone }" :variant="isDone ? 'secondary' : 'success'" @click="toggleDone">{{ isDone ? 'Reopen' : '✓ Done' }}</AppButton>
      </template>
    </footer>
  </section>
</template>

<style scoped>
.utd { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-primary); }
.utd__head { flex: none; padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md); border-bottom: 1px solid var(--border); }
.utd__back { background: none; border: 0; padding: 2px 0; margin-bottom: 6px; color: var(--accent); font: inherit; font-size: 0.85rem; cursor: pointer; }
.utd__back:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.utd__title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 1.05rem; color: var(--text-primary); overflow-wrap: anywhere; }
.utd__dot { flex: none; width: 10px; height: 10px; border-radius: 50%; }
.utd__dot--t0 { background: #ffe680; }
.utd__dot--t1 { background: #ffb3c7; }
.utd__dot--t2 { background: #b6f0b1; }
.utd__dot--t3 { background: #a9d4ff; }
.utd__dot--t4 { background: #ffc98a; }
.utd__text--clamp { display: -webkit-box; -webkit-line-clamp: 7; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px; }
.utd__more { background: none; border: 0; padding: 0; margin-bottom: var(--spacing-md); color: var(--accent); font: inherit; font-size: 0.85rem; cursor: pointer; }
.utd__checklist-head { position: sticky; top: calc(-1 * var(--spacing-md)); z-index: 1; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px; padding: 6px 0; background: var(--bg-primary); }
.utd__checklist-head .utd__h3 { margin: 0; }
.utd__count { color: var(--text-secondary); font-size: 0.85rem; }
.utd__bar { grid-column: 1 / -1; height: 4px; border-radius: 2px; background: var(--bg-tertiary, var(--border)); overflow: hidden; }
.utd__bar i { display: block; height: 100%; background: var(--accent-success, #3fb950); transition: width 0.2s; }
.utd__items, .utd__edit-items { list-style: none; margin: 0; padding: 0; }
.utd__item { display: flex; align-items: center; gap: 6px; border-radius: 4px; }
.utd__item:hover, .utd__item:focus-within { background: var(--bg-secondary); }
.utd__item-check { flex: none; width: 16px; height: 16px; margin: 0 2px 0 4px; accent-color: var(--accent-success, #3fb950); cursor: pointer; }
.utd__item-text { flex: 1; min-width: 0; padding: 6px 4px; background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--text-primary); font: inherit; }
.utd__item-text:hover { border-color: var(--border); }
.utd__item-text:focus { outline: none; border-color: var(--accent); background: var(--bg-secondary); }
.utd__item--done .utd__item-text { text-decoration: line-through; color: var(--text-secondary); }
.utd__item-remove { background: none; border: 0; color: var(--text-secondary); cursor: pointer; padding: 4px 6px; opacity: 0.35; }
.utd__item:hover .utd__item-remove, .utd__item-remove:focus-visible { opacity: 1; }
.utd__add { margin: 4px 0 var(--spacing-md); }
.utd__add .utd__input { border-style: dashed; }
.utd__edit-item { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; }
.utd__done--ready { animation: utd-ready 1.6s ease-in-out infinite; }
@keyframes utd-ready { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-success, #3fb950) 45%, transparent); } }
@media (prefers-reduced-motion: reduce) { .utd__done--ready { animation: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-success, #3fb950) 45%, transparent); } }
.utd__sub { color: var(--text-secondary); font-size: 0.85rem; margin-top: 2px; }
.utd__body, .utd__viewer { flex: 1; min-height: 0; overflow: auto; padding: var(--spacing-md); }
.utd__viewer { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.utd__viewer-bar { display: flex; justify-content: space-between; align-items: center; }
.utd__frame { flex: 1; min-height: 320px; width: 100%; border: 0; background: #fff; border-radius: 6px; }
.utd__image { max-width: 100%; object-fit: contain; }
.utd__text { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-primary); margin: 0 0 var(--spacing-md); }
.utd__meta { display: grid; grid-template-columns: 90px 1fr; gap: 4px 8px; margin: 0 0 var(--spacing-md); font-size: 0.9rem; }
.utd__meta dt { color: var(--text-secondary); }
.utd__meta dd { margin: 0; color: var(--text-primary); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.utd__mono { font-family: var(--font-mono, monospace); font-size: 0.85rem; overflow-wrap: anywhere; }
.utd__gone { color: var(--text-secondary); font-style: italic; }
.utd__h3 { font-size: 0.9rem; margin: 0 0 6px; color: var(--text-secondary); }
.utd__atts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.utd__att-row { display: flex; gap: 4px; align-items: stretch; }
.utd__att { flex: 1; min-width: 0; display: flex; justify-content: space-between; gap: 8px; text-align: left; background: var(--bg-tertiary, var(--bg-primary)); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; cursor: pointer; }
.utd__att:hover, .utd__att:focus-visible { border-color: var(--accent); }
.utd__att-meta { color: var(--text-secondary); font-size: 0.8rem; }
.utd__foot { flex: none; display: flex; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); border-top: 1px solid var(--border); }
.utd__spacer { flex: 1; }
.utd__input, .utd__textarea { width: 100%; box-sizing: border-box; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font: inherit; }
.utd__check { display: inline-flex; gap: 6px; margin-top: 6px; color: var(--text-secondary); }
</style>
