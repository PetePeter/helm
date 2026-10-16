<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import SettingsPane from '../primitives/SettingsPane.vue';
import { useSettingsSubTabs } from '../settings-panes.js';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  aiAmendable: boolean;
  allProjects: boolean;
  projectIds: string[];
  type?: string;
  source?: 'user' | 'system';
  useCount: number;
  avgRating: number;
  reviewCount: number;
}

export interface SkillReview {
  stars: number;
  summary: string;
  improvement?: string;
  cliName: string;
  cliType: string;
  timestamp: string;
}

export interface SkillDraft {
  id: string;
  name: string;
  description: string;
  body: string;
  aiAmendable: boolean;
  allProjects: boolean;
  projectIds: string[];
  type?: string;
  source?: 'user' | 'system';
  useCount: number;
  avgRating: number;
  reviewCount: number;
  reviews: SkillReview[];
}

export interface SkillProject {
  id: string;
  name: string;
  canonicalPath: string;
}

const FILTER_BADGES_KEY = 'helm:skill-filter-badges';

interface FilterBadges { name: boolean; trigger: boolean; body: boolean }

const props = defineProps<{
  skills: SkillSummary[];
  draft: SkillDraft;
  projects: SkillProject[];
  bodyCache?: Record<string, string>;
}>();

const emit = defineEmits<{
  select: [id: string];
  new: [];
  save: [draft: SkillDraft];
  delete: [id: string];
  clone: [id: string];
  clearReviews: [id: string];
  resetUseCount: [id: string];
  resetAllCounts: [];
  loadBodies: [];
}>();

const filterText = ref('');
const filterBadges = ref<FilterBadges>({ name: true, trigger: false, body: false });
const bodiesRequested = ref(false);

onMounted(() => {
  try {
    const saved = localStorage.getItem(FILTER_BADGES_KEY);
    if (saved) filterBadges.value = { name: true, trigger: false, body: false, ...JSON.parse(saved) };
  } catch { /* ignore */ }
});

watch(filterBadges, (badges) => {
  localStorage.setItem(FILTER_BADGES_KEY, JSON.stringify(badges));
  if (badges.body && !bodiesRequested.value) {
    bodiesRequested.value = true;
    emit('loadBodies');
  }
}, { deep: true });

const filteredSkills = computed(() => {
  const text = filterText.value.trim().toLowerCase();
  if (!text) return props.skills;
  return props.skills.filter((skill) => {
    if (filterBadges.value.name && skill.name.toLowerCase().includes(text)) return true;
    if (filterBadges.value.trigger && skill.description.toLowerCase().includes(text)) return true;
    if (filterBadges.value.body) {
      const body = props.bodyCache?.[skill.id] ?? '';
      if (body.toLowerCase().includes(text)) return true;
    }
    return false;
  });
});

const localDraft = ref<SkillDraft>({ ...props.draft });

// Originals — used to detect unsaved changes
const origName = ref(props.draft.name);
const origDescription = ref(props.draft.description);
const origBody = ref(props.draft.body);
const origAiAmendable = ref(props.draft.aiAmendable);
const origAllProjects = ref(props.draft.allProjects);
const origProjectIds = ref([...props.draft.projectIds]);

const hydratingFromProps = ref(false);
const autoSaveTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const SKILL_TABS = ['definition', 'reviews'] as const;
const activeTab = ref<typeof SKILL_TABS[number]>('definition');
useSettingsSubTabs(() => SKILL_TABS, () => activeTab.value, (id) => { activeTab.value = id as typeof SKILL_TABS[number]; });

watch(() => props.draft, (draft) => {
  hydratingFromProps.value = true;
  localDraft.value = { ...draft };
  origName.value = draft.name;
  origDescription.value = draft.description;
  origBody.value = draft.body;
  origAiAmendable.value = draft.aiAmendable;
  origAllProjects.value = draft.allProjects;
  origProjectIds.value = [...draft.projectIds];
  confirmDelete.value = false;
  if (autoSaveTimer.value) { clearTimeout(autoSaveTimer.value); autoSaveTimer.value = null; }
  nextTick(() => { hydratingFromProps.value = false; });
}, { deep: true });

const hasUnsavedChanges = computed(() =>
  localDraft.value.name !== origName.value ||
  localDraft.value.description !== origDescription.value ||
  localDraft.value.body !== origBody.value ||
  localDraft.value.aiAmendable !== origAiAmendable.value ||
  localDraft.value.allProjects !== origAllProjects.value ||
  JSON.stringify(localDraft.value.projectIds) !== JSON.stringify(origProjectIds.value),
);

watch(localDraft, () => {
  if (hydratingFromProps.value) return;
  scheduleAutoSave();
}, { deep: true, flush: 'post' });

function scheduleAutoSave(): void {
  if (autoSaveTimer.value) clearTimeout(autoSaveTimer.value);
  autoSaveTimer.value = setTimeout(() => {
    autoSaveTimer.value = null;
    if (hasUnsavedChanges.value) doAutoSave();
  }, 500);
}

function doAutoSave(): void {
  if (isSystemSkill.value || !localDraft.value.name.trim()) return;
  emit('save', { ...localDraft.value });
  origName.value = localDraft.value.name;
  origDescription.value = localDraft.value.description;
  origBody.value = localDraft.value.body;
  origAiAmendable.value = localDraft.value.aiAmendable;
  origAllProjects.value = localDraft.value.allProjects;
  origProjectIds.value = [...localDraft.value.projectIds];
}

const selectedId = computed(() => localDraft.value.id);
const canDelete = computed(() => Boolean(localDraft.value.id));
const confirmDelete = ref(false);
const isSystemSkill = computed(() => localDraft.value.source === 'system');
const canEdit = computed(() => !isSystemSkill.value && Boolean(localDraft.value.id));
const canClone = computed(() => isSystemSkill.value && Boolean(localDraft.value.type));
const reviewRows = computed(() => [...(localDraft.value.reviews || [])].sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
const ratingBuckets = computed(() => {
  const buckets = [0, 0, 0, 0, 0];
  for (const review of localDraft.value.reviews || []) {
    if (review.stars >= 1 && review.stars <= 5) buckets[review.stars - 1] += 1;
  }
  return buckets.map((count, index) => ({
    stars: index + 1,
    count,
    percent: localDraft.value.reviewCount > 0 ? Math.round((count / localDraft.value.reviewCount) * 100) : 0,
  })).reverse();
});
const selectedProjects = computed(() => {
  if (localDraft.value.allProjects) return [{ id: '__all__', name: 'All projects' }];
  const names = new Map(props.projects.map((project) => [project.id, project.name || project.canonicalPath]));
  return localDraft.value.projectIds.map((id) => ({ id, name: names.get(id) || id }));
});

function selectAllProjects(): void {
  localDraft.value.allProjects = true;
  localDraft.value.projectIds = [];
}

function toggleProject(projectId: string): void {
  const selected = new Set(localDraft.value.projectIds);
  if (selected.has(projectId)) selected.delete(projectId);
  else selected.add(projectId);
  localDraft.value.projectIds = [...selected];
  localDraft.value.allProjects = localDraft.value.projectIds.length === 0;
}

function formatReviewDate(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleDateString();
}
</script>

<template>
  <div class="settings-skills-panel">
    <SettingsPane class="settings-skills-list">
      <div class="skill-filter-bar">
        <input
          v-model="filterText"
          class="skill-filter-input focusable"
          type="text"
          placeholder="Filter skills…"
        />
        <div class="skill-filter-badges">
          <button
            class="plan-header__chip focusable"
            :class="{ yes: filterBadges.name }"
            @click="filterBadges.name = !filterBadges.name"
          >name</button>
          <button
            class="plan-header__chip focusable"
            :class="{ yes: filterBadges.trigger }"
            @click="filterBadges.trigger = !filterBadges.trigger"
          >trigger</button>
          <button
            class="plan-header__chip focusable"
            :class="{ yes: filterBadges.body }"
            @click="filterBadges.body = !filterBadges.body"
          >body</button>
        </div>
      </div>

      <div class="settings-list">
        <button
          v-for="skill in filteredSkills"
          :key="skill.id"
          class="settings-list-item settings-skill-item focusable"
          :class="{ 'settings-skill-item--active': skill.id === selectedId }"
          @click="emit('select', skill.id)"
        >
          <div class="skill-item-header">
            <span class="settings-list-item__name">{{ skill.name }}</span>
            <span
              v-if="skill.source === 'system' || skill.aiAmendable"
              class="settings-skill-badge"
              :class="{ 'settings-skill-badge--open': skill.aiAmendable, 'settings-skill-badge--system': skill.source === 'system' }"
            >
              {{ skill.source === 'system' ? 'system' : 'AI amend' }}
            </span>
          </div>
          <span class="skill-item-description">{{ skill.description }}</span>
          <div class="skill-item-footer">
            <span class="settings-skill-scope">
              {{ skill.allProjects ? 'all projects' : `${skill.projectIds.length} project${skill.projectIds.length === 1 ? '' : 's'}` }}
            </span>
            <span class="settings-skill-scope">{{ skill.useCount }} uses</span>
            <span v-if="skill.reviewCount > 0" class="skill-list-rating">★ {{ skill.avgRating.toFixed(1) }}</span>
          </div>
        </button>
      </div>

      <div v-if="filteredSkills.length === 0" class="tools-empty">
        {{ skills.length === 0 ? 'No skills configured.' : 'No skills match filter.' }}
      </div>

      <div class="settings-tool-actions">
        <button class="btn btn--secondary btn--sm focusable" @click="emit('new')">
          + New Skill
        </button>
        <button class="btn btn--secondary btn--sm focusable" @click="emit('resetAllCounts')">
          Reset All Counts
        </button>
      </div>
    </SettingsPane>

    <SettingsPane class="settings-skill-editor">
      <div class="skill-tabs">
        <button
          class="skill-tab focusable"
          :class="{ 'skill-tab--active': activeTab === 'definition' }"
          :aria-selected="String(activeTab === 'definition')"
          @click="activeTab = 'definition'"
        >
          Definition
        </button>
        <button
          class="skill-tab focusable"
          :class="{ 'skill-tab--active': activeTab === 'reviews' }"
          :aria-selected="String(activeTab === 'reviews')"
          @click="activeTab = 'reviews'"
        >
          Reviews
        </button>
      </div>

      <template v-if="activeTab === 'definition'">
        <div class="field-group">
          <label class="field-label">Name</label>
          <input
            v-model="localDraft.name"
            class="field-input focusable"
            type="text"
            :disabled="isSystemSkill"
          />
        </div>

        <div class="field-group">
          <label class="field-label">When to trigger</label>
          <textarea
            v-model="localDraft.description"
            class="field-input focusable"
            rows="3"
            :disabled="isSystemSkill"
          />
        </div>

        <div class="field-group">
          <label class="field-label">Body</label>
          <textarea
            v-model="localDraft.body"
            class="field-input focusable settings-skill-body"
            rows="12"
            :disabled="isSystemSkill"
          />
        </div>

        <div class="field-group">
          <label class="field-label">Projects</label>
          <div class="settings-skill-project-picker">
            <button
              type="button"
              class="settings-skill-project-option focusable"
              :class="{ 'settings-skill-project-option--selected': localDraft.allProjects }"
              :disabled="isSystemSkill"
              @click="selectAllProjects"
            >
              All projects
            </button>
            <button
              v-for="project in projects"
              :key="project.id"
              type="button"
              class="settings-skill-project-option focusable"
              :class="{ 'settings-skill-project-option--selected': localDraft.projectIds.includes(project.id) && !localDraft.allProjects }"
              :disabled="isSystemSkill"
              @click="toggleProject(project.id)"
            >
              {{ project.name || project.canonicalPath }}
            </button>
          </div>
          <div class="settings-skill-project-chips">
            <span
              v-for="project in selectedProjects"
              :key="project.id"
              class="settings-skill-project-chip"
            >
              {{ project.name }}
            </span>
          </div>
        </div>

        <label class="settings-skill-checkbox">
          <input
            v-model="localDraft.aiAmendable"
            type="checkbox"
            class="focusable"
            :disabled="isSystemSkill"
          />
          <span>
            <strong>Allow AI to amend this skill</strong>
            <small>Unchecked skills are protected from MCP updates.</small>
          </span>
        </label>

        <p class="settings-form__hint">
          Skills are always read fresh from disk; AI amendments are visible on the next session_info call.
        </p>

        <div class="settings-tool-actions">
          <button v-if="canClone" class="btn btn--secondary focusable" @click="emit('clone', localDraft.id)">
            Clone as Override
          </button>
          <template v-if="!isSystemSkill">
            <button
              v-if="!confirmDelete"
              class="btn btn--danger focusable"
              :disabled="!canDelete"
              @click="confirmDelete = true"
            >
              Delete
            </button>
            <template v-else>
              <span class="skill-confirm-delete">Delete?</span>
              <button class="btn btn--danger focusable" @click="emit('delete', localDraft.id)">Yes</button>
              <button class="btn btn--secondary focusable" @click="confirmDelete = false">No</button>
            </template>
          </template>
        </div>
      </template>

      <div v-else class="skill-reviews-panel">
        <div class="skill-reviews-header">
          <div>
            <div class="skill-review-score">{{ localDraft.avgRating.toFixed(1) }} / 5</div>
            <div class="skill-review-meta">{{ localDraft.reviewCount }} reviews - {{ localDraft.useCount }} uses</div>
          </div>
          <div class="settings-tool-actions">
            <button class="btn btn--secondary btn--sm focusable" @click="emit('resetUseCount', localDraft.id)">
              Reset Count
            </button>
            <button class="btn btn--danger btn--sm focusable" @click="emit('clearReviews', localDraft.id)">
              Clear
            </button>
          </div>
        </div>

        <div class="skill-rating-bars">
          <div v-for="bucket in ratingBuckets" :key="bucket.stars" class="skill-rating-row">
            <span class="skill-rating-label">{{ bucket.stars }} star</span>
            <div class="skill-rating-track">
              <div class="skill-rating-fill" :style="{ width: `${bucket.percent}%` }" />
            </div>
            <span class="skill-rating-count">{{ bucket.count }}</span>
          </div>
        </div>

        <div class="skill-review-list">
          <article v-for="review in reviewRows" :key="`${review.timestamp}-${review.cliType}`" class="skill-review-entry">
            <div class="skill-review-entry__head">
              <span class="skill-review-stars">{{ '★'.repeat(review.stars) }}{{ '☆'.repeat(5 - review.stars) }}</span>
              <span>{{ review.cliName }} - {{ review.cliType }} - {{ formatReviewDate(review.timestamp) }}</span>
            </div>
            <p>{{ review.summary }}</p>
            <p v-if="review.improvement" class="skill-review-improvement">{{ review.improvement }}</p>
          </article>
          <div v-if="reviewRows.length === 0" class="tools-empty">
            No reviews yet.
          </div>
        </div>
      </div>
    </SettingsPane>
  </div>
</template>
