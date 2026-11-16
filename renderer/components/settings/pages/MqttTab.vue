<script setup lang="ts">
/**
 * MQTT triggers — broker connection and topic → prompt rules.
 * The broker password is write-only here: the page only learns whether one is set.
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import AppButton from '../../common/AppButton.vue';
import Badge from '../../common/Badge.vue';
import EmptyState from '../../common/EmptyState.vue';
import SettingsCard from '../primitives/SettingsCard.vue';
import FieldRow from '../primitives/FieldRow.vue';
import ToggleRow from '../primitives/ToggleRow.vue';
import { eventsClient, mqttClient, projectsClient } from '../../../ipc/clients.js';
import { useAppStore } from '../../../stores/app.js';
import { getCliDisplayName } from '../../../utils.js';
import type { MqttRule, MqttSnapshot, CreateMqttRuleParams } from '../../../../src/types/mqtt-trigger.js';
import type { ProjectRecord } from '../../../../src/types/project.js';

const appStore = useAppStore();
const snapshot = ref<MqttSnapshot | null>(null);
const projects = ref<ProjectRecord[]>([]);
const error = ref('');

const broker = reactive({ enabled: false, url: '', username: '', password: '' });
const rule = reactive({
  name: '', topic: '', prompt: '',
  targetKind: 'session' as 'session' | 'spawn',
  sessionId: '', cliType: '', dirPath: '', reuse: true, intervalSec: 5,
});

const STATUS_TONE = { connected: 'ok', connecting: 'warn', error: 'error', disabled: 'neutral' } as const;
const statusTone = computed(() => STATUS_TONE[snapshot.value?.status ?? 'disabled']);
const sessions = computed(() => appStore.state.sessions.filter(session => !session.remote));
const cliTypes = computed(() => appStore.state.availableSpawnTypes.length ? appStore.state.availableSpawnTypes : appStore.state.cliTypes);
const canCreate = computed(() => rule.name.trim() && rule.topic.trim() && rule.prompt.trim()
  && (rule.targetKind === 'session' ? rule.sessionId : rule.cliType && rule.dirPath));

let offChanged: (() => void) | null = null;

function apply(next: MqttSnapshot): void {
  snapshot.value = next;
  broker.enabled = next.broker.enabled;
  broker.url = next.broker.url;
  broker.username = next.broker.username ?? '';
}

async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
  error.value = '';
  try { return await action(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); return undefined; }
}

async function saveBroker(): Promise<void> {
  const next = await run(() => mqttClient.mqttSetBroker({
    enabled: broker.enabled,
    url: broker.url.trim(),
    username: broker.username.trim(),
    // Blank keeps the stored password.
    ...(broker.password ? { password: broker.password } : {}),
  }));
  if (next) { apply(next); broker.password = ''; }
}

async function clearPassword(): Promise<void> {
  const next = await run(() => mqttClient.mqttSetBroker({ password: '' }));
  if (next) apply(next);
}

async function createRule(): Promise<void> {
  const params: CreateMqttRuleParams = {
    name: rule.name.trim(),
    topic: rule.topic.trim(),
    prompt: rule.prompt,
    target: rule.targetKind === 'session'
      ? { kind: 'session', sessionId: rule.sessionId }
      : { kind: 'spawn', cliType: rule.cliType, dirPath: rule.dirPath, reuse: rule.reuse },
    minIntervalMs: Math.max(0, rule.intervalSec) * 1000,
  };
  if (await run(() => mqttClient.mqttCreateRule(params))) {
    Object.assign(rule, { name: '', topic: '', prompt: '' });
  }
}

function setEnabled(target: MqttRule, enabled: boolean): void {
  void run(() => mqttClient.mqttUpdateRule(target.id, { enabled }));
}

function deleteRule(target: MqttRule): void {
  void run(() => mqttClient.mqttDeleteRule(target.id));
}

function targetLabel(target: MqttRule['target']): string {
  if (target.kind === 'session') {
    return `→ ${sessions.value.find(session => session.id === target.sessionId)?.name ?? 'closed session'}`;
  }
  return `→ new ${getCliDisplayName(target.cliType)} in ${target.dirPath}${target.reuse ? ' (reused)' : ''}`;
}

onMounted(async () => {
  offChanged = eventsClient.onMqttChanged(apply);
  const initial = await run(() => mqttClient.mqttGet());
  if (initial) apply(initial);
  projects.value = await projectsClient.projectList().catch(() => []) ?? [];
});

onUnmounted(() => offChanged?.());
</script>

<template>
  <div class="mqtt-tab settings-sections">
    <p class="mqtt-intro">
      React to MQTT messages (Home Assistant, Timbre, sensors): a message on a matching topic becomes a prompt
      in a session. Payload values arrive quoted, as untrusted data.
    </p>
    <p v-if="error" class="mqtt-error" role="alert">{{ error }}</p>

    <SettingsCard title="Broker" class="settings-span">
      <template #actions>
        <Badge :tone="statusTone">{{ snapshot?.status ?? 'disabled' }}</Badge>
      </template>
      <ToggleRow v-model="broker.enabled" label="Connect to the broker" />
      <FieldRow label="URL" for="mqtt-url">
        <input id="mqtt-url" v-model="broker.url" class="input focusable" placeholder="mqtt://homeassistant.local:1883" />
      </FieldRow>
      <FieldRow label="Username" for="mqtt-user">
        <input id="mqtt-user" v-model="broker.username" class="input focusable" autocomplete="off" />
      </FieldRow>
      <FieldRow label="Password" :hint="snapshot?.broker.hasPassword ? 'Set — leave blank to keep it.' : undefined" for="mqtt-pass">
        <input id="mqtt-pass" v-model="broker.password" class="input focusable" type="password" autocomplete="new-password" />
        <AppButton v-if="snapshot?.broker.hasPassword" variant="ghost" size="sm" class="focusable" @click="clearPassword">Clear</AppButton>
      </FieldRow>
      <div class="mqtt-actions">
        <AppButton variant="primary" class="focusable" :disabled="!broker.url.trim()" @click="saveBroker">Save &amp; connect</AppButton>
      </div>
    </SettingsCard>

    <SettingsCard title="Rules" class="settings-span">
      <EmptyState v-if="!snapshot?.rules.length" title="No rules yet" compact />
      <div v-for="item in snapshot?.rules ?? []" :key="item.id" class="mqtt-rule">
        <div class="mqtt-rule__head">
          <strong>{{ item.name }}</strong>
          <code>{{ item.topic }}</code>
          <span class="mqtt-rule__target">{{ targetLabel(item.target) }}</span>
          <span class="mqtt-rule__spacer"></span>
          <ToggleRow :model-value="item.enabled" label="Enabled" @update:model-value="setEnabled(item, $event)" />
          <AppButton variant="danger" size="sm" class="focusable" :aria-label="`Delete ${item.name}`" @click="deleteRule(item)">Delete</AppButton>
        </div>
        <p class="mqtt-rule__prompt">{{ item.prompt }}</p>
      </div>
    </SettingsCard>

    <SettingsCard title="Add rule" class="settings-span">
      <FieldRow label="Name" for="mqtt-rule-name">
        <input id="mqtt-rule-name" v-model="rule.name" class="input focusable" placeholder="Doorbell" />
      </FieldRow>
      <FieldRow label="Topic" hint="+ matches one level, # the rest." for="mqtt-rule-topic">
        <input id="mqtt-rule-topic" v-model="rule.topic" class="input focusable" placeholder="timbre/+/call/agent_question" />
      </FieldRow>
      <FieldRow label="Prompt" hint="{topic}, {payload}, {payload.a.b}" for="mqtt-rule-prompt">
        <textarea id="mqtt-rule-prompt" v-model="rule.prompt" class="input focusable mqtt-prompt" rows="3"></textarea>
      </FieldRow>
      <FieldRow label="Send to" for="mqtt-rule-kind">
        <select id="mqtt-rule-kind" v-model="rule.targetKind" class="app-select app-select--secondary focusable">
          <option value="session">An existing session</option>
          <option value="spawn">A new session</option>
        </select>
      </FieldRow>
      <FieldRow v-if="rule.targetKind === 'session'" label="Session" for="mqtt-rule-session">
        <select id="mqtt-rule-session" v-model="rule.sessionId" class="app-select app-select--secondary focusable">
          <option value="" disabled>Pick a session</option>
          <option v-for="session in sessions" :key="session.id" :value="session.id">{{ session.name }}</option>
        </select>
      </FieldRow>
      <template v-else>
        <FieldRow label="CLI" for="mqtt-rule-cli">
          <select id="mqtt-rule-cli" v-model="rule.cliType" class="app-select app-select--secondary focusable">
            <option value="" disabled>Pick a CLI</option>
            <option v-for="cli in cliTypes" :key="cli" :value="cli">{{ getCliDisplayName(cli) }}</option>
          </select>
        </FieldRow>
        <FieldRow label="Folder" for="mqtt-rule-dir">
          <select id="mqtt-rule-dir" v-model="rule.dirPath" class="app-select app-select--secondary focusable">
            <option value="" disabled>Pick a project folder</option>
            <option v-for="project in projects" :key="project.id" :value="project.canonicalPath">{{ project.name }}</option>
          </select>
        </FieldRow>
        <ToggleRow v-model="rule.reuse" label="Reuse the session this rule spawned" />
      </template>
      <FieldRow label="Min seconds between triggers" for="mqtt-rule-interval">
        <input id="mqtt-rule-interval" v-model.number="rule.intervalSec" class="input focusable mqtt-interval" type="number" min="0" />
      </FieldRow>
      <div class="mqtt-actions">
        <AppButton variant="primary" class="focusable" :disabled="!canCreate" @click="createRule">Add rule</AppButton>
      </div>
    </SettingsCard>
  </div>
</template>

<style scoped>
.mqtt-intro { color: var(--text-secondary); font-size: var(--font-size-sm); margin: 0; }
.mqtt-error { color: var(--danger); font-size: var(--font-size-sm); margin: 0; }
.mqtt-actions { display: flex; justify-content: flex-end; padding-top: var(--spacing-sm); }
.mqtt-prompt { width: 100%; resize: vertical; font-family: inherit; }
.mqtt-interval { width: 6em; }
.mqtt-rule { padding: var(--spacing-sm) 0; border-bottom: 1px solid var(--border); }
.mqtt-rule:last-child { border-bottom: none; }
.mqtt-rule__head { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; font-size: var(--font-size-sm); }
.mqtt-rule__target { color: var(--text-secondary); }
.mqtt-rule__spacer { flex: 1; }
.mqtt-rule__prompt { margin: var(--spacing-xs) 0 0; color: var(--text-secondary); font-size: var(--font-size-sm); white-space: pre-wrap; }
</style>
