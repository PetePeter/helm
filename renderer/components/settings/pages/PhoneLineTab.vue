<script setup lang="ts">
/**
 * PhoneLineTab.vue: a real phone line through telefony-app (docs/phone-line.md).
 * Helm launches telefony, writes its TOML from these settings, and routes
 * allowed calls and SMS to the operator. Every number gets per-action switches.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { phoneClient } from '../../../ipc/clients.js';
import { trackSave } from '../../../composables/useAutosave.js';
import {
  DEFAULT_PHONE_LINE_CONFIG, type PhoneContact, type PhoneLineConfig,
} from '../../../../src/phone/phone-config.js';
import type { PhoneLineStatus } from '../../../../src/phone/phone-line-service.js';

const cfg = ref<PhoneLineConfig>(structuredClone(DEFAULT_PHONE_LINE_CONFIG));
const status = ref<PhoneLineStatus | null>(null);
const message = ref('');
let offStatus: (() => void) | null = null;
let offProgress: (() => void) | null = null;

// telefony-app install / update from its GitHub releases (src/phone/telefony-installer.ts).
const telefony = ref<{ installed: string | null; latest: { version: string; size?: number } | null } | null>(null);
const installPercent = ref<number | null>(null);
const installLabel = computed(() => {
  const t = telefony.value;
  if (installPercent.value !== null) return `Downloading… ${installPercent.value}%`;
  if (!t?.latest) return 'No release published yet';
  if (t.installed === t.latest.version) return `Up to date (${t.installed})`;
  return t.installed ? `Update to ${t.latest.version}` : `Install telefony-app ${t.latest.version}`;
});
const canInstall = computed(() => installPercent.value === null && !!telefony.value?.latest && telefony.value.installed !== telefony.value.latest.version);

async function checkTelefony(): Promise<void> {
  const r = await phoneClient.phoneTelefonyCheck();
  telefony.value = r.success ? r.value : null;
}

async function installTelefony(): Promise<void> {
  installPercent.value = 0;
  try {
    const r = await phoneClient.phoneTelefonyInstall();
    message.value = r.success ? `Installed telefony-app ${r.value.version}` : r.error ?? 'Install failed';
    cfg.value = await phoneClient.phoneGetConfig();
  } finally {
    installPercent.value = null;
    await checkTelefony();
  }
}

onMounted(async () => {
  cfg.value = await phoneClient.phoneGetConfig();
  status.value = await phoneClient.phoneGetStatus();
  offStatus = phoneClient.onPhoneStatus((s: PhoneLineStatus) => { status.value = s; });
  offProgress = phoneClient.onPhoneTelefonyProgress((p: { percent: number }) => { installPercent.value = p.percent; });
  void checkTelefony();
});
onBeforeUnmount(() => { offStatus?.(); offProgress?.(); });

function save(): Promise<boolean> {
  return trackSave(async () => {
    const result = await phoneClient.phoneSetConfig(JSON.parse(JSON.stringify(cfg.value)));
    if (!result.success) {
      cfg.value = await phoneClient.phoneGetConfig();
      throw new Error(result.error ?? 'Could not save setting');
    }
    cfg.value = result.value;
  });
}

const CONTACT_SWITCHES: Array<{ key: keyof PhoneContact; label: string }> = [
  { key: 'callIn', label: 'Call in' },
  { key: 'callOut', label: 'Call out' },
  { key: 'smsIn', label: 'SMS in' },
  { key: 'smsOut', label: 'SMS out' },
  { key: 'conf', label: 'Conf' },
];

function addContact(): void {
  cfg.value.contacts.push({ label: '', pattern: '', role: 'trusted', callIn: true, callOut: false, smsIn: true, smsOut: false, conf: false });
}
function removeContact(i: number): void {
  cfg.value.contacts.splice(i, 1);
  void save();
}

async function run(action: () => Promise<{ success: boolean; error?: string }>, ok: string): Promise<void> {
  const r = await action();
  message.value = r.success ? ok : r.error ?? 'Failed';
}

const processLine = computed(() => {
  const p = status.value?.process;
  if (!p) return { dot: 'off', text: 'Unknown' };
  switch (p.state) {
    case 'running': return { dot: 'ok', text: `Running · pid ${p.pid} · ${p.restarts} restarts` };
    case 'backoff': return { dot: 'warn', text: `Restarting in ${Math.round(p.restartInMs / 1000)}s (attempt ${p.attempt}): ${p.lastError}` };
    case 'failed': return { dot: 'err', text: `Stopped: ${p.lastError}` };
    default: return { dot: 'off', text: cfg.value.enabled ? 'Not started — set the executable and transport' : 'Phone line off' };
  }
});
const lineText = computed(() => {
  const l = status.value?.line;
  if (!l) return { dot: 'off', text: 'Not connected' };
  // telefony opens its PhAP port only once the phone connects over Bluetooth.
  if (!l.connected) return { dot: 'warn', text: status.value?.process.state === 'running' ? 'Waiting for the phone to connect over Bluetooth…' : 'Waiting for telefony-app…' };
  return { dot: l.link === 'down' ? 'warn' : 'ok', text: `Connected as controller · phone link ${l.link}` };
});

const num = (e: Event) => Number((e.target as HTMLInputElement).value);
const str = (e: Event) => (e.target as HTMLInputElement).value;
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
</script>

<template>
  <div class="settings-phone-panel settings-sections">
    <div class="settings-panel__header settings-span">
      <span class="settings-panel__title">Phone line</span>
    </div>
    <div class="settings-help settings-span">
      <p>A real phone line through <strong>telefony-app</strong>. Helm launches it, keeps it running, and sends allowed calls and SMS to the operator.
        Sessions see contact labels, never numbers.</p>
    </div>

    <label class="phone-setting settings-span">
      <input type="checkbox" class="focusable" :checked="cfg.enabled" @change="cfg.enabled = checked($event); save()" />
      <span>Enable phone line</span>
    </label>

    <!-- Process + connection -->
    <div class="field-group">
      <label class="field-label">telefony-app executable</label>
      <input class="field-input focusable" :value="cfg.executable" placeholder="…\telefony-app\.venv\Scripts\telefony-app.exe" @change="cfg.executable = str($event); save()" />
      <button class="btn btn--secondary btn--sm focusable" :disabled="!canInstall" @click="installTelefony">{{ installLabel }}</button>
    </div>
    <div class="field-group">
      <label class="field-label">Bluetooth transport</label>
      <input class="field-input focusable" :value="cfg.transport" placeholder="usb:10D7:B012+sco=2" @change="cfg.transport = str($event); save()" />
    </div>
    <div class="field-group">
      <label class="field-label">PhAP port (127.0.0.1)</label>
      <input class="field-input focusable" type="number" :value="cfg.port" @change="cfg.port = num($event); save()" />
    </div>
    <div class="field-group">
      <label class="field-label">Country code (for national numbers)</label>
      <input class="field-input focusable" :value="cfg.countryCode" @change="cfg.countryCode = str($event); save()" />
    </div>
    <label class="phone-setting">
      <input type="checkbox" class="focusable" :checked="cfg.watchdog" @change="cfg.watchdog = checked($event); save()" />
      <span>Restart telefony if it crashes</span>
    </label>
    <label class="phone-setting">
      <span>Calls Helm doesn't take</span>
      <select class="btn btn--secondary btn--sm focusable" :value="cfg.ringFallback" @change="cfg.ringFallback = str($event) as 'ring' | 'reject'; save()">
        <option value="ring">Let the phone ring</option>
        <option value="reject">Reject</option>
      </select>
    </label>

    <!-- Status -->
    <div class="settings-panel__header settings-span"><span class="settings-panel__title">Status</span></div>
    <dl class="phone-status settings-span">
      <dt>Process</dt><dd><span class="phone-dot" :class="`phone-dot--${processLine.dot}`" />{{ processLine.text }}</dd>
      <dt>PhAP</dt><dd><span class="phone-dot" :class="`phone-dot--${lineText.dot}`" />{{ lineText.text }}</dd>
      <template v-if="status?.line?.call">
        <dt>Live call</dt><dd>{{ status.line.call.label }} · {{ status.line.call.state }} · with {{ status.line.call.sessionName }}</dd>
      </template>
      <template v-if="status?.pendingRestart">
        <dt>Restart</dt><dd>Waiting for the call to end</dd>
      </template>
      <template v-if="status?.line">
        <dt>Last hour</dt><dd>Calls out {{ status.line.usage.callsLastHour }}/{{ cfg.limits.callsPerHour }} · SMS out {{ status.line.usage.smsLastHour }}/{{ cfg.limits.smsPerHour }}</dd>
      </template>
    </dl>
    <div class="phone-actions settings-span">
      <button class="btn btn--secondary btn--sm focusable" @click="run(phoneClient.phoneRestart, 'Restarted')">Restart telefony</button>
      <button class="btn btn--secondary btn--sm focusable" @click="run(phoneClient.phoneTestRing, 'Ringing the owner')">Test: ring me</button>
      <button class="btn btn--secondary btn--sm focusable" @click="run(phoneClient.phoneTestSms, 'Text sent')">Test: SMS me</button>
      <span class="phone-message">{{ message }}</span>
    </div>
    <ul v-if="status?.line?.decisions.length" class="phone-log settings-span">
      <li v-for="d in status.line.decisions.slice(0, 8)" :key="d.at + d.action">
        {{ new Date(d.at).toLocaleTimeString() }} {{ d.action }} {{ d.who }} → {{ d.allowed ? 'allow' : `deny (${d.reason})` }}
      </li>
    </ul>

    <!-- Master switches -->
    <div class="settings-panel__header settings-span"><span class="settings-panel__title">Master switches</span></div>
    <div class="phone-switches settings-span">
      <label class="phone-setting"><input type="checkbox" class="focusable" :checked="cfg.masters.callIn" @change="cfg.masters.callIn = checked($event); save()" /><span>Incoming calls</span></label>
      <label class="phone-setting"><input type="checkbox" class="focusable" :checked="cfg.masters.callOut" @change="cfg.masters.callOut = checked($event); save()" /><span>Outgoing calls</span></label>
      <label class="phone-setting"><input type="checkbox" class="focusable" :checked="cfg.masters.smsIn" @change="cfg.masters.smsIn = checked($event); save()" /><span>Incoming SMS</span></label>
      <label class="phone-setting"><input type="checkbox" class="focusable" :checked="cfg.masters.smsOut" @change="cfg.masters.smsOut = checked($event); save()" /><span>Outgoing SMS</span></label>
      <label class="phone-setting"><input type="checkbox" class="focusable" :checked="cfg.masters.conference" @change="cfg.masters.conference = checked($event); save()" /><span>Conference calls</span></label>
    </div>

    <div class="field-group">
      <label class="field-label">Owner PIN (4-12 digits; blank = caller ID is enough)</label>
      <input class="field-input focusable" type="password" inputmode="numeric" autocomplete="off" :value="cfg.ownerPin" @change="cfg.ownerPin = str($event); save()" />
    </div>
    <div class="settings-help">
      <p>Caller ID can be faked. With a PIN set, an incoming call from the owner number stays a guest until the PIN is keyed, then <code>#</code>.
        Dial it in one go as <code>number,PIN#</code>. Three wrong tries lock the call. Calls Helm places to you need no PIN.</p>
    </div>

    <!-- Numbers -->
    <div class="settings-panel__header settings-span"><span class="settings-panel__title">Numbers</span></div>
    <div class="settings-help settings-span">
      <p>Only listed numbers get through; withheld numbers never do. A trailing <code>*</code> is a prefix match (Helm only — telefony itself takes exact numbers).
        A blocked entry always wins. <strong>owner</strong> drives the operator; <strong>trusted</strong> can only leave a message.</p>
    </div>
    <table class="phone-contacts settings-span">
      <thead>
        <tr><th>Label</th><th>Number</th><th v-for="s in CONTACT_SWITCHES" :key="s.key">{{ s.label }}</th><th>Role</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="(c, i) in cfg.contacts" :key="i">
          <td><input class="field-input focusable" :value="c.label" placeholder="Me" @change="c.label = str($event); save()" /></td>
          <td><input class="field-input focusable phone-mono" :value="c.pattern" placeholder="+61…" @change="c.pattern = str($event); save()" /></td>
          <td v-for="s in CONTACT_SWITCHES" :key="s.key" class="phone-center">
            <input type="checkbox" class="focusable" :disabled="c.role === 'blocked'" :checked="c[s.key] as boolean" @change="(c[s.key] as boolean) = checked($event); save()" />
          </td>
          <td>
            <select class="btn btn--secondary btn--sm focusable" :value="c.role" @change="c.role = str($event) as PhoneContact['role']; save()">
              <option value="owner">owner</option>
              <option value="trusted">trusted</option>
              <option value="blocked">blocked</option>
            </select>
          </td>
          <td><button class="btn btn--secondary btn--sm focusable" title="Remove" @click="removeContact(i)">✕</button></td>
        </tr>
      </tbody>
    </table>
    <div class="phone-actions settings-span">
      <button class="btn btn--secondary btn--sm focusable" @click="addContact">+ Add number</button>
    </div>

    <!-- Persona + voice -->
    <div class="settings-panel__header settings-span"><span class="settings-panel__title">Assistant</span></div>
    <div class="field-group">
      <label class="field-label">Assistant name</label>
      <input class="field-input focusable" :value="cfg.persona.name" @change="cfg.persona.name = str($event); save()" />
    </div>
    <label class="phone-setting">
      <input type="checkbox" class="focusable" :checked="cfg.persona.discloseAi" @change="cfg.persona.discloseAi = checked($event); save()" />
      <span>Say it's an AI assistant to anyone but the owner</span>
    </label>
    <label class="phone-setting">
      <input type="checkbox" class="focusable" :checked="cfg.persona.greetIn" @change="cfg.persona.greetIn = checked($event); save()" />
      <span>Greet when answering</span>
    </label>
    <div class="field-group">
      <label class="field-label">Answering greeting</label>
      <input class="field-input focusable" :value="cfg.persona.greetInText" @change="cfg.persona.greetInText = str($event); save()" />
    </div>
    <label class="phone-setting">
      <input type="checkbox" class="focusable" :checked="cfg.persona.greetOut" @change="cfg.persona.greetOut = checked($event); save()" />
      <span>Greet when calling out</span>
    </label>
    <div class="field-group">
      <label class="field-label">Calling greeting</label>
      <input class="field-input focusable" :value="cfg.persona.greetOutText" @change="cfg.persona.greetOutText = str($event); save()" />
    </div>
    <div class="settings-help settings-span"><p>Tokens: <code>{name}</code> <code>{caller}</code> <code>{owner}</code> <code>{reason}</code> <code>{time}</code></p></div>
    <label class="phone-setting">
      <input type="checkbox" class="focusable" :checked="cfg.persona.signSms" @change="cfg.persona.signSms = checked($event); save()" />
      <span>Sign SMS replies with the name</span>
    </label>
    <label class="phone-setting">
      <span>Text to speech</span>
      <select class="btn btn--secondary btn--sm focusable" :value="cfg.voice.tts" @change="cfg.voice.tts = str($event) as PhoneLineConfig['voice']['tts']; save()">
        <option value="auto">auto</option><option value="piper">Piper</option><option value="sapi">Windows SAPI</option><option value="none">none (SMS only)</option>
      </select>
    </label>
    <div class="field-group">
      <label class="field-label">Piper voice model (.onnx; piper must be on PATH)</label>
      <input class="field-input focusable" :value="cfg.voice.piperModel" @change="cfg.voice.piperModel = str($event); save()" />
    </div>
    <label class="phone-setting">
      <span>Speech to text (faster-whisper)</span>
      <select class="btn btn--secondary btn--sm focusable" :value="cfg.voice.sttModel" @change="cfg.voice.sttModel = str($event); save()">
        <option value="">off (models download ~500 MB on first use)</option>
        <option v-for="m in ['tiny.en', 'base.en', 'small.en', 'medium.en']" :key="m" :value="m">{{ m }}</option>
      </select>
    </label>

    <!-- SMS, limits, fallback -->
    <div class="settings-panel__header settings-span"><span class="settings-panel__title">SMS, limits and fallback</span></div>
    <label class="phone-setting">
      <span>Sessions may read</span>
      <select class="btn btn--secondary btn--sm focusable" :value="cfg.smsRead.scope" @change="cfg.smsRead.scope = str($event) as PhoneLineConfig['smsRead']['scope']; save()">
        <option value="none">Nothing</option>
        <option value="received">Only SMS Helm received</option>
        <option value="window">The last N minutes</option>
        <option value="all">The whole inbox</option>
      </select>
    </label>
    <div class="field-group">
      <label class="field-label">Window (minutes)</label>
      <input class="field-input focusable" type="number" :value="cfg.smsRead.windowMin" @change="cfg.smsRead.windowMin = num($event); save()" />
    </div>
    <label class="phone-setting">
      <input type="checkbox" class="focusable" :checked="cfg.smsRead.maskOtp" @change="cfg.smsRead.maskOtp = checked($event); save()" />
      <span>Mask one-time codes</span>
    </label>
    <div class="field-group">
      <label class="field-label">Max calls out / hour</label>
      <input class="field-input focusable" type="number" :value="cfg.limits.callsPerHour" @change="cfg.limits.callsPerHour = num($event); save()" />
    </div>
    <div class="field-group">
      <label class="field-label">Max SMS out / hour</label>
      <input class="field-input focusable" type="number" :value="cfg.limits.smsPerHour" @change="cfg.limits.smsPerHour = num($event); save()" />
    </div>
    <div class="field-group">
      <label class="field-label">Max call length (minutes, 0 = none)</label>
      <input class="field-input focusable" type="number" :value="cfg.limits.maxCallMin" @change="cfg.limits.maxCallMin = num($event); save()" />
    </div>
    <div class="field-group">
      <label class="field-label">Quiet hours (HH:MM → HH:MM)</label>
      <div class="phone-actions">
        <input class="field-input focusable" :value="cfg.limits.quietStart" placeholder="23:00" @change="cfg.limits.quietStart = str($event); save()" />
        <input class="field-input focusable" :value="cfg.limits.quietEnd" placeholder="07:30" @change="cfg.limits.quietEnd = str($event); save()" />
      </div>
    </div>
    <div class="field-group">
      <label class="field-label">Conference: max people (incl. assistant)</label>
      <input class="field-input focusable" type="number" :value="cfg.conference.maxParticipants" @change="cfg.conference.maxParticipants = num($event); save()" />
    </div>
    <label class="phone-setting">
      <input type="checkbox" class="focusable" :checked="cfg.conference.announce" @change="cfg.conference.announce = checked($event); save()" />
      <span>Announce the assistant when someone joins</span>
    </label>
    <label class="phone-setting">
      <input type="checkbox" class="focusable" :checked="cfg.fallback.ring" @change="cfg.fallback.ring = checked($event); save()" />
      <span>ring_user calls me here when the Helm app is offline</span>
    </label>
    <label class="phone-setting">
      <input type="checkbox" class="focusable" :checked="cfg.fallback.notify" @change="cfg.fallback.notify = checked($event); save()" />
      <span>notify_user texts me when the Helm app is offline</span>
    </label>

    <!-- Transcripts -->
    <div class="settings-panel__header settings-span"><span class="settings-panel__title">Transcripts</span></div>
    <label class="phone-setting settings-span">
      <input type="checkbox" class="focusable" :checked="cfg.transcripts.enabled" @change="cfg.transcripts.enabled = checked($event); save()" />
      <span>Save every call transcript</span>
    </label>
    <div class="field-group">
      <label class="field-label">Folder (empty = Helm's config folder)</label>
      <input class="field-input focusable" :value="cfg.transcripts.folder" placeholder="D:\Notes\Calls" @change="cfg.transcripts.folder = str($event); save()" />
    </div>
    <div class="field-group">
      <label class="field-label">File name</label>
      <input class="field-input focusable phone-mono" :value="cfg.transcripts.fileName" @change="cfg.transcripts.fileName = str($event); save()" />
    </div>
    <label class="phone-setting">
      <span>Format</span>
      <select class="btn btn--secondary btn--sm focusable" :value="cfg.transcripts.format" @change="cfg.transcripts.format = str($event) as PhoneLineConfig['transcripts']['format']; save()">
        <option value="md">Markdown</option><option value="json">JSON</option><option value="both">Both</option>
      </select>
    </label>
    <div class="field-group">
      <label class="field-label">Delete after (days, 0 = never)</label>
      <input class="field-input focusable" type="number" :value="cfg.transcripts.retentionDays" @change="cfg.transcripts.retentionDays = num($event); save()" />
    </div>
  </div>
</template>

<style scoped>
.phone-setting {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) 0;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}
.phone-switches { display: flex; flex-wrap: wrap; gap: 0 var(--spacing-lg); }
.phone-status {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--spacing-xs) var(--spacing-md);
  margin: 0;
  font-size: var(--font-size-sm);
}
.phone-status dt { color: var(--text-secondary); }
.phone-status dd { margin: 0; color: var(--text-primary); }
.phone-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: var(--spacing-xs); background: var(--text-dim); }
.phone-dot--ok { background: var(--accent); }
.phone-dot--warn { background: var(--status-blocked); }
.phone-dot--err { background: var(--danger); }
.phone-actions { display: flex; gap: var(--spacing-sm); align-items: center; flex-wrap: wrap; padding: var(--spacing-xs) 0; }
.phone-message { color: var(--text-secondary); font-size: var(--font-size-sm); }
.phone-log {
  margin: 0;
  padding: var(--spacing-sm);
  list-style: none;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.phone-contacts { width: 100%; border-collapse: collapse; font-size: var(--font-size-sm); }
.phone-contacts th { text-align: left; color: var(--text-secondary); font-weight: 600; padding: var(--spacing-xs); }
.phone-contacts td { padding: var(--spacing-xs); border-top: 1px solid var(--border); }
.phone-center { text-align: center; }
.phone-mono { font-family: var(--font-mono); }
</style>
