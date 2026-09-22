<script setup lang="ts">
/**
 * CliIntegrationsTab.vue — Settings → 🪝 CLI Integrations (G1).
 *
 * One row per canonical PROVIDER (Claude Code / Codex / Copilot — always the
 * same three, independent of the user's CLI types): install state read off
 * the CLI's own config file on disk (never a stored flag), Install / Update /
 * Remove buttons, and the hook registration code a fresh install would write
 * — built in the main process by the same builders the installer uses, shown
 * ready to copy for hand registration on machines Helm shouldn't touch.
 * G1 is plumbing — installing changes nothing visible except that hook
 * events start arriving in the log.
 *
 * "Python not found" is a first-class state, not an error toast: the installer
 * refuses rather than writing a hook config that points at an interpreter
 * that isn't there.
 *
 * The Tool mapping section is where the user's own CLI types are mapped onto
 * a provider (auto-migrated on load, correctable here) — that mapping is what
 * hook capability resolves against.
 */
import { computed, onMounted, ref } from 'vue';
import { configClient, toolsClient } from '../../ipc/clients.js';
import {
  DEFAULT_REMINDER_MODES,
  REMINDER_IDS,
  type ReminderDeliveryMode,
  type ReminderId,
} from '../../../src/session/reminder-delivery.js';

type HookStatus = 'installed' | 'outdated' | 'not-installed' | 'interpreter-missing';

interface HookIntegrationItem {
  /** The canonical provider — install/uninstall key on this, not on CLI types. */
  provider: string;
  label: string;
  status: HookStatus;
  /** G9: false = this CLI can never take injected reminders (Copilot). */
  canInject?: boolean;
  /** The CLI's user-level config file and the hook block to merge into it. */
  configPath?: string;
  snippet?: string;
}

/** One settings row per standing reminder (docs/cli-hooks.md, G9). */
const REMINDER_META: Record<ReminderId, { label: string; detail: string }> = {
  helmMsgRules: {
    label: 'Inter-session rules',
    detail: 'The [HELM_MSG_RULES] block on messages from other sessions',
  },
  telegramInstruction: {
    label: 'Telegram reply instruction',
    detail: 'The "Respond via telegram_chat" line on Telegram messages',
  },
  telegramModeInstructions: {
    label: 'Telegram mode block',
    detail: 'The one-time announcement when a session enters Telegram mode',
  },
};

const MODE_TEXT: Record<ReminderDeliveryMode, string> = {
  hook: 'Hook (out-of-band)',
  pty: 'Prepend (prompt text)',
  off: 'Off',
};

/** G5 suggester usage feedback — what the store has learned (ids + terms only). */
interface SuggestionUsageSummary {
  items: number;
  totalWeight: number;
  top: Array<{ key: string; weight: number; topTerms: Array<{ term: string; count: number }> }>;
  recent: Array<{ at: number; key: string }>;
}

const items = ref<HookIntegrationItem[]>([]);
const loading = ref(true);
const busyId = ref<string | null>(null);
const errorText = ref('');
const usage = ref<SuggestionUsageSummary | null>(null);
const usageLoading = ref(true);
const resettingUsage = ref(false);

/** Tool mapping: which CLI family each configured tool speaks (drives capability). */
interface ToolMappingEntry {
  key: string;
  label: string;
  provider: string;
}
const toolMapping = ref<ToolMappingEntry[]>([]);
const mappingBusy = ref(false);

const STATUS_TEXT: Record<HookStatus, string> = {
  installed: 'Installed',
  outdated: 'Update available',
  'not-installed': 'Not installed',
  'interpreter-missing': 'Python not found',
};

async function loadStatus(): Promise<void> {
  const result = await configClient.hooksGetStatus();
  if (result.success) {
    items.value = result.items;
    errorText.value = '';
  } else {
    errorText.value = result.error ?? 'Could not read hook install state';
  }
  loading.value = false;
}

async function install(item: HookIntegrationItem): Promise<void> {
  busyId.value = item.provider;
  try {
    const result = await configClient.hooksInstall(item.provider);
    if (!result.success) errorText.value = result.error ?? 'Install failed';
  } finally {
    busyId.value = null;
  }
  await loadStatus();
}

async function remove(item: HookIntegrationItem): Promise<void> {
  busyId.value = item.provider;
  try {
    const result = await configClient.hooksUninstall(item.provider);
    if (!result.success) errorText.value = result.error ?? 'Remove failed';
  } finally {
    busyId.value = null;
  }
  await loadStatus();
}

async function loadToolMapping(): Promise<void> {
  const result = await toolsClient.toolsGetAll();
  toolMapping.value = Object.entries(result?.cliTypes ?? {}).map(([key, entry]) => ({
    key,
    label: (entry as { displayName?: string; name?: string }).displayName
      ?? (entry as { displayName?: string; name?: string }).name
      ?? key,
    provider: (entry as { provider?: string }).provider ?? '',
  }));
}

async function setToolProvider(entry: ToolMappingEntry, provider: string): Promise<void> {
  mappingBusy.value = true;
  try {
    const result = await toolsClient.toolsSetCliTypeProvider(entry.key, provider === '' ? null : (provider as 'claude' | 'codex' | 'copilot'));
    if (result.success) {
      entry.provider = provider;
      errorText.value = '';
    } else {
      errorText.value = result.error ?? 'Could not save the mapping';
    }
  } finally {
    mappingBusy.value = false;
  }
}

/** Same hand-off as the MCP setup snippets: clipboard, nothing else. */
function copySnippet(text: string): void {
  void navigator.clipboard.writeText(text);
}

/** How a hand-registered block comes back out — per provider's config shape. */
function unregisterHint(item: HookIntegrationItem): string {
  return item.provider === 'copilot'
    ? 'Manual remove: delete the file (or just the shim entries if you added your own)'
    : 'Manual remove: delete the entries whose command runs helm-hook-shim.py';
}

const reminderModes = ref<Partial<Record<ReminderId, ReminderDeliveryMode>>>({});
const reminderBusy = ref(false);

const reminders = computed(() =>
  REMINDER_IDS.map((id) => ({
    id,
    ...REMINDER_META[id],
    saved: reminderModes.value[id],
    effective: reminderModes.value[id] ?? DEFAULT_REMINDER_MODES[id],
  })),
);

/**
 * "hook" that cannot be honoured falls back to prepend — and the pane SAYS
 * so. A setting that quietly means something else is worse than no setting.
 */
function fallbackText(effective: ReminderDeliveryMode): string {
  if (effective !== 'hook') return '';
  const falling = items.value.filter(
    (item) => item.canInject === false || item.status === 'not-installed' || item.status === 'interpreter-missing',
  );
  if (falling.length === 0) return '';
  return (
    'Falls back to prepend for: ' +
    falling
      .map((item) => `${item.label} (${item.canInject === false ? 'cannot inject' : STATUS_TEXT[item.status].toLowerCase()})`)
      .join(', ') +
    '.'
  );
}

async function loadReminderModes(): Promise<void> {
  const result = await configClient.configGetReminderDelivery();
  if (result.success) reminderModes.value = result.modes ?? {};
}

async function setReminderMode(id: ReminderId, mode: ReminderDeliveryMode): Promise<void> {
  reminderBusy.value = true;
  try {
    const result = await configClient.configSetReminderDelivery({ [id]: mode });
    if (result.success) {
      reminderModes.value = result.modes ?? {};
      errorText.value = '';
    } else {
      errorText.value = result.error ?? 'Could not save reminder delivery';
    }
  } finally {
    reminderBusy.value = false;
  }
}

async function loadUsage(): Promise<void> {
  const result = await configClient.hooksGetSuggestionUsage();
  if (result.success) {
    usage.value = result.usage;
  } else {
    usage.value = null;
  }
  usageLoading.value = false;
}

async function resetUsage(): Promise<void> {
  resettingUsage.value = true;
  try {
    await configClient.hooksResetSuggestionUsage();
    await loadUsage();
  } finally {
    resettingUsage.value = false;
  }
}

function formatAt(at: number): string {
  return new Date(at).toLocaleString();
}

onMounted(() => {
  void loadStatus();
  void loadUsage();
  void loadReminderModes();
  void loadToolMapping();
});
</script>

<template>
  <div class="settings-cli-integrations-panel">
    <div class="tg-section">
      <h3 class="tg-section-title">CLI Integrations</h3>
      <p class="settings-form__hint">
        Installs Helm's lifecycle hooks into each CLI's own user-level config, once per CLI —
        not per session. Hook events arrive while Helm is running and are logged; nothing else
        changes yet. Remove is always available and touches only Helm's own block.
      </p>
      <p v-if="errorText" class="settings-form__hint settings-cli-integrations-panel__error">
        {{ errorText }}
      </p>
      <div v-if="loading" class="settings-list-item">
        <div class="settings-list-item__info">
          <span class="settings-list-item__name">Reading install state…</span>
        </div>
      </div>
      <div
        v-for="item in items"
        :key="item.provider"
        class="settings-list-item"
      >
        <div class="settings-list-item__info">
          <span class="settings-list-item__name">{{ item.label }}</span>
          <span class="settings-list-item__detail">{{ STATUS_TEXT[item.status] }}</span>
          <template v-if="item.snippet">
            <span class="settings-list-item__detail">{{ item.configPath }}</span>
            <pre class="hook-command-block">{{ item.snippet }}</pre>
            <div class="hook-snippet-actions">
              <button
                class="btn btn--secondary btn--sm focusable"
                :aria-label="`Copy hook registration code for ${item.label}`"
                @click="copySnippet(item.snippet!)"
              >
                Copy
              </button>
            </div>
            <span class="settings-list-item__detail">{{ unregisterHint(item) }}</span>
          </template>
        </div>
        <div class="tg-btn-row">
          <button
            v-if="item.status === 'not-installed' || item.status === 'outdated'"
            class="btn btn--primary btn--sm focusable"
            :disabled="busyId === item.provider || item.status === 'interpreter-missing'"
            @click="install(item)"
          >
            {{ item.status === 'outdated' ? 'Update' : 'Install' }}
          </button>
          <button
            v-if="item.status !== 'not-installed' && item.status !== 'interpreter-missing'"
            class="btn btn--secondary btn--sm focusable"
            :disabled="busyId === item.provider"
            @click="remove(item)"
          >
            Remove
          </button>
        </div>
      </div>
      <p v-if="!loading && items.length === 0" class="settings-form__hint">
        No CLI types with hook integrations configured.
      </p>
      <p v-if="items.some(item => item.status === 'interpreter-missing')" class="settings-form__hint">
        A working Python interpreter is required — Helm ships without one. Install Python
        (python.org or the Microsoft Store) and reload this pane.
      </p>
    </div>

    <div class="tg-section">
      <h3 class="tg-section-title">Tool mapping</h3>
      <p class="settings-form__hint">
        Which CLI family each of your tools actually speaks. Auto-filled from
        names and commands where the answer is obvious — correct it here when
        it guessed wrong. A tool mapped to Claude or Codex can take injected
        reminders once that provider's hooks are installed; Copilot and
        unmapped tools always get prepended text.
      </p>
      <div
        v-for="entry in toolMapping"
        :key="entry.key"
        class="settings-list-item"
      >
        <div class="settings-list-item__info">
          <span class="settings-list-item__name">{{ entry.label }}</span>
        </div>
        <div class="tg-btn-row">
          <select
            class="focusable"
            :value="entry.provider"
            :disabled="mappingBusy"
            :aria-label="`Provider for ${entry.label}`"
            @change="setToolProvider(entry, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">Not mapped</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="copilot">Copilot</option>
          </select>
        </div>
      </div>
    </div>

    <div class="tg-section">
      <h3 class="tg-section-title">Reminder delivery</h3>
      <p class="settings-form__hint">
        How standing reminders reach a session. Hook delivers them out-of-band via the
        CLI's own hooks — the transcript stays clean and nothing is spent per message;
        a recipient without usable hooks falls back to prepend automatically, as shown
        per row. Prepend keeps today's behaviour exactly. Off suppresses the reminder
        on both paths.
      </p>
      <div
        v-for="reminder in reminders"
        :key="reminder.id"
        class="settings-list-item"
      >
        <div class="settings-list-item__info">
          <span class="settings-list-item__name">
            {{ reminder.label }}
            <em v-if="!reminder.saved" class="settings-cli-integrations-panel__default">(default)</em>
          </span>
          <span class="settings-list-item__detail">{{ reminder.detail }}</span>
          <span
            v-if="fallbackText(reminder.effective)"
            class="settings-list-item__detail settings-cli-integrations-panel__fallback"
          >
            {{ fallbackText(reminder.effective) }}
          </span>
        </div>
        <div class="tg-btn-row">
          <select
            class="focusable"
            :value="reminder.effective"
            :disabled="reminderBusy"
            :aria-label="`Delivery mode for ${reminder.label}`"
            @change="setReminderMode(reminder.id, ($event.target as HTMLSelectElement).value as ReminderDeliveryMode)"
          >
            <option v-for="(text, mode) in MODE_TEXT" :key="mode" :value="mode">{{ text }}</option>
          </select>
        </div>
      </div>
    </div>

    <div class="tg-section">
      <h3 class="tg-section-title">Suggestion usage feedback</h3>
      <p class="settings-form__hint">
        When a session fetches a suggested skill or memory, Helm learns the association —
        item ids and prompt words only, never prompt text. This tunes the order of the
        "possibly related" hints; it can reorder them, never add new ones. With no history
        the suggester behaves exactly as it does today.
      </p>
      <div v-if="usageLoading" class="settings-list-item">
        <div class="settings-list-item__info">
          <span class="settings-list-item__name">Reading usage feedback…</span>
        </div>
      </div>
      <template v-else-if="usage && usage.items > 0">
        <div class="settings-form__hint">
          {{ usage.items }} item{{ usage.items === 1 ? '' : 's' }} learned, {{ usage.totalWeight }}
          association{{ usage.totalWeight === 1 ? '' : 's' }}, {{ usage.recent.length }} recent event{{ usage.recent.length === 1 ? '' : 's' }}.
        </div>
        <div
          v-for="entry in usage.top"
          :key="entry.key"
          class="settings-list-item"
        >
          <div class="settings-list-item__info">
            <span class="settings-list-item__name">{{ entry.key }}</span>
            <span class="settings-list-item__detail">
              weight {{ entry.weight }} · {{ entry.topTerms.map(term => `${term.term} ×${term.count}`).join(', ') }}
            </span>
          </div>
        </div>
        <div
          v-for="(event, index) in [...usage.recent].reverse()"
          :key="`${event.at}-${event.key}-${index}`"
          class="settings-list-item"
        >
          <div class="settings-list-item__info">
            <span class="settings-list-item__name">{{ event.key }}</span>
            <span class="settings-list-item__detail">learned {{ formatAt(event.at) }}</span>
          </div>
        </div>
        <div class="tg-btn-row">
          <button
            class="btn btn--secondary btn--sm focusable"
            :disabled="resettingUsage"
            @click="resetUsage"
          >
            Reset feedback
          </button>
        </div>
      </template>
      <p v-else class="settings-form__hint">
        Nothing learned yet — this fills in as sessions fetch suggested items.
      </p>
    </div>
  </div>
</template>

<style scoped>
.tg-btn-row {
  display: flex;
  gap: var(--spacing-sm);
  align-items: center;
}

.settings-cli-integrations-panel__error {
  color: var(--danger, #e5534b);
}

.settings-cli-integrations-panel__default {
  font-style: normal;
  opacity: 0.7;
}

.settings-cli-integrations-panel__fallback {
  color: var(--warning, #b58900);
}

/* Same snippet treatment as McpCliSetup.vue — each SFC owns its scoped style.
   Capped height: the seven-event block must not push the pane apart. */
.hook-command-block {
  margin: 8px 0 0;
  padding: 10px 12px;
  max-height: 220px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono, "Cascadia Code", "Fira Code", monospace);
  font-size: var(--font-size-sm);
  line-height: 1.45;
}

.hook-snippet-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
</style>
