<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { TeamViewProjection } from '../../team-view/team-view-projection.js';
import type { SessionMessageFlight } from '../../../src/session/message-flight.js';
import { getActivityColor, MESSAGE_FLIGHT_COLORS } from '../../state-colors.js';
import { sessionsClient } from '../../ipc/clients.js';
import TeamMember from './TeamMember.vue';

const props = defineProps<{ projection: TeamViewProjection; activeSessionId: string | null }>();
const emit = defineEmits<{
  select: [sessionId: string]; rename: [sessionId: string, name: string];
  toggleLock: [sessionId: string, locked: boolean]; toggleVisibility: [sessionId: string];
  requestClose: [sessionId: string, name: string]; showArtifacts: [sessionId: string];
  toggleDepartment: [departmentId: string];
}>();
const renameValue = ref('');
const selectedDesk = computed(() => props.projection.departments.flatMap(d => d.desks)
  .find(desk => desk.sessionId === props.activeSessionId && !desk.hidden) ?? null);
function toggleDepartment(id: string): void {
  emit('toggleDepartment', id);
}
function isCollapsed(_id: string, projectionCollapsed: boolean): boolean { return projectionCollapsed; }
function selectDesk(sessionId: string): void {
  const desk = props.projection.departments.flatMap(d => d.desks).find(d => d.sessionId === sessionId);
  renameValue.value = desk?.name ?? '';
  // This is the existing session-selection boundary used by Session List and
  // Ctrl+number. Team View never focuses or writes a terminal itself.
  emit('select', sessionId);
}

// ------------------------------------------------------------------------
// Message flights — the envelope animation that precedes every inter-session
// paste. The PTY write is held in the main process until the flight is acked,
// so landing the envelope IS releasing the message.
// ------------------------------------------------------------------------

interface DeskFlight {
  id: string;
  fromX: number;
  fromY: number;
  dx: number;
  dy: number;
  colour: string;
}

const rootEl = ref<HTMLElement | null>(null);
const flights = ref<DeskFlight[]>([]);
let stopFlightEvents: (() => void) | null = null;

function deskCentre(sessionId: string): { x: number; y: number } | null {
  const root = rootEl.value;
  if (!root) return null;
  // Dataset comparison rather than an attribute selector: session ids include
  // characters (mobile proxies, UUIDs) that would need CSS escaping.
  const desk = Array.from(root.querySelectorAll<HTMLElement>('[data-desk-id]'))
    .find(el => el.dataset.deskId === sessionId);
  if (!desk) return null;
  const deskRect = desk.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  return {
    x: deskRect.left - rootRect.left + deskRect.width / 2,
    y: deskRect.top - rootRect.top + deskRect.height / 2,
  };
}

function onFlight(event: SessionMessageFlight): void {
  const to = deskCentre(event.recipientSessionId);
  if (!to) {
    // No desk to land on (closed session, other project) — release immediately
    // so the held paste is never hostage to a missing desk.
    releaseFlight(event.flightId);
    return;
  }
  // Senders without a desk (phone, mobile proxy) fly in from the pane corner.
  const from = deskCentre(event.senderSessionId) ?? { x: 10, y: 10 };
  flights.value = [...flights.value, {
    id: event.flightId,
    fromX: from.x,
    fromY: from.y,
    dx: to.x - from.x,
    dy: to.y - from.y,
    colour: event.isReply ? MESSAGE_FLIGHT_COLORS.reply : MESSAGE_FLIGHT_COLORS.send,
  }];
}

function onFlightLanded(flightId: string): void {
  flights.value = flights.value.filter(flight => flight.id !== flightId);
  releaseFlight(flightId);
}

/** Fire-and-forget ack: a failed ack must not surface as an unhandled rejection. */
function releaseFlight(flightId: string): void {
  sessionsClient.ackSessionMessageFlight(flightId)?.catch(() => {});
}

function flightStyle(flight: DeskFlight): Record<string, string> {
  return {
    left: `${flight.fromX}px`,
    top: `${flight.fromY}px`,
    '--flight-colour': flight.colour,
    '--flight-dx': `${flight.dx}px`,
    '--flight-dy': `${flight.dy}px`,
  };
}

onMounted(() => {
  stopFlightEvents = sessionsClient.onSessionMessageFlight?.(onFlight) ?? null;
});
onBeforeUnmount(() => {
  stopFlightEvents?.();
  stopFlightEvents = null;
});
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
  <section ref="rootEl" class="team-view" aria-label="Team View">
    <header class="team-view__header"><h2>Team View</h2><span>{{ projection.visibleDeskCount }} people</span></header>
    <section v-for="department in projection.departments" :key="department.id" class="team-department">
      <button class="team-department__header" :aria-expanded="!isCollapsed(department.id, department.collapsed)" @click="toggleDepartment(department.id)">
        <span>{{ isCollapsed(department.id, department.collapsed) ? '▸' : '▾' }}</span>{{ department.name }} <small>{{ department.visibleDeskCount }}</small>
      </button>
      <div v-if="!isCollapsed(department.id, department.collapsed)" class="team-desks">
        <button v-for="desk in department.desks.filter(d => !d.hidden)" :key="desk.sessionId" :data-desk-id="desk.sessionId" class="team-desk" :class="{ 'team-desk--active': desk.sessionId === activeSessionId, 'team-desk--selected': desk.sessionId === activeSessionId }" :aria-current="desk.sessionId === activeSessionId ? 'true' : undefined" :aria-label="`${desk.name}, ${desk.state}${desk.focusLabel ? `, ${desk.focusLabel}` : ''}`" @click="selectDesk(desk.sessionId)">
          <span v-if="desk.focusLabel" class="team-desk__shortcut">{{ desk.focusLabel }}</span><strong>{{ desk.name }}</strong><span class="team-desk__state"><span class="team-desk__activity-dot" :style="{ '--dot-colour': getActivityColor(desk.activityLevel) }" aria-hidden="true"></span>{{ desk.state }}<template v-if="desk.waitingReason"> · {{ desk.waitingReason }}</template></span>
          <span class="team-desk__monitor" aria-hidden="true"><span v-for="(line, index) in desk.terminalTail" :key="index">{{ line || ' ' }}</span><span v-if="!desk.terminalTail.length">No output</span></span>
          <TeamMember :state="desk.state" />
        </button>
      </div>
    </section>
    <span
      v-for="flight in flights"
      :key="flight.id"
      class="team-view__flight"
      :style="flightStyle(flight)"
      aria-hidden="true"
      @animationend="onFlightLanded(flight.id)"
    >
      <svg width="18" height="12" viewBox="0 0 18 12" fill="none" aria-hidden="true">
        <rect x="0.75" y="0.75" width="16.5" height="10.5" rx="1.5" stroke="currentColor" stroke-width="1.5" />
        <path d="M1.5 1.5 9 7l7.5-5.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    </span>
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
.team-view{position:relative;height:100%;overflow:auto;padding:14px;background:#111b26;color:#dbe8f5}
.team-desk__activity-dot{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;background:var(--dot-colour,#555);vertical-align:baseline}
.team-view__flight{position:absolute;z-index:6;pointer-events:none;color:var(--flight-colour,#4488ff);animation:team-message-flight 1s ease-in-out forwards}
.team-view__flight svg{display:block;filter:drop-shadow(0 0 3px var(--flight-colour,#4488ff))}
@keyframes team-message-flight{from{transform:translate(0,0)}to{transform:translate(var(--flight-dx,0),var(--flight-dy,0))}}.team-view__header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #294052;margin-bottom:10px}.team-view h2{margin:0 0 8px;font-size:16px}.team-view__header span,.team-desk__state,.team-actions__heading span{color:#9fb6cc;font-size:12px}.team-department{margin-bottom:12px}.team-department__header{width:100%;border:0;background:#1a2a39;color:#e7f1fb;text-align:left;padding:7px 9px;font-weight:700;cursor:pointer}.team-department__header span{display:inline-block;width:18px}.team-department__header small{color:#9fb6cc;margin-left:6px}.team-desks{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:9px;padding:9px 0}.team-desk{position:relative;min-height:130px;overflow:hidden;text-align:left;border:1px solid #30485d;border-radius:6px;background:#172432;color:#e7f1fb;padding:9px;padding-right:56px;cursor:pointer}.team-desk:hover,.team-desk:focus-visible,.team-desk--active,.team-desk--selected{border-color:#72b8ff;outline:none}.team-desk strong,.team-desk__state{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.team-desk__shortcut{position:absolute;top:7px;right:7px;color:#9fd0ff;font:600 11px monospace}.team-desk__monitor{display:block;margin-top:8px;min-height:44px;max-height:44px;overflow:hidden;border:1px solid #31495d;background:#090f15;padding:3px;font:9px/11px monospace;color:#a7cdb3}.team-desk__monitor span{display:block;white-space:pre;overflow:hidden;text-overflow:clip}.team-actions{position:sticky;bottom:0;border:1px solid #30485d;background:#172432;padding:8px;display:grid;gap:7px}.team-actions__heading{display:flex;justify-content:space-between;gap:8px}.team-actions__controls{display:flex;flex-wrap:wrap;gap:5px}.team-actions button,.team-actions input{background:#22364a;border:1px solid #48627b;border-radius:3px;color:#e7f1fb;padding:4px 7px;font:inherit}.team-actions button:disabled{opacity:.5}.team-actions__rename{display:flex;gap:5px}.team-actions__rename label{display:flex;gap:5px;align-items:center}.team-actions__rename input{min-width:140px}
</style>
