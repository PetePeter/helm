<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TeamViewProjection } from '../../team-view/team-view-projection.js';
import TeamMember from './TeamMember.vue';

const props = defineProps<{ projection: TeamViewProjection; activeSessionId: string | null }>();
const emit = defineEmits<{
  select: [sessionId: string]; rename: [sessionId: string, name: string];
  toggleLock: [sessionId: string, locked: boolean]; toggleVisibility: [sessionId: string];
  requestClose: [sessionId: string, name: string]; showArtifacts: [sessionId: string];
}>();
const collapsed = ref(new Set<string>());
const selectedDeskId = ref<string | null>(null);
const renameValue = ref('');
const selectedDesk = computed(() => props.projection.departments.flatMap(d => d.desks)
  .find(desk => desk.sessionId === selectedDeskId.value && !desk.hidden) ?? null);
function toggleDepartment(id: string): void {
  const next = new Set(collapsed.value);
  next.has(id) ? next.delete(id) : next.add(id);
  collapsed.value = next;
}
function isCollapsed(id: string, projectionCollapsed: boolean): boolean { return projectionCollapsed || collapsed.value.has(id); }
function selectDesk(sessionId: string): void {
  const desk = props.projection.departments.flatMap(d => d.desks).find(d => d.sessionId === sessionId);
  selectedDeskId.value = sessionId;
  renameValue.value = desk?.name ?? '';
}
async function copyReference(): Promise<void> {
  const desk = selectedDesk.value;
  if (!desk) return;
  try { await navigator.clipboard.writeText(`session:${desk.name} (${desk.cliType}) [${desk.sessionId}]`); }
  catch { /* Clipboard availability is environment-owned; this action is non-mutating. */ }
}
function commitRename(): void {
  const desk = selectedDesk.value;
  if (desk && renameValue.value.trim()) emit('rename', desk.sessionId, renameValue.value);
}
</script>

<template>
  <section class="team-view" aria-label="Team View">
    <header class="team-view__header"><h2>Team View</h2><span>{{ projection.visibleDeskCount }} people</span></header>
    <section v-for="department in projection.departments" :key="department.id" class="team-department">
      <button class="team-department__header" :aria-expanded="!isCollapsed(department.id, department.collapsed)" @click="toggleDepartment(department.id)">
        <span>{{ isCollapsed(department.id, department.collapsed) ? '▸' : '▾' }}</span>{{ department.name }} <small>{{ department.visibleDeskCount }}</small>
      </button>
      <div v-if="!isCollapsed(department.id, department.collapsed)" class="team-desks">
        <button v-for="desk in department.desks.filter(d => !d.hidden)" :key="desk.sessionId" class="team-desk" :class="{ 'team-desk--active': desk.sessionId === activeSessionId, 'team-desk--selected': desk.sessionId === selectedDeskId }" :aria-label="`${desk.name}, ${desk.state}, ${desk.focusLabel}`" @click="selectDesk(desk.sessionId)">
          <span class="team-desk__shortcut">{{ desk.focusLabel }}</span><strong>{{ desk.name }}</strong><span class="team-desk__state">{{ desk.state }}<template v-if="desk.waitingReason"> · {{ desk.waitingReason }}</template></span>
          <span class="team-desk__monitor" aria-hidden="true"><span v-for="(line, index) in desk.terminalTail" :key="index">{{ line || ' ' }}</span><span v-if="!desk.terminalTail.length">No output</span></span>
          <TeamMember :state="desk.state" />
        </button>
      </div>
    </section>
    <aside v-if="selectedDesk" class="team-actions" aria-label="Selected desk controls">
      <div class="team-actions__heading"><strong>{{ selectedDesk.name }}</strong><span>Read-only desk · {{ selectedDesk.focusLabel }} focuses its terminal</span></div>
      <div class="team-actions__controls">
        <button type="button" @click="emit('select', selectedDesk.sessionId)">Open terminal</button>
        <button type="button" @click="copyReference">Copy reference</button>
        <button type="button" @click="emit('toggleLock', selectedDesk.sessionId, !selectedDesk.locked)">{{ selectedDesk.locked ? 'Unlock' : 'Lock' }}</button>
        <button type="button" @click="emit('toggleVisibility', selectedDesk.sessionId)">Hide</button>
        <button v-if="selectedDesk.artifactCount > 0" type="button" @click="emit('showArtifacts', selectedDesk.sessionId)">Artifacts ({{ selectedDesk.artifactCount }})</button>
        <button type="button" :disabled="selectedDesk.locked" @click="emit('requestClose', selectedDesk.sessionId, selectedDesk.name)">Close</button>
      </div>
      <form class="team-actions__rename" @submit.prevent="commitRename">
        <label>Rename <input v-model="renameValue" maxlength="50" aria-label="Selected desk name" /></label>
        <button type="submit">Save</button>
      </form>
    </aside>
  </section>
</template>

<style scoped>
.team-view{height:100%;overflow:auto;padding:14px;background:#111b26;color:#dbe8f5}.team-view__header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #294052;margin-bottom:10px}.team-view h2{margin:0 0 8px;font-size:16px}.team-view__header span,.team-desk__state,.team-actions__heading span{color:#9fb6cc;font-size:12px}.team-department{margin-bottom:12px}.team-department__header{width:100%;border:0;background:#1a2a39;color:#e7f1fb;text-align:left;padding:7px 9px;font-weight:700;cursor:pointer}.team-department__header span{display:inline-block;width:18px}.team-department__header small{color:#9fb6cc;margin-left:6px}.team-desks{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:9px;padding:9px 0}.team-desk{position:relative;min-height:130px;overflow:hidden;text-align:left;border:1px solid #30485d;border-radius:6px;background:#172432;color:#e7f1fb;padding:9px;padding-right:56px;cursor:pointer}.team-desk:hover,.team-desk:focus-visible,.team-desk--active,.team-desk--selected{border-color:#72b8ff;outline:none}.team-desk strong,.team-desk__state{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.team-desk__shortcut{position:absolute;top:7px;right:7px;color:#9fd0ff;font:600 11px monospace}.team-desk__monitor{display:block;margin-top:8px;min-height:44px;max-height:44px;overflow:hidden;border:1px solid #31495d;background:#090f15;padding:3px;font:9px/11px monospace;color:#a7cdb3}.team-desk__monitor span{display:block;white-space:pre;overflow:hidden;text-overflow:clip}.team-actions{position:sticky;bottom:0;border:1px solid #30485d;background:#172432;padding:8px;display:grid;gap:7px}.team-actions__heading{display:flex;justify-content:space-between;gap:8px}.team-actions__controls{display:flex;flex-wrap:wrap;gap:5px}.team-actions button,.team-actions input{background:#22364a;border:1px solid #48627b;border-radius:3px;color:#e7f1fb;padding:4px 7px;font:inherit}.team-actions button:disabled{opacity:.5}.team-actions__rename{display:flex;gap:5px}.team-actions__rename label{display:flex;gap:5px;align-items:center}.team-actions__rename input{min-width:140px}
</style>
