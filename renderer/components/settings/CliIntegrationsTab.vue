<script setup lang="ts">
/**
 * CliIntegrationsTab.vue — Settings → 🪝 CLI Integrations (G1).
 *
 * One row per CLI type that has a hooks block in its config: install state
 * read off the CLI's own config file on disk (never a stored flag), and
 * Install / Update / Remove buttons. G1 is plumbing — installing changes
 * nothing visible except that hook events start arriving in the log.
 *
 * "Python not found" is a first-class state, not an error toast: the installer
 * refuses rather than writing a hook config that points at an interpreter
 * that isn't there.
 */
import { computed, onMounted, ref } from 'vue';
import { configClient } from '../../ipc/clients.js';
import {
  DEFAULT_REMINDER_MODES,
  REMINDER_IDS,
  type ReminderDeliveryMode,
  type ReminderId,
} from '../../../src/session/reminder-delivery.js';

type HookStatus = 'installed' | 'outdated' | 'not-installed' | 'interpreter-missing';

interface HookIntegrationItem {
  cliTypeId: string;
  label: string;
  status: HookStatus;
  /** G9: false = this CLI can never take injected reminders (Copilot). */
  canInject?: boolean;
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
  busyId.value = item.cliTypeId;
  try {
    const result = await configClient.hooksInstall(item.cliTypeId);
    if (!result.success) errorText.value = result.error ?? 'Install failed';
  } finally {
    busyId.value = null;
  }
  await loadStatus();
}

async function remove(item: HookIntegrationItem): Promise<void> {
  busyId.value = item.cliTypeId;
  try {
    const result = await configClient.hooksUninstall(item.cliTypeId);
    if (!result.success) errorText.value = result.error ?? 'Remove failed';
  } finally {
    busyId.value = null;
  }
  await loadStatus();
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
        :key="item.cliTypeId"
        class="settings-list-item"
      >
        <div class="settings-list-item__info">
          <span class="settings-list-item__name">{{ item.label }}</span>
          <span class="settings-list-item__detail">{{ STATUS_TEXT[item.status] }}</span>
        </div>
        <div class="tg-btn-row">
          <button
            v-if="item.status === 'not-installed' || item.status === 'outdated'"
            class="btn btn--primary btn--sm focusable"
            :disabled="busyId === item.cliTypeId || item.status === 'interpreter-missing'"
            @click="install(item)"
          >
            {{ item.status === 'outdated' ? 'Update' : 'Install' }}
          </button>
          <button
            v-if="item.status !== 'not-installed' && item.status !== 'interpreter-missing'"
            class="btn btn--secondary btn--sm focusable"
            :disabled="busyId === item.cliTypeId"
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
</style>
