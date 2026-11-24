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
import type { UserTask, UserTaskAttachment } from '../../../src/types/user-task.js';

const props = defineProps<{ task: UserTask; projectName: string }>();
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
const viewing = ref<UserTaskAttachment | null>(null);
const frameSrc = ref('');
const imageSrc = ref('');

const isDone = computed(() => props.task.doneAt !== undefined);
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

const save = () => run(() => store.update(props.task.id, { title: title.value, body: body.value, urgent: urgent.value }), () => { editing.value = false; });
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

watch(() => props.task.id, () => { editing.value = false; viewing.value = null; });
onMounted(() => { recycleBin.ensureSubscribed(); window.addEventListener('keydown', onKey, true); });
onUnmounted(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <div class="utd-scrim" @click.self="emit('close')">
    <section class="utd" role="dialog" aria-modal="true" :aria-label="task.title" :data-tint="task.projectId ? undefined : 0">
      <header class="utd__head" :class="{ 'utd__head--urgent': task.urgent }">
        <template v-if="!editing">
          <h2 class="utd__title">{{ task.urgent ? '❗ ' : '' }}{{ task.title }}</h2>
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
        <p v-else-if="task.body" class="utd__text">{{ task.body }}</p>

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
            <li v-for="a in task.attachments" :key="a.id">
              <button type="button" class="utd__att" @click="open(a)">
                <span>{{ a.kind === 'plan' ? '🗺' : a.kind === 'artifact' ? '📄' : '📎' }} {{ a.title }}</span>
                <span class="utd__att-meta">{{ a.kind === 'plan' ? 'snapshot' : a.contentType }} · {{ Math.max(1, Math.round(a.sizeBytes / 1024)) }} KB</span>
              </button>
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
          <AppButton :variant="isDone ? 'secondary' : 'success'" @click="toggleDone">{{ isDone ? 'Reopen' : '✓ Done' }}</AppButton>
        </template>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.utd-scrim { position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.55); padding: var(--spacing-md); }
.utd { display: flex; flex-direction: column; width: min(640px, 100%); max-height: 100%; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.utd__head { padding: var(--spacing-md); border-left: 8px solid var(--user-task-tint, #ffe680); border-bottom: 1px solid var(--border); }
.utd__head--urgent { border-left-color: var(--accent-danger, #f85149); }
.utd__title { margin: 0; font-size: 1.05rem; color: var(--text-primary); overflow-wrap: anywhere; }
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
.utd__att { width: 100%; display: flex; justify-content: space-between; gap: 8px; text-align: left; background: var(--bg-tertiary, var(--bg-primary)); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; cursor: pointer; }
.utd__att:hover, .utd__att:focus-visible { border-color: var(--accent); }
.utd__att-meta { color: var(--text-secondary); font-size: 0.8rem; }
.utd__foot { display: flex; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); border-top: 1px solid var(--border); }
.utd__spacer { flex: 1; }
.utd__input, .utd__textarea { width: 100%; box-sizing: border-box; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font: inherit; }
.utd__check { display: inline-flex; gap: 6px; margin-top: 6px; color: var(--text-secondary); }
</style>
