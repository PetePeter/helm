<script setup lang="ts">
/**
 * OperatorChat — the Helm operator's pane as a chat thread, the desktop twin of
 * the phone's operator screen. Bubbles come from the chat journal
 * (useOperatorChat); Terminal flips back to the raw PTY; Call is the same
 * hands-free call as the sidebar's. The PTT key (Settings → Operator) or the
 * mic button is held to dictate into the composer.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { operatorPttKey as pttKey, operatorView, useOperatorChat } from '../../composables/useOperatorChat.js';
import { useVoiceCall } from '../../composables/useVoiceCall.js';
import { composerKeyAction } from '../../operator/operator-chat.js';
import { artifactsClient, configClient, dialogClient } from '../../ipc/clients.js';
import { registerKeyHandler } from '../../keyboard/router.js';

const props = defineProps<{
  sessionId: string;
  /** Header label; the operator keeps its name, an API tool shows its session name. */
  title: string;
  /** Only the operator takes calls. */
  isOperator: boolean;
  comfyProfiles?: Array<{ id: string; name: string; kind: 'image' | 'video'; supportsImageSize: boolean; maxReferenceImages: number }>;
  comfyImageSizes?: Array<{ id: string; name: string; width: number; height: number }>;
}>();

const chat = useOperatorChat(props.sessionId);
// The picked model and size live on the per-session chat, so they outlive this pane's remounts.
const { bubbles, draft, attachment, sending, recording, transcribing, error, comfyProfileId: profileId, comfyImageSizeId: imageSizeId,
  comfyGallery, includedReferenceIds, selectedComfyAttachmentIds } = chat;
const { inCall, handsFree, toggleCall, hangUp } = useVoiceCall();

const thread = ref<HTMLElement | null>(null);
const attachmentName = computed(() => attachment.value?.split(/[\\/]/).pop() ?? '');
const pttLabel = computed(() => pttKey.value.toUpperCase());
const isComfyUi = computed(() => (props.comfyProfiles?.length ?? 0) > 0);
const selectedProfile = computed(() => props.comfyProfiles?.find(profile => profile.id === profileId.value));
const supportsImageSize = computed(() => selectedProfile.value?.supportsImageSize === true && (props.comfyImageSizes?.length ?? 0) > 0);
const maxReferenceImages = computed(() => selectedProfile.value?.maxReferenceImages ?? 1);
const galleryImage = ref<NonNullable<(typeof comfyGallery.value)[number]['attachment']> | null>(null);
const canSend = computed(() => {
  if (sending.value) return false;
  if (!isComfyUi.value) return Boolean(draft.value.trim());
  const count = selectedComfyAttachmentIds.value.length + (attachment.value ? 1 : 0);
  return (Boolean(draft.value.trim()) || count > 0) && count <= maxReferenceImages.value;
});
const chatHint = computed(() => isComfyUi.value
  ? `Enter to generate · ${maxReferenceImages.value} reference image${maxReferenceImages.value === 1 ? '' : 's'} max · Type /cancel to stop`
  : `Enter to send · Shift/Ctrl+Enter for a new line · Hold 🎤 or ${pttLabel.value} to talk`);
const previewUrl = (path: string) => `helm-img://f/?p=${encodeURIComponent(path)}`;
watch(
  () => [props.comfyProfiles, props.comfyImageSizes],
  () => chat.syncComfyOptions(props.comfyProfiles, props.comfyImageSizes),
  { deep: true, immediate: true },
);
watch(() => [comfyGallery.value.length, maxReferenceImages.value], () => {
  if (isComfyUi.value) chat.limitReferences(maxReferenceImages.value);
});

function sendPrompt(): void {
  void chat.send(
    isComfyUi.value ? profileId.value : undefined,
    supportsImageSize.value ? imageSizeId.value : undefined,
    isComfyUi.value ? maxReferenceImages.value : undefined,
  );
}

function setGalleryIncluded(bubble: (typeof comfyGallery.value)[number], included: boolean): void {
  const selectedCount = selectedComfyAttachmentIds.value.length + (attachment.value ? 1 : 0);
  if (included && selectedCount >= maxReferenceImages.value) {
    error.value = `This profile accepts at most ${maxReferenceImages.value} reference image${maxReferenceImages.value === 1 ? '' : 's'}`;
    return;
  }
  error.value = null;
  chat.setReferenceIncluded(bubble, included, maxReferenceImages.value);
}

function galleryIncluded(bubble: (typeof comfyGallery.value)[number]): boolean {
  return includedReferenceIds.value.has(`${bubble.attachment?.artifactId}:${bubble.attachment?.attachmentId}`);
}

function saveGalleryImage(image: NonNullable<(typeof comfyGallery.value)[number]['attachment']>): void {
  if (image.artifactId && image.attachmentId) void artifactsClient.artifactSaveAttachment(image.artifactId, image.attachmentId);
}

function onCallClick(): void {
  if (inCall.value && !handsFree.value) hangUp();
  else void toggleCall();
}

function onComposerKey(event: KeyboardEvent): void {
  const action = composerKeyAction(event);
  if (action !== 'send') return; // newline: the textarea's default
  event.preventDefault();
  sendPrompt();
}

async function pickAttachment(): Promise<void> {
  const filters = isComfyUi.value
    ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    : [{ name: 'All Files', extensions: ['*'] }];
  const selected = await dialogClient.dialogShowOpenFile?.(filters);
  if (selected) attachment.value = selected;
}

function cancelGeneration(): void {
  draft.value = '/cancel';
  void chat.send(profileId.value);
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Keep the newest message in view.
watch(() => bubbles.value.length, async () => {
  await nextTick();
  thread.value?.scrollTo({ top: thread.value.scrollHeight });
});

// Hold-to-talk key: pressed through the one key router, released on its keyup.
let releaseKey: string | null = null;
function releasePtt(): void {
  releaseKey = null;
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', releasePtt);
  void chat.pttStop();
}
function onKeyUp(event: KeyboardEvent): void {
  if (event.key === releaseKey) releasePtt();
}
const unregister = registerKeyHandler({
  id: 'operator-chat-ptt',
  scope: 'global',
  allowInEditable: true,
  claims: (ctx) => ctx.combo === pttKey.value && !ctx.event.repeat,
  handle: (ctx) => {
    if (releaseKey === null) {
      releaseKey = ctx.event.key;
      window.addEventListener('keyup', onKeyUp, true);
      // Alt-Tab mid-hold swallows the keyup: losing focus releases too.
      window.addEventListener('blur', releasePtt);
      void chat.pttStart();
    }
    return true;
  },
});

onMounted(async () => {
  void chat.open();
  pttKey.value = (await configClient.configGetOperatorConfig()).pttKey;
});

onBeforeUnmount(() => {
  unregister();
  releasePtt();
  chat.close();
});
</script>

<template>
  <div class="operator-chat">
    <div class="operator-chat__header">
      <span class="operator-chat__title">{{ title }}</span>
      <label v-if="isComfyUi" class="operator-chat__profile">
        <span>{{ selectedProfile?.kind === 'video' ? 'Workflow' : 'Model' }}</span>
        <select v-model="profileId" class="focusable" aria-label="ComfyUI model or workflow">
          <option v-for="profile in comfyProfiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
        </select>
      </label>
      <label v-if="supportsImageSize" class="operator-chat__profile">
        <span>Size</span>
        <select v-model="imageSizeId" class="focusable" aria-label="Image size and orientation">
          <option v-for="size in comfyImageSizes" :key="size.id" :value="size.id">{{ size.name }} ({{ size.width }}×{{ size.height }})</option>
        </select>
      </label>
      <button v-if="isComfyUi" class="btn btn--sm btn--secondary focusable" type="button" :disabled="sending" @click="cancelGeneration">Cancel generation</button>
      <button
        v-if="isOperator"
        class="btn btn--sm focusable"
        :class="inCall ? 'btn--danger' : 'btn--secondary'"
        type="button"
        @click="onCallClick"
      >{{ inCall ? 'Hang up' : 'Call' }}</button>
      <button class="btn btn--sm btn--secondary focusable" type="button" title="Show the terminal" @click="operatorView = 'terminal'">Terminal</button>
    </div>

    <div ref="thread" class="operator-chat__thread">
      <div v-if="bubbles.length === 0" class="operator-chat__empty">No messages yet. Ask anything.</div>
      <div
        v-for="bubble in bubbles"
        :key="bubble.seq"
        class="operator-chat__bubble"
        :class="`operator-chat__bubble--${bubble.from}`"
      >
        <div class="operator-chat__text">{{ bubble.text }}</div>
        <div v-if="bubble.attachment?.filePath && !(isComfyUi && bubble.attachment.mimeType?.startsWith('image/'))" class="operator-chat__media">
          <img v-if="bubble.attachment.mimeType?.startsWith('image/')" :src="previewUrl(bubble.attachment.filePath)" :alt="bubble.attachment.filename" />
          <video v-else-if="bubble.attachment.mimeType?.startsWith('video/')" :src="previewUrl(bubble.attachment.filePath)" controls preload="metadata" />
          <button
            v-if="bubble.attachment.artifactId && bubble.attachment.attachmentId"
            class="btn btn--sm btn--secondary focusable"
            type="button"
            @click="artifactsClient.artifactOpenAttachment(bubble.attachment.artifactId!, bubble.attachment.attachmentId!)"
          >Open</button>
          <button
            v-if="bubble.attachment.artifactId && bubble.attachment.attachmentId"
            class="btn btn--sm btn--secondary focusable"
            type="button"
            @click="artifactsClient.artifactSaveAttachment(bubble.attachment.artifactId!, bubble.attachment.attachmentId!)"
          >Save as</button>
        </div>
        <div v-if="bubble.badge" class="operator-chat__badge">{{ bubble.badge }}</div>
        <div class="operator-chat__time">{{ time(bubble.at) }}</div>
      </div>
    </div>

    <div v-if="isComfyUi && comfyGallery.length" class="operator-chat__gallery" aria-label="Session reference images">
      <div v-for="bubble in comfyGallery" :key="`${bubble.attachment?.artifactId}:${bubble.attachment?.attachmentId}`" class="operator-chat__gallery-item">
        <button class="operator-chat__gallery-preview" type="button" :aria-label="`View ${bubble.attachment?.filename} full size`" @click="galleryImage = bubble.attachment ?? null">
          <img v-if="bubble.attachment?.filePath" :src="previewUrl(bubble.attachment.filePath)" :alt="bubble.attachment.filename" loading="eager" decoding="async" />
          <span v-else>{{ bubble.attachment?.filename }}</span>
        </button>
        <label class="operator-chat__gallery-include">
          <input type="checkbox" :checked="galleryIncluded(bubble)" @change="setGalleryIncluded(bubble, ($event.target as HTMLInputElement).checked)" />
          Use later
        </label>
        <button v-if="bubble.attachment?.artifactId && bubble.attachment.attachmentId" class="operator-chat__gallery-save" type="button" @click="saveGalleryImage(bubble.attachment)">Save</button>
      </div>
    </div>

    <div v-if="galleryImage" class="operator-chat__viewer" role="dialog" aria-modal="true" :aria-label="galleryImage.filename" @click.self="galleryImage = null">
      <button class="operator-chat__viewer-close" type="button" aria-label="Close image" @click="galleryImage = null">×</button>
      <img v-if="galleryImage.filePath" :src="previewUrl(galleryImage.filePath)" :alt="galleryImage.filename" />
      <button v-if="galleryImage.artifactId && galleryImage.attachmentId" class="btn btn--sm btn--secondary" type="button" @click="saveGalleryImage(galleryImage)">Save image</button>
    </div>

    <div v-if="error" class="operator-chat__error" role="alert">{{ error }}</div>

    <div class="operator-chat__composer">
      <button class="btn btn--sm btn--secondary focusable" type="button" title="Attach a file" @click="pickAttachment">📎</button>
      <div class="operator-chat__input-wrap">
        <div v-if="attachment" class="operator-chat__attachment">
          📎 {{ attachmentName }}
        <button type="button" class="operator-chat__attachment-clear" title="Remove attachment" @click="attachment = null">✕</button>
        </div>
        <textarea
          v-model="draft"
          class="operator-chat__input"
          rows="2"
          :placeholder="isComfyUi ? 'Describe what to generate… or send images alone' : 'Message the operator…'"
          @keydown="onComposerKey"
        />
      </div>
      <button
        v-if="!isComfyUi"
        class="operator-chat__ptt focusable"
        :class="{ 'operator-chat__ptt--live': recording }"
        type="button"
        :title="`Hold to talk (or hold ${pttLabel})`"
        @pointerdown.prevent="chat.pttStart()"
        @pointerup="chat.pttStop()"
        @pointerleave="chat.pttStop()"
      >{{ transcribing ? '…' : '🎤' }}</button>
      <button
        class="btn btn--sm btn--primary focusable"
        type="button"
        :disabled="!canSend"
        @click="sendPrompt"
      >Send</button>
    </div>
    <div class="operator-chat__hint">{{ chatHint }}</div>
  </div>
</template>

<style scoped>
.operator-chat {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.operator-chat__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
}

.operator-chat__title {
  flex: 1;
  font-weight: 600;
}

.operator-chat__thread {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
}

.operator-chat__empty {
  margin: auto;
  color: var(--text-dim);
}

.operator-chat__bubble {
  max-width: 70%;
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.operator-chat__bubble--you {
  align-self: flex-end;
  background: var(--accent);
  color: var(--accent-contrast);
  border-bottom-right-radius: 3px;
}

.operator-chat__bubble--helm {
  align-self: flex-start;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-bottom-left-radius: 3px;
}

.operator-chat__time,
.operator-chat__badge {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  opacity: 0.65;
}

.operator-chat__error {
  padding: var(--spacing-xs) var(--spacing-md);
  color: var(--danger);
}

.operator-chat__composer {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md) var(--spacing-xs);
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border);
}

.operator-chat__input-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
}

.operator-chat__input {
  width: 100%;
  resize: none;
  padding: var(--spacing-sm);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font: inherit;
}

.operator-chat__input:focus {
  outline: none;
  border-color: var(--accent);
}

.operator-chat__attachment {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  align-self: flex-start;
  padding: 2px var(--spacing-sm);
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
}

.operator-chat__attachment-clear {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.operator-chat__profile { display: flex; flex-direction: column; gap: 2px; font-size: var(--font-size-xs); color: var(--text-dim); }
.operator-chat__profile select { max-width: 150px; padding: 5px 8px; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.operator-chat__media { display: flex; flex-direction: column; gap: var(--spacing-xs); margin-top: var(--spacing-xs); }
.operator-chat__media img, .operator-chat__media video { max-width: min(560px, 70vw); max-height: 420px; border-radius: var(--radius-sm); object-fit: contain; background: #000; }

.operator-chat__gallery {
  display: flex;
  gap: var(--spacing-sm);
  overflow-x: auto;
  padding: var(--spacing-sm) var(--spacing-md);
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}

.operator-chat__gallery-item {
  display: flex;
  flex: 0 0 112px;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
}

.operator-chat__gallery-preview {
  display: grid;
  width: 112px;
  height: 88px;
  place-items: center;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: #000;
  color: var(--text-secondary);
  cursor: zoom-in;
}

.operator-chat__gallery-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.operator-chat__gallery-include {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
}

.operator-chat__gallery-save {
  align-self: flex-start;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
}

.operator-chat__viewer {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: var(--spacing-md);
  padding: 48px;
  background: rgb(0 0 0 / 88%);
}

.operator-chat__viewer img {
  max-width: 100%;
  max-height: calc(100vh - 120px);
  object-fit: contain;
}

.operator-chat__viewer-close {
  position: absolute;
  top: 12px;
  right: 18px;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 28px;
  cursor: pointer;
}

.operator-chat__ptt {
  width: 40px;
  height: 36px;
  background: var(--bg-secondary);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  color: var(--accent);
  cursor: pointer;
  user-select: none;
}

.operator-chat__ptt--live {
  background: var(--accent);
  color: var(--accent-contrast);
}

.operator-chat__hint {
  padding: 0 var(--spacing-md) var(--spacing-sm);
  background: var(--bg-tertiary);
  color: var(--text-dim);
  font-size: var(--font-size-xs);
}
</style>
