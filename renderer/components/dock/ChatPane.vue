<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { contextLevel, resolveContextLimits } from '../../../src/session/context-limits.js';
import { useAppStore } from '../../stores/app.js';
import { useChatStore, type ChatThreadMessage } from '../../stores/chat.js';
import { getActivityColor } from '../../state-colors.js';
import { getCliDisplayName, resolveCliTypeRecord } from '../../utils.js';
import { formatSessionContextUsage, sessionContextUsageTitle } from '../../session-context-usage.js';
import ContextSparkline from '../sidebar/ContextSparkline.vue';
import { chatOriginLabel, formatChatFileSize, splitChatLinks } from '../../chat-view.js';
import { artifactsClient, dialogClient, systemClient } from '../../ipc/clients.js';
import type { Session } from '../../state.js';

const appStore = useAppStore();
const chat = useChatStore();
const sessionIds = computed(() => appStore.state.sessions
  .filter(session => !session.subagentOf)
  .map(session => session.id));
const visibleSessions = computed(() => appStore.state.sessions.filter(session => !session.subagentOf));
const selectedSession = computed(() => visibleSessions.value.find(session => session.id === chat.selectedSessionId));
const messages = computed(() => selectedSession.value ? chat.messagesFor(selectedSession.value.id) : []);
const thread = ref<HTMLElement | null>(null);
const search = ref('');

function projectLabel(session: Session): string {
  if (session.role === 'operator') return 'Helm';
  const project = appStore.state.projects.find(item =>
    item.id === session.projectId || item.canonicalPath === session.projectPath || item.canonicalPath === session.workingDir,
  );
  if (project) return project.name;
  const path = session.projectPath || session.workingDir;
  return path?.split(/[\\/]/).filter(Boolean).at(-1) || 'Other sessions';
}

const groups = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  const byProject = new Map<string, typeof visibleSessions.value>();
  for (const session of visibleSessions.value) {
    const mission = session.mission?.text ?? '';
    if (query && !`${session.name} ${session.cliType} ${session.workingDir ?? ''} ${mission}`.toLocaleLowerCase().includes(query)) continue;
    const label = projectLabel(session);
    const entries = byProject.get(label) ?? [];
    entries.push(session);
    byProject.set(label, entries);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, sessions]) => ({
      label,
      sessions: [...sessions].sort((a, b) => (b.lastOutputAt ?? b.createdAt ?? 0) - (a.lastOutputAt ?? a.createdAt ?? 0)),
    }));
});

const draft = computed({
  get: () => selectedSession.value ? chat.draftFor(selectedSession.value.id) : '',
  set: value => { if (selectedSession.value) chat.setDraft(selectedSession.value.id, value); },
});
const attachment = computed(() => selectedSession.value ? chat.attachmentFor(selectedSession.value.id) : null);
const selectedUsage = computed(() => selectedSession.value?.contextUsage);
const selectedContextLimits = computed(() => selectedSession.value
  ? resolveContextLimits(resolveCliTypeRecord(selectedSession.value.cliType), selectedUsage.value?.window)
  : undefined);
const selectedContextLevel = computed(() => selectedUsage.value
  ? contextLevel(selectedUsage.value.tokens, selectedContextLimits.value)
  : 'ok');
const contextLabel = computed(() => formatSessionContextUsage(selectedUsage.value));
const contextTitle = computed(() => {
  const usage = selectedUsage.value;
  if (!usage) return undefined;
  const title = sessionContextUsageTitle(usage);
  const limits = selectedContextLimits.value;
  return limits && title
    ? `${title} · amber ${limits.amber.toLocaleString()} · red ${limits.red.toLocaleString()}`
    : title;
});
const hasSendingMessage = computed(() => messages.value.some(message => message.status === 'sending'));
const canSend = computed(() => Boolean(selectedSession.value
  && !selectedSession.value.frozen
  && !hasSendingMessage.value
  && (draft.value.trim() || attachment.value)));

function activity(sessionId: string): string {
  return appStore.state.sessionActivityLevels.get(sessionId) ?? 'idle';
}

function sessionState(session: Session): string {
  return appStore.state.sessionStates.get(session.id) ?? session.aiagentState ?? session.state ?? 'idle';
}

function selectSession(sessionId: string): void {
  chat.selectSession(sessionId);
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function send(): void {
  if (selectedSession.value && canSend.value) void chat.send(selectedSession.value.id);
}

function onComposerKey(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  send();
}

async function pickAttachment(): Promise<void> {
  const path = await dialogClient.dialogShowOpenFile?.([{ name: 'All Files', extensions: ['*'] }]);
  if (path && selectedSession.value) chat.setAttachment(selectedSession.value.id, path);
}

function openExternal(url: string): void {
  void systemClient.systemOpenExternalUrl(url);
}

function openAttachment(message: ChatThreadMessage): void {
  const { artifactId, attachmentId } = message.record;
  if (artifactId && attachmentId) void artifactsClient.artifactOpenAttachment(artifactId, attachmentId);
}

function saveAttachment(message: ChatThreadMessage): void {
  const { artifactId, attachmentId } = message.record;
  if (artifactId && attachmentId) void artifactsClient.artifactSaveAttachment(artifactId, attachmentId);
}

function retry(message: ChatThreadMessage): void {
  if (selectedSession.value && message.record.originId) {
    void chat.retry(selectedSession.value.id, message.record.originId);
  }
}

watch(sessionIds, ids => {
  void chat.loadSessions(ids);
  if (chat.selectedSessionId && !ids.includes(chat.selectedSessionId)) {
    const replacement = appStore.state.activeSessionId && ids.includes(appStore.state.activeSessionId)
      ? appStore.state.activeSessionId
      : ids[0];
    if (replacement) selectSession(replacement);
  }
});

onMounted(() => { void chat.start(sessionIds.value, appStore.state.activeSessionId); });
onBeforeUnmount(() => chat.stop());
watch(() => [chat.selectedSessionId, messages.value.length], async () => {
  await nextTick();
  thread.value?.scrollTo({ top: thread.value.scrollHeight });
});
</script>

<template>
  <section class="chat-pane" aria-label="Chat">
    <aside class="chat-pane__sessions" aria-label="Sessions">
      <label class="chat-pane__search">
        <span aria-hidden="true">⌕</span>
        <input v-model="search" type="search" placeholder="Filter sessions" aria-label="Filter sessions" />
      </label>
      <div v-if="!visibleSessions.length" class="chat-pane__list-empty">No sessions</div>
      <div v-else-if="!groups.length" class="chat-pane__list-empty">No matching sessions</div>
      <section v-for="group in groups" :key="group.label" class="chat-pane__group">
        <h2>{{ group.label }}</h2>
        <button
          v-for="session in group.sessions"
          :key="session.id"
          class="chat-pane__session focusable"
          :class="{ 'chat-pane__session--selected': chat.selectedSessionId === session.id }"
          type="button"
          :aria-current="chat.selectedSessionId === session.id ? 'true' : undefined"
          @click="selectSession(session.id)"
        >
          <span class="chat-pane__activity" :style="{ backgroundColor: getActivityColor(activity(session.id)) }" :title="activity(session.id)" />
          <span class="chat-pane__session-copy">
            <span class="chat-pane__session-name">{{ session.role === 'operator' ? 'Helm (operator)' : session.name }}</span>
            <span class="chat-pane__mission">{{ session.mission?.text || 'No mission set' }}</span>
          </span>
          <span v-if="chat.unreadCount(session.id)" class="chat-pane__unread">{{ chat.unreadCount(session.id) }}</span>
        </button>
      </section>
    </aside>

    <div v-if="selectedSession" class="chat-pane__conversation">
      <header class="chat-pane__context">
        <div class="chat-pane__context-main">
          <strong>{{ selectedSession.name }}</strong>
          <span class="chat-pane__mission-line">{{ selectedSession.mission?.text || 'No mission set' }}</span>
          <span class="chat-pane__context-meta" :title="selectedSession.workingDir || selectedSession.projectPath">
            {{ selectedSession.projectPath || selectedSession.workingDir || 'No folder' }}
          </span>
        </div>
        <div class="chat-pane__context-details">
          <span>{{ getCliDisplayName(selectedSession.cliType) }}</span>
          <span class="chat-pane__context-usage" :class="`chat-pane__context-usage--${selectedContextLevel}`" :title="contextTitle">
            <ContextSparkline
              :samples="selectedSession.contextHistory"
              :window="selectedUsage?.window"
              :limits="selectedContextLimits"
              :width="72"
              :height="20"
            />
            {{ contextLabel || 'Context unavailable' }}
          </span>
          <span class="chat-pane__state"><i :style="{ backgroundColor: getActivityColor(activity(selectedSession.id)) }" />{{ activity(selectedSession.id) }} · {{ sessionState(selectedSession) }}</span>
        </div>
      </header>

      <div ref="thread" class="chat-pane__thread" aria-live="polite">
        <div v-if="chat.historyErrorFor(selectedSession.id)" class="chat-pane__history-error" role="alert">
          Chat history could not be loaded: {{ chat.historyErrorFor(selectedSession.id) }}
        </div>
        <div v-if="!messages.length" class="chat-pane__empty">No messages yet.</div>
        <article
          v-for="message in messages"
          :key="message.id"
          class="chat-pane__message"
          :class="{ 'chat-pane__message--user': chatOriginLabel(message.record), 'chat-pane__message--failed': message.status === 'failed' }"
        >
          <span v-if="chatOriginLabel(message.record)" class="chat-pane__origin">{{ chatOriginLabel(message.record) }}</span>
          <p class="chat-pane__text">
            <template v-for="(segment, index) in splitChatLinks(message.record.text)" :key="`${message.id}:${index}`">
              <a v-if="segment.href" :href="segment.href" @click.prevent="openExternal(segment.href)">{{ segment.text }}</a>
              <template v-else>{{ segment.text }}</template>
            </template>
          </p>
          <button
            v-if="message.record.filePath || message.record.filename"
            class="chat-pane__file focusable"
            type="button"
            :disabled="!message.record.artifactId || !message.record.attachmentId"
            @click="openAttachment(message)"
          >
            <span class="chat-pane__file-icon">{{ message.record.mimeType?.startsWith('image/') ? '▧' : '▤' }}</span>
            <span class="chat-pane__file-copy">
              <strong>{{ message.record.filename || message.record.filePath?.split(/[\\/]/).at(-1) }}</strong>
              <small>{{ formatChatFileSize(message.record.sizeBytes) || message.record.mimeType || 'Attachment' }}</small>
            </span>
            <span v-if="message.record.artifactId && message.record.attachmentId" class="chat-pane__file-save" @click.stop="saveAttachment(message)">Save</span>
          </button>
          <footer class="chat-pane__message-meta">
            <time :datetime="new Date(message.record.at).toISOString()">{{ time(message.record.at) }}</time>
            <span v-if="message.status === 'sending'">Sending…</span>
            <span v-else-if="message.status === 'sent'">Sent</span>
            <button v-else-if="message.status === 'failed'" type="button" @click="retry(message)">Failed · retry</button>
          </footer>
          <span v-if="message.error" class="chat-pane__error">{{ message.error }}</span>
        </article>
      </div>

      <div v-if="selectedSession.frozen" class="chat-pane__frozen" role="status">This session is frozen and cannot receive messages.</div>
      <div v-if="attachment" class="chat-pane__selected-file">
        <span>📎 {{ attachment.split(/[\\/]/).at(-1) }}</span>
        <button type="button" aria-label="Remove attachment" @click="chat.setAttachment(selectedSession.id, null)">×</button>
      </div>
      <form class="chat-pane__composer" @submit.prevent="send">
        <button class="btn btn--sm btn--secondary focusable" type="button" title="Attach a file" @click="pickAttachment">📎</button>
        <textarea v-model="draft" class="chat-pane__input" rows="2" :placeholder="`Message ${selectedSession.name}…`" @keydown="onComposerKey" />
        <button class="btn btn--sm btn--primary focusable" type="submit" :disabled="!canSend">Send</button>
      </form>
      <div class="chat-pane__hint">Enter to send · Shift+Enter for a new line · Draft is kept per session</div>
    </div>

    <div v-else class="chat-pane__no-selection">Select a session to view its chat.</div>
  </section>
</template>

<style scoped>
.chat-pane {
  display: grid;
  grid-template-columns: minmax(190px, 260px) minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  color: var(--text-primary);
  background: var(--bg-primary);
  font-size: var(--font-size-sm);
}

.chat-pane__sessions {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: var(--spacing-sm);
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
}

.chat-pane__search {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin: 0 0 var(--spacing-sm);
  padding: 0 var(--spacing-sm);
  color: var(--text-dim);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.chat-pane__search input {
  width: 100%;
  min-width: 0;
  padding: var(--spacing-sm) 0;
  color: var(--text-primary);
  background: transparent;
  border: 0;
  outline: none;
}

.chat-pane__group + .chat-pane__group { margin-top: var(--spacing-md); }
.chat-pane__group h2 { margin: var(--spacing-sm) var(--spacing-sm) var(--spacing-xs); color: var(--accent); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.chat-pane__session { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-sm); width: 100%; padding: var(--spacing-sm); color: inherit; text-align: left; background: transparent; border: 0; border-left: 3px solid transparent; border-radius: var(--radius-sm); cursor: pointer; }
.chat-pane__session:hover { background: var(--bg-tertiary); }
.chat-pane__session--selected { background: var(--bg-tertiary); border-left-color: var(--accent); }
.chat-pane__activity, .chat-pane__state i { width: 8px; height: 8px; border-radius: 50%; }
.chat-pane__session-copy { display: grid; min-width: 0; gap: 2px; }
.chat-pane__session-name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.chat-pane__mission { overflow: hidden; color: var(--text-dim); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.chat-pane__unread { min-width: 18px; padding: 1px 5px; color: var(--bg-primary); font-size: 10px; font-weight: 700; text-align: center; background: var(--accent); border-radius: 10px; }
.chat-pane__list-empty { padding: var(--spacing-md); color: var(--text-dim); text-align: center; }

.chat-pane__conversation { display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto auto; min-width: 0; min-height: 0; }
.chat-pane__context { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-sm) var(--spacing-md); background: var(--bg-secondary); border-bottom: 1px solid var(--border); }
.chat-pane__context-main, .chat-pane__context-details { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.chat-pane__context-main strong { font-size: var(--font-size-md); }
.chat-pane__mission-line, .chat-pane__context-meta { overflow: hidden; color: var(--text-secondary); text-overflow: ellipsis; white-space: nowrap; }
.chat-pane__context-meta { max-width: min(52vw, 660px); color: var(--text-dim); font-size: 11px; }
.chat-pane__context-details { align-items: flex-end; flex: 0 0 auto; color: var(--text-secondary); font-size: 11px; }
.chat-pane__context-usage, .chat-pane__state { display: inline-flex; align-items: center; gap: 5px; }
.chat-pane__context-usage--warn { color: var(--status-blocked); }
.chat-pane__context-usage--hot { color: var(--danger); }
.chat-pane__state i { display: inline-block; }

.chat-pane__thread { display: flex; min-height: 0; flex-direction: column; gap: var(--spacing-sm); overflow: auto; padding: var(--spacing-md); }
.chat-pane__history-error { padding: var(--spacing-sm) var(--spacing-md); color: var(--danger); background: var(--bg-secondary); border-radius: var(--radius-sm); }
.chat-pane__empty, .chat-pane__no-selection { display: grid; place-items: center; color: var(--text-dim); }
.chat-pane__no-selection { grid-column: 2; }
.chat-pane__message { max-width: min(76%, 860px); padding: var(--spacing-sm) var(--spacing-md); overflow-wrap: anywhere; line-height: 1.4; white-space: pre-wrap; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 12px; border-bottom-left-radius: 3px; }
.chat-pane__message--user { align-self: flex-end; background: color-mix(in srgb, var(--accent) 12%, var(--bg-secondary)); border-color: color-mix(in srgb, var(--accent) 28%, var(--border)); border-bottom-right-radius: 3px; border-bottom-left-radius: 12px; }
.chat-pane__message--failed { border-color: var(--danger); }
.chat-pane__origin { color: var(--text-dim); font-size: 10px; }
.chat-pane__text { margin: 0; }
.chat-pane__text a { color: var(--accent); text-decoration: underline; }
.chat-pane__message-meta { display: flex; justify-content: flex-end; gap: var(--spacing-xs); margin-top: 4px; color: var(--text-dim); font-size: 10px; }
.chat-pane__message-meta button { padding: 0; color: var(--danger); background: none; border: 0; cursor: pointer; }
.chat-pane__error { display: block; margin-top: 4px; color: var(--danger); font-size: 11px; }
.chat-pane__file { display: flex; align-items: center; gap: var(--spacing-sm); width: min(100%, 330px); margin-top: var(--spacing-sm); padding: var(--spacing-sm); color: inherit; text-align: left; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.chat-pane__file:disabled { opacity: 1; cursor: default; }
.chat-pane__file-icon { font-size: 18px; }
.chat-pane__file-copy { display: grid; min-width: 0; flex: 1; gap: 2px; }
.chat-pane__file-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-pane__file-copy small { color: var(--text-dim); }
.chat-pane__file-save { color: var(--accent); }
.chat-pane__frozen { padding: 5px var(--spacing-md); color: var(--text-secondary); background: var(--bg-tertiary); }
.chat-pane__selected-file { display: flex; align-items: center; justify-content: space-between; padding: 4px var(--spacing-md); color: var(--text-secondary); background: var(--bg-secondary); }
.chat-pane__selected-file button { color: var(--text-secondary); background: transparent; border: 0; cursor: pointer; }
.chat-pane__composer { display: flex; align-items: flex-end; gap: var(--spacing-sm); padding: var(--spacing-sm); border-top: 1px solid var(--border); }
.chat-pane__input { flex: 1; min-width: 0; min-height: 40px; max-height: 220px; padding: var(--spacing-sm) var(--spacing-md); color: var(--text-primary); font: inherit; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); resize: vertical; }
.chat-pane__hint { padding: 0 var(--spacing-md) var(--spacing-xs); color: var(--text-dim); font-size: 10px; }

@media (max-width: 680px) {
  .chat-pane { grid-template-columns: minmax(145px, 36%) minmax(0, 1fr); }
  .chat-pane__context { align-items: flex-start; flex-direction: column; gap: var(--spacing-xs); }
  .chat-pane__context-details { align-items: flex-start; flex-direction: row; flex-wrap: wrap; }
  .chat-pane__message { max-width: 92%; }
}
</style>
