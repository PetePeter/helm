<script setup lang="ts">
/**
 * OperatorTab.vue: the router-only "Helm" operator session voice clients talk
 * to (docs/voice-operator.md) — on/off, which CLI type runs it, where, and
 * its rules: the built-ins (read-only, the exact text the guide sends) plus
 * the user's own.
 */
import { onMounted, ref, watch } from 'vue';
import { configClient } from '../../../ipc/clients.js';
import { getCliDisplayName } from '../../../utils.js';
import { OPERATOR_RULES } from '../../../../src/mcp/guides/operator-guide.js';
import { trackSave, useAutosave } from '../../../composables/useAutosave.js';

interface OperatorConfig { enabled: boolean; cliType: string; compactEveryMinutes: number; rules: string }

const config = ref<OperatorConfig>({ enabled: false, cliType: '', compactEveryMinutes: 60, rules: '' });
/**
 * Edited locally and autosaved on a long pause or on leaving the field, since
 * every save re-runs ensure().
 */
const rulesDraft = ref('');
const COMPACT_CHOICES = [
  { minutes: 0, label: 'Off' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 120, label: 'Every 2 hours' },
  { minutes: 240, label: 'Every 4 hours' },
];
const cliTypes = ref<string[]>([]);
const RULES_DEBOUNCE_MS = 1500;

onMounted(async () => {
  const [loaded, types] = await Promise.all([
    configClient.configGetOperatorConfig(),
    configClient.configGetCliTypes(),
  ]);
  config.value = loaded;
  rulesDraft.value = loaded.rules;
  cliTypes.value = types ?? [];
});

function save(updates: Partial<OperatorConfig>): Promise<boolean> {
  return trackSave(async () => {
    const result = await configClient.configSetOperatorConfig(updates);
    if (result.success) {
      config.value = { ...config.value, ...updates };
      return;
    }
    // The controls bind one-way: re-read so a failed save does not leave the
    // checkbox or dropdowns showing a value that was never stored.
    config.value = await configClient.configGetOperatorConfig();
    throw new Error(result.error ?? 'Could not save setting');
  });
}

// The draft is never rewritten from the stored (trimmed) value: that would eat
// the space or newline the user just typed.
const rulesAutosave = useAutosave(() => save({ rules: rulesDraft.value.trim() }), { debounceMs: RULES_DEBOUNCE_MS });
watch(rulesDraft, (draft) => {
  if (draft.trim() !== config.value.rules) rulesAutosave.schedule();
});

const selectValue = (event: Event): string => (event.target as HTMLSelectElement).value;

</script>

<template>
  <div class="settings-operator-panel settings-sections">
    <div class="settings-panel__header settings-span">
      <span class="settings-panel__title">Operator</span>
    </div>

    <div class="settings-help settings-span">
      <p>A single locked session named <strong>Helm</strong> that the phone and desktop talk to.
        It only routes your instructions to work sessions and relays their answers; it never does the work itself.</p>
    </div>

    <label class="operator-setting">
      <input
        type="checkbox"
        class="focusable"
        :checked="config.enabled"
        @change="save({ enabled: ($event.target as HTMLInputElement).checked })"
      />
      <span>Keep the Helm operator session running</span>
    </label>

    <label class="operator-setting">
      <span>CLI type</span>
      <select class="btn btn--secondary btn--sm focusable" :value="config.cliType" @change="save({ cliType: selectValue($event) })">
        <option value="" disabled>Choose a CLI type…</option>
        <option v-for="type in cliTypes" :key="type" :value="type">{{ getCliDisplayName(type) }}</option>
      </select>
    </label>


    <label class="operator-setting">
      <span>Auto-clear when idle</span>
      <select
        class="btn btn--secondary btn--sm focusable"
        :value="config.compactEveryMinutes"
        @change="save({ compactEveryMinutes: Number(selectValue($event)) })"
      >
        <option v-if="!COMPACT_CHOICES.some(c => c.minutes === config.compactEveryMinutes)" :value="config.compactEveryMinutes">
          Every {{ config.compactEveryMinutes }} minutes
        </option>
        <option v-for="choice in COMPACT_CHOICES" :key="choice.minutes" :value="choice.minutes">{{ choice.label }}</option>
      </select>
    </label>

    <div class="settings-panel__header settings-span">
      <span class="settings-panel__title">Rules</span>
    </div>

    <div class="settings-help settings-span">
      <p>Built-in rules always apply. Your rules come on top, ranked highest: they can narrow what the operator does or allow more.
        They take effect from the operator's next start or clear.</p>
    </div>

    <ol class="operator-rules settings-span">
      <li v-for="rule in OPERATOR_RULES" :key="rule">{{ rule }}</li>
    </ol>

    <div class="field-group settings-span">
      <label class="field-label" for="operator-user-rules">Your rules (one per line)</label>
      <textarea
        id="operator-user-rules"
        v-model="rulesDraft"
        class="field-input focusable"
        rows="6"
        placeholder="e.g. Never message the build session."
        @blur="rulesAutosave.flush()"
      />
    </div>
  </div>
</template>

<style scoped>
.operator-setting {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) 0;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.operator-rules {
  margin: 0 0 var(--spacing-sm);
  padding-left: var(--spacing-lg);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.operator-rules li {
  padding: 2px 0;
}

</style>
