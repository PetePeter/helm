<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { TeamViewProjection } from '../../team-view/team-view-projection.js';
import type { SessionMessageFlight } from '../../../src/session/message-flight.js';
import { getActivityColor, MESSAGE_FLIGHT_COLORS } from '../../state-colors.js';
import { sessionsClient } from '../../ipc/clients.js';
import { useRecycleBin } from '../../composables/useRecycleBin.js';
import { useLlmNotificationsStore } from '../../stores/llmNotifications.js';
import TeamMember from './TeamMember.vue';
import NotificationCarousel from '../sidebar/NotificationCarousel.vue';

const props = defineProps<{ projection: TeamViewProjection; activeSessionId: string | null }>();
const emit = defineEmits<{
  select: [sessionId: string]; rename: [sessionId: string, name: string];
  toggleLock: [sessionId: string, locked: boolean]; toggleVisibility: [sessionId: string];
  requestClose: [sessionId: string, name: string]; showArtifacts: [sessionId: string];
  toggleDepartment: [departmentId: string];
}>();
const renameValue = ref('');
const renameInput = ref<HTMLInputElement | null>(null);
// Dismissal goes through the shared llmNotifications store so Team View and
// Session List clear the same notification, never two copies of it.
const llmNotifications = useLlmNotificationsStore();
// Shared bin singleton — same count and modal the Session List button drives.
const recycleBin = useRecycleBin();
// One popover at a time: the id of the desk whose notification list is open.
const openNotificationsDeskId = ref<string | null>(null);
const selectedDesk = computed(() => props.projection.departments.flatMap(d => d.desks)
  .find(desk => desk.sessionId === props.activeSessionId) ?? null);
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

// Opening a popover is a desk-local read: it must never select the desk.
function toggleNotifications(sessionId: string): void {
  openNotificationsDeskId.value = openNotificationsDeskId.value === sessionId ? null : sessionId;
}

// Ctrl+Shift+R collides with the Session List rename shortcut. When Team View
// owns the screen and a desk is selected it claims the chord for the rename
// input; otherwise the chord falls through untouched.
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (openNotificationsDeskId.value !== null) openNotificationsDeskId.value = null;
    return;
  }
  if (event.key !== 'r' && event.key !== 'R') return;
  if (!event.ctrlKey || !event.shiftKey) return;
  if (!selectedDesk.value) return;
  event.preventDefault();
  event.stopPropagation();
  renameInput.value?.focus();
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
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  stopFlightEvents?.();
  stopFlightEvents = null;
  document.removeEventListener('keydown', onKeydown);
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
    <!--
      One persistent operator bar, sticky at the top: selection context first,
      then the action buttons + rename form when a desk is selected.
    -->
    <aside class="team-actions" aria-label="Selected desk controls">
      <div class="team-actions__heading">
        <template v-if="selectedDesk">
          <strong>{{ selectedDesk.name }}</strong>
          <span>Read-only desk · {{ selectedDesk.focusLabel }} focuses its terminal</span>
        </template>
        <span v-else>Select a desk</span>
      </div>
      <div v-if="selectedDesk" class="team-actions__controls">
        <button type="button" @click="emit('select', selectedDesk.sessionId)">Open terminal</button>
        <button type="button" @click="copyReference">Copy reference</button>
        <button type="button" @click="emit('toggleLock', selectedDesk.sessionId, !selectedDesk.locked)">{{ selectedDesk.locked ? 'Unlock' : 'Lock' }}</button>
        <button type="button" @click="emit('toggleVisibility', selectedDesk.sessionId)">{{ selectedDesk.hidden ? 'Unhide' : 'Hide' }}</button>
        <button v-if="selectedDesk.artifactCount > 0" type="button" @click="emit('showArtifacts', selectedDesk.sessionId)">Artifacts ({{ selectedDesk.artifactCount }})</button>
        <button type="button" :disabled="selectedDesk.locked" @click="emit('requestClose', selectedDesk.sessionId, selectedDesk.name)">Close</button>
      </div>
      <form v-if="selectedDesk" class="team-actions__rename" @submit.prevent="commitRename">
        <label>Rename <input ref="renameInput" v-model="renameValue" maxlength="50" aria-label="Selected desk name" /></label>
        <button type="submit">Save</button>
      </form>
    </aside>
    <section v-for="department in projection.departments" :key="department.id" class="team-department">
      <button class="team-department__header" :aria-expanded="!isCollapsed(department.id, department.collapsed)" @click="toggleDepartment(department.id)">
        <span>{{ isCollapsed(department.id, department.collapsed) ? '▸' : '▾' }}</span>{{ department.name }} <small>{{ department.visibleDeskCount }}</small>
      </button>
      <div v-if="!isCollapsed(department.id, department.collapsed)" class="team-desks">
        <button v-for="desk in department.desks" :key="desk.sessionId" :data-desk-id="desk.sessionId" class="team-desk" :class="{ 'team-desk--active': desk.sessionId === activeSessionId, 'team-desk--selected': desk.sessionId === activeSessionId, 'team-desk--hidden': desk.hidden }" :aria-current="desk.sessionId === activeSessionId ? 'true' : undefined" :aria-label="`${desk.name}${desk.hidden ? ', hidden' : `, ${desk.state}`}${desk.focusLabel ? `, ${desk.focusLabel}` : ''}`" @click="selectDesk(desk.sessionId)">
          <!-- Hidden desks collapse to a name-only row, selectable + operable
               from the operator bar like any other desk. -->
          <template v-if="desk.hidden"><span class="team-desk__info"><strong>{{ desk.name }}</strong></span></template>
          <template v-else>
            <span class="team-desk__info">
              <span v-if="desk.focusLabel" class="team-desk__shortcut">{{ desk.focusLabel }}</span><strong>{{ desk.name }}</strong><span class="team-desk__state"><span class="team-desk__activity-dot" :style="{ '--dot-colour': getActivityColor(desk.activityLevel) }" aria-hidden="true"></span>{{ desk.state }}<template v-if="desk.waitingReason"> · {{ desk.waitingReason }}</template><button v-if="desk.notifications.length > 0" type="button" class="team-desk__notification-badge" :aria-label="`${desk.notifications.length} notifications for ${desk.name}`" @click.stop="toggleNotifications(desk.sessionId)">{{ desk.notifications.length }}</button></span>
              <span class="team-desk__monitor" aria-hidden="true"><span v-for="(line, index) in desk.terminalTail" :key="index">{{ line || ' ' }}</span><span v-if="!desk.terminalTail.length">No output</span></span>
            </span>
            <span class="team-desk__avatar" aria-hidden="true"><TeamMember :state="desk.state" :alert="desk.notifications.length > 0" /></span>
            <div
              v-if="openNotificationsDeskId === desk.sessionId"
              class="team-desk__notifications"
              role="dialog"
              :aria-label="`${desk.name} notifications`"
              @click.stop
            >
              <NotificationCarousel
                :notifications="desk.notifications"
                :session-id="desk.sessionId"
                @dismiss="id => llmNotifications.dismiss(id)"
                @dismiss-all="sessionId => llmNotifications.dismissSession(sessionId)"
              />
            </div>
          </template>
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
    <!-- Same bin the Session List opens: the shared useRecycleBin singleton
         owns the count and the globally-mounted RecycleBinModal. -->
    <button
      class="team-recycle-bin"
      type="button"
      title="Recycle Bin — restore closed sessions"
      @click="recycleBin.modalVisible.value = true"
    >
      <span aria-hidden="true">🗑️</span>
      <span>Recycle Bin</span>
      <span v-if="recycleBin.count.value > 0" class="team-recycle-bin__badge">{{ recycleBin.count.value }}</span>
    </button>
  </section>
</template>

<style scoped>
.team-view{position:relative;height:100%;overflow:auto;padding:14px;background:var(--bg-primary);color:var(--text-primary)}
.team-desk__activity-dot{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;background:var(--dot-colour,var(--text-dim));vertical-align:baseline}
.team-view__flight{position:absolute;z-index:6;pointer-events:none;color:var(--flight-colour,var(--status-ready));animation:team-message-flight 1s ease-in-out forwards}
.team-view__flight svg{display:block;filter:drop-shadow(0 0 3px var(--flight-colour,var(--status-ready)))}
@keyframes team-message-flight{from{transform:translate(0,0)}to{transform:translate(var(--flight-dx,0),var(--flight-dy,0))}}

.team-view__header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--border);margin-bottom:10px}
.team-view h2{margin:0 0 8px;font-size:var(--font-size-lg)}
.team-view__header span,.team-desk__state,.team-actions__heading span{color:var(--text-secondary);font-size:var(--font-size-sm)}
.team-department{margin-bottom:12px}
.team-department__header{width:100%;border:0;background:var(--bg-tertiary);color:var(--text-primary);text-align:left;padding:7px 9px;font-weight:700;cursor:pointer}
.team-department__header span{display:inline-block;width:18px}
.team-department__header small{color:var(--text-secondary);margin-left:6px}

/* Responsive desk grid. Each tile is an inline-size container so it can
   compress (drop its monitor) when its column gets too narrow. */
.team-desks{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:9px;padding:9px 0}
.team-desk{position:relative;container-type:inline-size;display:flex;align-items:flex-end;gap:8px;text-align:left;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-secondary);color:var(--text-primary);padding:9px;cursor:pointer}
.team-desk:hover,.team-desk:focus-visible,.team-desk--active,.team-desk--selected{border-color:var(--accent);outline:none}
.team-desk__info{position:relative;flex:1;min-width:0}
.team-desk strong,.team-desk__state{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.team-desk__shortcut{position:absolute;top:0;right:0;color:var(--accent);font:600 var(--font-size-xs) var(--font-mono)}
.team-desk__monitor{display:block;margin-top:8px;max-height:44px;overflow:hidden;border:1px solid var(--border);background:var(--bg-primary);padding:3px;font:9px/11px var(--font-mono);color:var(--text-secondary)}
.team-desk__monitor span{display:block;white-space:pre;overflow:hidden;text-overflow:clip}
/* Fixed avatar rail: the member can never render outside its tile. */
.team-desk__avatar{flex:0 0 56px;width:56px;max-height:96px;display:flex;align-items:flex-end;justify-content:center;overflow:hidden}
@container (max-width:280px){.team-desk__monitor{display:none}}

/* Unread-notification pill, inline after the desk state text. */
.team-desk__notification-badge{display:inline-block;margin-left:6px;padding:1px 7px;border:1px solid var(--accent);border-radius:999px;background:var(--accent);color:var(--bg-primary);font:600 var(--font-size-xs) var(--font-mono);line-height:1.5;cursor:pointer;vertical-align:baseline}
.team-desk__notification-badge:hover,.team-desk__notification-badge:focus-visible{outline:none;filter:brightness(1.15)}
/* One notification popover at a time, anchored inside its desk tile. */
.team-desk__notifications{position:absolute;top:calc(100% - 4px);right:8px;z-index:7;width:min(260px,92%);padding:6px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-secondary)}

/* Hidden desks: a quiet name-only row, still selectable + operable. */
.team-desk--hidden{align-items:center;min-height:0;padding:4px 9px;color:var(--text-secondary)}
.team-desk--hidden:hover,.team-desk--hidden:focus-visible,.team-desk--hidden.team-desk--active,.team-desk--hidden.team-desk--selected{color:var(--text-primary)}

/* Bin entry pinned to the very bottom — same singleton the Session List opens. */
.team-recycle-bin{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;gap:8px;margin-top:4px;padding:6px 9px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-secondary);color:var(--text-secondary);font:inherit;cursor:pointer}
.team-recycle-bin:hover,.team-recycle-bin:focus-visible{color:var(--text-primary);border-color:var(--accent);outline:none}
.team-recycle-bin__badge{margin-left:auto;padding:1px 7px;border-radius:999px;background:var(--accent);color:var(--bg-primary);font:600 var(--font-size-xs) var(--font-mono)}

/* Sticky top operator bar — one persistent location, always visible. */
.team-actions{position:sticky;top:0;z-index:5;display:grid;gap:7px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-secondary)}
.team-actions__heading{display:flex;justify-content:space-between;gap:8px}
.team-actions__controls{display:flex;flex-wrap:wrap;gap:5px}
.team-actions button,.team-actions input{background:var(--bg-tertiary);border:1px solid var(--border);border-radius:3px;color:var(--text-primary);padding:4px 7px;font:inherit}
.team-actions button:disabled{opacity:.5}
.team-actions__rename{display:flex;gap:5px}
.team-actions__rename label{display:flex;gap:5px;align-items:center}
.team-actions__rename input{min-width:140px}
</style>
