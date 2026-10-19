<script setup lang="ts">
/** Project-scoped feedback used to reorder relevant memory and skill hints. */
import { computed, onMounted, ref, watch } from 'vue';
import { configClient } from '../../../ipc/clients.js';
import MasterDetail, { type MasterDetailItem } from '../primitives/MasterDetail.vue';
import { UNATTRIBUTED_SCOPE_ID, type SuggestionUsageItemSummary, type SuggestionUsageSummary } from '../../../../src/types/suggestion-usage.js';

type TypeFilter = 'both' | 'skill' | 'memory';

const usage = ref<SuggestionUsageSummary | null>(null);
const loading = ref(true);
const error = ref('');
const resetting = ref(false);
const typeFilter = ref<TypeFilter>('both');
const projectFilter = ref('all');
const search = ref('');
const selectedId = ref<string | null>(null);

const typeFilters: Array<{ id: TypeFilter; label: string }> = [
  { id: 'both', label: 'Both' },
  { id: 'skill', label: 'Skill' },
  { id: 'memory', label: 'Memory' },
];

const projectOptions = computed(() => [
  { id: 'all', name: 'All projects' },
  ...(usage.value?.projects ?? []).map(({ id, name }) => ({ id, name })),
  ...((usage.value?.items.some((item) => item.projectId === UNATTRIBUTED_SCOPE_ID))
    ? [{ id: UNATTRIBUTED_SCOPE_ID, name: 'Unattributed legacy' }]
    : []),
]);

const filteredItems = computed(() => {
  const query = search.value.trim().toLowerCase();
  return (usage.value?.items ?? []).filter((item) => {
    if (projectFilter.value !== 'all' && item.projectId !== projectFilter.value) return false;
    if (typeFilter.value !== 'both' && item.type !== typeFilter.value) return false;
    if (!query) return true;
    return [item.name, item.key, item.projectName, ...item.topTerms.map(({ term }) => term)]
      .some((value) => value.toLowerCase().includes(query));
  });
});

const masterItems = computed<MasterDetailItem[]>(() => filteredItems.value.map((item) => ({
  id: item.id,
  name: item.name,
  detail: `${item.projectName} · ${item.weight} association${item.weight === 1 ? '' : 's'}`,
  tag: item.type,
})));

const selectedItem = computed<SuggestionUsageItemSummary | null>(() =>
  filteredItems.value.find((item) => item.id === selectedId.value) ?? null);

watch(masterItems, (items) => {
  if (!items.some((item) => item.id === selectedId.value)) selectedId.value = items[0]?.id ?? null;
}, { immediate: true });

async function loadUsage(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await configClient.hooksGetSuggestionUsage();
    if (result.success) usage.value = result.usage;
    else error.value = result.error ?? 'Could not read suggestion learning.';
  } catch (cause) {
    error.value = String(cause);
  } finally {
    loading.value = false;
  }
}

async function resetUsage(): Promise<void> {
  if (!window.confirm('Reset all suggestion learning for every project?')) return;
  resetting.value = true;
  error.value = '';
  try {
    const result = await configClient.hooksResetSuggestionUsage();
    if (!result.success) {
      error.value = result.error ?? 'Could not reset suggestion learning.';
      return;
    }
    selectedId.value = null;
    await loadUsage();
  } catch (cause) {
    error.value = String(cause);
  } finally {
    resetting.value = false;
  }
}

function formatAt(at: number): string {
  return new Date(at).toLocaleString();
}

onMounted(() => { void loadUsage(); });
</script>

<template>
  <section class="suggestion-learning settings-span">
    <header class="suggestion-learning__header">
      <div>
        <h3>Suggestion learning</h3>
        <p>See what memory and skill fetches have taught Helm. Feedback changes hint order only within its project.</p>
      </div>
    </header>

    <div class="suggestion-learning__filters">
      <div class="suggestion-learning__chips" role="group" aria-label="Filter by item type">
        <button
          v-for="filter in typeFilters"
          :key="filter.id"
          type="button"
          class="btn btn--secondary btn--sm focusable"
          :class="{ 'suggestion-learning__chip--active': typeFilter === filter.id }"
          :aria-pressed="typeFilter === filter.id"
          @click="typeFilter = filter.id"
        >{{ filter.label }}</button>
      </div>
      <label class="suggestion-learning__project">
        <span>Project</span>
        <select v-model="projectFilter" class="btn btn--secondary btn--sm focusable" aria-label="Project scope">
          <option v-for="project in projectOptions" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
      <label class="suggestion-learning__search">
        <span class="sr-only">Search learned items</span>
        <input v-model="search" class="focusable" type="search" placeholder="Search items and terms" />
      </label>
    </div>

    <p v-if="loading" class="suggestion-learning__status">Reading suggestion learning…</p>
    <p v-else-if="error" class="suggestion-learning__status suggestion-learning__status--error">{{ error }}</p>
    <MasterDetail
      v-else
      v-model="selectedId"
      class="suggestion-learning__master-detail"
      :items="masterItems"
      list-title="Learned items"
      empty-text="No items match these filters."
    >
      <template #list-actions>
        <button
          type="button"
          class="btn btn--secondary btn--sm focusable"
          :disabled="resetting || !usage || usage.items.length === 0"
          @click="resetUsage"
        >Reset all</button>
      </template>
      <template #detail>
        <article v-if="selectedItem" class="suggestion-learning__detail">
          <h4>{{ selectedItem.name }}</h4>
          <dl class="suggestion-learning__facts">
            <div><dt>Item</dt><dd>{{ selectedItem.key }}</dd></div>
            <div><dt>Type</dt><dd>{{ selectedItem.type }}</dd></div>
            <div><dt>Project</dt><dd>{{ selectedItem.projectName }}</dd></div>
            <div><dt>Associations</dt><dd>{{ selectedItem.weight }}</dd></div>
          </dl>

          <section class="suggestion-learning__group">
            <h5>Topic terms</h5>
            <ul v-if="selectedItem.topTerms.length" class="suggestion-learning__terms">
              <li v-for="term in selectedItem.topTerms" :key="term.term">{{ term.term }} <span>×{{ term.count }}</span></li>
            </ul>
            <p v-else class="suggestion-learning__empty">No topic terms retained.</p>
          </section>

          <section class="suggestion-learning__group">
            <h5>Recent correlated fetches</h5>
            <ul v-if="selectedItem.recent.length" class="suggestion-learning__events">
              <li v-for="(at, index) in [...selectedItem.recent].reverse()" :key="`${at}-${index}`">{{ formatAt(at) }}</li>
            </ul>
            <p v-else class="suggestion-learning__empty">No fetches in the retained event window.</p>
          </section>
        </article>
      </template>
    </MasterDetail>
    <p class="suggestion-learning__privacy">All projects is reporting only. Prompt text and transcripts are never stored.</p>
  </section>
</template>

<style scoped>
.suggestion-learning {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  min-height: 460px;
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--border);
}

.suggestion-learning__header h3 { margin: 0 0 var(--spacing-xs); color: var(--text-primary); font-size: var(--font-size-md); }
.suggestion-learning__header p, .suggestion-learning__privacy, .suggestion-learning__status {
  margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm);
}
.suggestion-learning__filters { display: flex; align-items: end; gap: var(--spacing-md); flex-wrap: wrap; }
.suggestion-learning__chips { display: flex; gap: var(--spacing-xs); }
.suggestion-learning__chip--active { border-color: var(--accent); color: var(--accent); background: var(--accent-tint); }
.suggestion-learning__project, .suggestion-learning__search { display: flex; flex-direction: column; gap: var(--spacing-xs); color: var(--text-secondary); font-size: var(--font-size-xs); }
.suggestion-learning__project select { min-width: 190px; text-align: left; }
.suggestion-learning__search { flex: 1; min-width: 190px; }
.suggestion-learning__search input {
  width: 100%; box-sizing: border-box; padding: 6px 9px; border: 1px solid var(--border);
  border-radius: var(--radius-sm); background: var(--bg-secondary); color: var(--text-primary); font: inherit;
}
.suggestion-learning__master-detail { flex: 1; min-height: 320px; }
.suggestion-learning__status--error { color: var(--danger, #e5534b); }
.suggestion-learning__detail { padding: var(--spacing-md); }
.suggestion-learning__detail h4 { margin: 0 0 var(--spacing-md); color: var(--text-primary); font-size: var(--font-size-lg); }
.suggestion-learning__facts { display: grid; gap: var(--spacing-sm); margin: 0; }
.suggestion-learning__facts div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: var(--spacing-md); }
.suggestion-learning__facts dt { color: var(--text-secondary); font-size: var(--font-size-sm); }
.suggestion-learning__facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--text-primary); font: var(--font-size-sm) var(--font-mono); }
.suggestion-learning__group { margin-top: var(--spacing-lg); }
.suggestion-learning__group h5 { margin: 0 0 var(--spacing-sm); color: var(--text-secondary); font-size: var(--font-size-sm); }
.suggestion-learning__terms, .suggestion-learning__events { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); margin: 0; padding: 0; list-style: none; }
.suggestion-learning__terms li { padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--font-size-sm); }
.suggestion-learning__terms span { color: var(--text-secondary); }
.suggestion-learning__events li { padding: 2px 0; color: var(--text-primary); font-size: var(--font-size-sm); }
.suggestion-learning__empty { margin: 0; color: var(--text-dim); font-size: var(--font-size-sm); }
.suggestion-learning__privacy { font-size: var(--font-size-xs); }
@media (max-width: 720px) {
  .suggestion-learning__facts div { grid-template-columns: 1fr; gap: var(--spacing-xs); }
}
</style>
