<script setup lang="ts">
/**
 * MobileTab.vue — Settings → 📱 Mobile. The steady-state paired-phone surface:
 * each device with an online dot, last-seen time, an enable toggle, an
 * allow-list editor and a revoke button, plus the "Pair a phone" entry point.
 *
 * Deliberately the same shape as PeersTab — same row layout, same debounced
 * allow-list editor, same tokens — because it is the same job for a different
 * transport. The SAS dialog is mounted by the app host and driven by the
 * useMobileDevices pairing state.
 *
 * Role flip: HELM is the BLE central, so pairing mode is entered on the PHONE
 * (it advertises) and Helm scans for it. The copy has to say so, or the user
 * sits waiting for a button that does not exist on this side.
 */
import { onMounted, ref } from 'vue';
import { useMobileDevices, type MobileDeviceItem } from '../../composables/useMobileDevices.js';
import { getPeerStatusColor } from '../../state-colors.js';
import QrCode from './QrCode.vue';

const {
  devices,
  ensureSubscribed,
  startPairing,
  setAllowList,
  setEnabled,
  revoke,
  apkRelease,
  apkError,
  loadApkRelease,
} = useMobileDevices();

/** Allow-list presets: a friendly name → the glob patterns it applies. */
const ALLOW_PRESETS: Array<{ label: string; globs: string[] }> = [
  { label: 'Read-only', globs: ['session_list', 'plan_*', 'directory_list', 'project_list'] },
  { label: 'Sessions', globs: ['session_*'] },
  { label: 'All', globs: ['*'] },
];

const expandedId = ref<string | null>(null);
const newPattern = ref<Record<string, string>>({});
const confirmRevokeId = ref<string | null>(null);
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const copiedUrl = ref(false);

onMounted(() => {
  ensureSubscribed();
  void loadApkRelease();
});

function copyUrl(): void {
  const url = apkRelease.value?.url;
  if (!url) return;
  void navigator.clipboard.writeText(url).then(() => {
    copiedUrl.value = true;
    setTimeout(() => { copiedUrl.value = false; }, 1500);
  });
}

function dotColor(device: MobileDeviceItem): string {
  return getPeerStatusColor(device.online ? 'online' : 'offline');
}

function lastSeenLabel(device: MobileDeviceItem): string {
  if (device.online) return 'connected';
  if (device.lastSeenAt === undefined) return 'never connected';
  const minutes = Math.floor((Date.now() - device.lastSeenAt) / 60_000);
  if (minutes < 1) return 'seen just now';
  if (minutes < 60) return `seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `seen ${hours}h ago`;
  return `seen ${Math.floor(hours / 24)}d ago`;
}

function toggleExpanded(id: string): void {
  expandedId.value = expandedId.value === id ? null : id;
}

function onToggleEnabled(device: MobileDeviceItem, event: Event): void {
  void setEnabled(device.id, (event.target as HTMLInputElement).checked);
}

function onRevoke(device: MobileDeviceItem): void {
  // Revocation is irreversible — the phone must pair again from scratch — so it
  // takes a second click rather than a single mis-aimed one.
  if (confirmRevokeId.value !== device.id) {
    confirmRevokeId.value = device.id;
    return;
  }
  confirmRevokeId.value = null;
  void revoke(device.id);
}

/** Debounced allow-list save (500ms), matching the peers editor. */
function scheduleAllowSave(id: string, allow: string[]): void {
  const existing = saveTimers.get(id);
  if (existing) clearTimeout(existing);
  saveTimers.set(id, setTimeout(() => {
    void setAllowList(id, allow);
    saveTimers.delete(id);
  }, 500));
}

function addPattern(device: MobileDeviceItem): void {
  const pattern = (newPattern.value[device.id] ?? '').trim();
  if (!pattern) return;
  if (device.allow.includes(pattern)) { newPattern.value[device.id] = ''; return; }
  newPattern.value[device.id] = '';
  scheduleAllowSave(device.id, [...device.allow, pattern]);
}

function removePattern(device: MobileDeviceItem, pattern: string): void {
  scheduleAllowSave(device.id, device.allow.filter((p) => p !== pattern));
}

function applyPreset(device: MobileDeviceItem, globs: string[]): void {
  scheduleAllowSave(device.id, [...globs]);
}
</script>

<template>
  <div class="mobile-tab">
    <section class="mobile-section">
      <h3 class="mobile-section-title">Install on your phone</h3>

      <p v-if="apkError" class="mobile-empty">
        No download to offer: {{ apkError }}
      </p>

      <div v-else-if="apkRelease" class="mobile-apk">
        <QrCode :payload="apkRelease.qrPayload" :size="132" />
        <div class="mobile-apk-detail">
          <span class="mobile-apk-version">Helm v{{ apkRelease.version }}</span>
          <code class="mobile-apk-url">{{ apkRelease.url }}</code>
          <p v-if="apkRelease.note" class="mobile-apk-note">{{ apkRelease.note }}</p>
          <div class="mobile-apk-actions">
            <button class="btn btn-secondary" @click="copyUrl()">
              {{ copiedUrl ? 'Copied' : 'Copy link' }}
            </button>
          </div>
          <p class="mobile-empty">
            Scan it, install, then pair — a fresh install is an unpaired stranger and
            can reach nothing until you confirm its six digits below.
          </p>
        </div>
      </div>

      <p v-else class="mobile-empty">Looking up the download for this version…</p>
    </section>

    <section class="mobile-section">
      <div class="mobile-section-head">
        <h3 class="mobile-section-title">Paired phones</h3>
        <button class="btn btn-primary mobile-pair-btn" @click="startPairing()">
          Pair a phone
        </button>
      </div>

      <p v-if="devices.length === 0" class="mobile-empty">
        No phones paired yet. Open Helm on your phone, put it into pairing mode, then
        press “Pair a phone” — the phone advertises and this machine connects to it.
      </p>

      <div v-for="device in devices" :key="device.id" class="mobile-row">
        <div class="mobile-row-main">
          <span class="mobile-dot" :style="{ background: dotColor(device) }"></span>
          <span class="mobile-name">{{ device.name }}</span>
          <span class="mobile-seen">{{ lastSeenLabel(device) }}</span>

          <span class="mobile-spacer"></span>

          <label class="mobile-toggle">
            <input
              class="mobile-enable-input"
              type="checkbox"
              :checked="device.enabled"
              @change="onToggleEnabled(device, $event)"
            />
            <span class="mobile-toggle-label">{{ device.enabled ? 'On' : 'Off' }}</span>
          </label>

          <button class="btn btn-secondary" @click="toggleExpanded(device.id)">
            {{ expandedId === device.id ? 'Done' : 'Permissions' }}
          </button>

          <button
            class="btn btn-danger"
            :class="{ 'mobile-revoke-armed': confirmRevokeId === device.id }"
            @click="onRevoke(device)"
          >
            {{ confirmRevokeId === device.id ? 'Confirm revoke' : 'Revoke' }}
          </button>
        </div>

        <div v-if="expandedId === device.id" class="mobile-allow-editor">
          <div class="mobile-presets">
            <span class="mobile-presets-label">Presets:</span>
            <button
              v-for="preset in ALLOW_PRESETS"
              :key="preset.label"
              class="btn btn-secondary"
              @click="applyPreset(device, preset.globs)"
            >
              {{ preset.label }}
            </button>
          </div>

          <div class="mobile-globs">
            <span v-if="device.allow.length === 0" class="mobile-globs-empty">
              Nothing permitted — this phone can connect but cannot invoke anything.
            </span>
            <span v-for="pattern in device.allow" :key="pattern" class="mobile-glob-chip">
              <code class="mobile-glob-code">{{ pattern }}</code>
              <button
                class="mobile-glob-remove"
                :aria-label="`Remove ${pattern}`"
                @click="removePattern(device, pattern)"
              >×</button>
            </span>
          </div>

          <div class="mobile-glob-add">
            <input
              v-model="newPattern[device.id]"
              class="input mobile-glob-input"
              type="text"
              placeholder="session_* "
              @keyup.enter="addPattern(device)"
            />
            <button class="btn btn-secondary" @click="addPattern(device)">Add</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mobile-tab {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mobile-section { display: flex; flex-direction: column; gap: 6px; }
.mobile-section-head { display: flex; align-items: center; gap: 8px; }
.mobile-section-title { margin: 0; font-size: 0.88rem; color: var(--text-primary); }
.mobile-pair-btn { margin-left: auto; }
.mobile-empty { margin: 0; color: var(--text-secondary); font-size: 0.78rem; line-height: 1.35; }

.mobile-apk {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-primary);
  padding: 8px;
}
.mobile-apk-detail { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; }
.mobile-apk-version { font-weight: 600; font-size: 0.9rem; color: var(--text-primary); }
.mobile-apk-url {
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 0.72rem;
  color: var(--text-secondary);
  word-break: break-all;
}
.mobile-apk-note { margin: 0; font-size: 0.78rem; color: var(--accent); line-height: 1.35; }
.mobile-apk-actions { display: flex; gap: 6px; }

.mobile-row {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-primary);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mobile-row-main { display: flex; align-items: center; gap: 8px; }
.mobile-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.mobile-name { font-weight: 600; font-size: 0.9rem; color: var(--text-primary); }
.mobile-seen { font-size: 0.76rem; color: var(--text-secondary); }
.mobile-spacer { margin-left: auto; }
.mobile-revoke-armed { font-weight: 600; }

.mobile-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.mobile-enable-input { width: 16px; height: 16px; cursor: pointer; }
.mobile-toggle-label { font-size: 0.78rem; color: var(--text-secondary); }

.mobile-allow-editor {
  border-top: 1px solid var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mobile-presets { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mobile-presets-label { font-size: 0.78rem; color: var(--text-secondary); }
.mobile-globs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.mobile-globs-empty { font-size: 0.8rem; color: var(--text-secondary); }
.mobile-glob-chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--bg-tertiary); border-radius: 4px; padding: 2px 4px 2px 8px;
}
.mobile-glob-code { font-family: ui-monospace, "Cascadia Code", monospace; font-size: 0.78rem; color: var(--text-primary); }
.mobile-glob-remove {
  background: none; border: none; color: var(--text-secondary);
  cursor: pointer; font-size: 0.8rem; line-height: 1; padding: 0 2px;
}
.mobile-glob-add { display: flex; gap: 6px; }
.mobile-glob-input { flex: 1; font-family: ui-monospace, "Cascadia Code", monospace; font-size: 0.78rem; }
</style>
