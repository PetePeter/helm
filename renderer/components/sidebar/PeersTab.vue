<script setup lang="ts">
/**
 * PeersTab.vue — Settings → 🔗 Peers. The steady-state fleet surface:
 * paired peers (online dot, access direction, enable toggle, "may call me", unpair),
 * a "Discover nearby" mDNS section with Pair buttons, and an Audit button that
 * opens the read-only PeerAuditModal. The SAS confirm dialog is mounted by the
 * app host and driven by the usePeers pairing state.
 *
 * Fleet is OFF by default — when it is, we still render the structure with a
 * clear "fleet is off" hint rather than a blank tab.
 */
import { computed, onMounted, ref } from 'vue';
import { usePeers, type ConfiguredPeer, type DiscoveredPeer, type FleetConfig, type PeerSession } from '../../composables/usePeers.js';
import { getPeerStatusColor } from '../../state-colors.js';
import PeerAuditModal from '../modals/PeerAuditModal.vue';
import FleetConfigPanel from './FleetConfigPanel.vue';

const {
  fleetEnabled,
  fleetConfig,
  fleetStatus,
  setFleetConfig,
  configuredPeers,
  discoveredPeers,
  ensureSubscribed,
  startPairing,
  startPairingByAddress,
  setInbound,
  setEnabled,
  unpair,
  listPeerSessions,
  attachPeerSession,
} = usePeers();

function onFleetUpdate(updates: Partial<FleetConfig>): void {
  void setFleetConfig(updates);
}

// Remote attach picker — one peer at a time.
const attachPeerId = ref<string | null>(null);
const attachSessions = ref<PeerSession[]>([]);
const attachError = ref('');

async function toggleAttach(peer: ConfiguredPeer): Promise<void> {
  attachError.value = '';
  attachSessions.value = [];
  if (attachPeerId.value === peer.id) { attachPeerId.value = null; return; }
  attachPeerId.value = peer.id;
  try {
    attachSessions.value = await listPeerSessions(peer.id);
  } catch (err) {
    attachError.value = err instanceof Error ? err.message : String(err);
  }
}

async function onAttach(peer: ConfiguredPeer, session: PeerSession): Promise<void> {
  const result = await attachPeerSession(peer.id, session.id);
  if (result.ok) attachPeerId.value = null;
  else attachError.value = result.error ?? 'Attach failed';
}

const auditVisible = ref(false);
const manualAddress = ref('');

/**
 * What the discovery section is actually doing. An empty list is ambiguous —
 * it can mean "scanning", "nothing out there", or "the stack is dead" — and
 * showing the same "No nearby peers found" for all three is what hid a startup
 * crash from view.
 */
const discoveryState = computed<'off' | 'error' | 'scanning' | 'found'>(() => {
  if (!fleetEnabled.value) return 'off';
  if (fleetStatus.value.error || !fleetStatus.value.running) return 'error';
  return pairableDiscovered.value.length > 0 ? 'found' : 'scanning';
});

function onPairManual(): void {
  const address = manualAddress.value.trim();
  if (!address) return;
  void startPairingByAddress(address);
  manualAddress.value = '';
}

onMounted(() => {
  ensureSubscribed();
});

/** Peers discovered on the LAN that are not already configured (paired). */
const pairableDiscovered = computed<DiscoveredPeer[]>(() => {
  const pairedMachineIds = new Set(configuredPeers.value.map((p) => p.machineId).filter(Boolean));
  return discoveredPeers.value.filter((d) => !pairedMachineIds.has(d.machineId));
});

function statusFor(peer: ConfiguredPeer): 'online' | 'offline' {
  return peer.online ? 'online' : 'offline';
}

function dotColor(peer: ConfiguredPeer): string {
  return getPeerStatusColor(statusFor(peer));
}

/**
 * The combined direction: my grant (`inbound`, them → me) plus the peer's
 * reported grant (`peerAllowsMe`, me → them). Each machine sets only its own half.
 */
function accessLabel(peer: ConfiguredPeer): string {
  const meToThem = peer.peerAllowsMe === true;
  if (peer.inbound && meToThem) return '↔ both';
  if (peer.inbound) return '← them → me';
  if (meToThem) return '→ me → them';
  return peer.peerAllowsMe === undefined ? 'off (peer not heard yet)' : 'off';
}

function onToggleInbound(peer: ConfiguredPeer, event: Event): void {
  void setInbound(peer.id, (event.target as HTMLInputElement).checked);
}

function onToggleEnabled(peer: ConfiguredPeer, event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked;
  void setEnabled(peer.id, enabled);
}

function onUnpair(peer: ConfiguredPeer): void {
  void unpair(peer.id);
}

function onPair(peer: DiscoveredPeer): void {
  void startPairing(peer);
}

</script>

<template>
  <div class="peers-tab">
    <FleetConfigPanel :config="fleetConfig" :status="fleetStatus" @update="onFleetUpdate" />

    <div v-if="!fleetEnabled" class="peers-off-hint">
      Fleet is off — enable it above to pair with other machines.
    </div>

    <div class="peers-section">
      <div class="peers-section-head">
        <h4 class="peers-section-title">Paired peers</h4>
        <button class="btn btn--secondary btn--sm peers-audit-btn" type="button" @click="auditVisible = true">Audit</button>
      </div>

      <div v-if="configuredPeers.length === 0" class="peers-empty">No paired peers yet.</div>

      <div v-for="peer in configuredPeers" :key="peer.id" class="peer-row" :data-peer-id="peer.id">
        <div class="peer-row-main">
          <span
            class="peer-dot"
            :class="`peer-dot--${statusFor(peer)}`"
            :style="{ backgroundColor: dotColor(peer) }"
            :title="statusFor(peer)"
          ></span>
          <span class="peer-alias">{{ peer.alias }}</span>
          <span class="peer-direction peer-access">{{ accessLabel(peer) }}</span>
          <span class="peer-spacer"></span>

          <label class="peer-toggle" title="Let this peer call my tools and open my sessions">
            <input
              type="checkbox"
              class="peer-inbound-input"
              :checked="peer.inbound"
              @change="onToggleInbound(peer, $event)"
            />
            <span class="peer-toggle-label">May call me</span>
          </label>

          <label class="peer-toggle" :title="peer.enabled ? 'Enabled' : 'Disabled'">
            <input
              type="checkbox"
              class="peer-enable-input"
              :checked="peer.enabled"
              @change="onToggleEnabled(peer, $event)"
            />
            <span class="peer-toggle-label">{{ peer.enabled ? 'On' : 'Off' }}</span>
          </label>

          <button
            class="btn btn--secondary btn--sm peer-attach-toggle"
            type="button"
            :disabled="!peer.online"
            title="Drive one of this peer's sessions from here (Remote)"
            @click="toggleAttach(peer)"
          >Attach…</button>
          <button class="btn btn--danger btn--sm peer-unpair" type="button" @click="onUnpair(peer)">Unpair</button>
        </div>

        <div v-if="attachPeerId === peer.id" class="peer-attach-picker">
          <div v-if="attachError" class="peer-attach-error">{{ attachError }}</div>
          <div v-else-if="attachSessions.length === 0" class="peers-empty">No sessions on this peer.</div>
          <div v-for="session in attachSessions" :key="session.id" class="peer-session-row">
            <span class="peer-alias">{{ session.name }}</span>
            <span class="peer-direction">{{ session.cliType }}</span>
            <span class="peer-spacer"></span>
            <button class="btn btn--primary btn--sm peer-session-attach" type="button" @click="onAttach(peer, session)">Attach</button>
          </div>
        </div>

      </div>
    </div>

    <div class="peers-section">
      <div class="peers-section-head">
        <h4 class="peers-section-title">Discover nearby</h4>
        <span class="peers-discovery-state" :class="`peers-discovery-state--${discoveryState}`">
          <template v-if="discoveryState === 'off'">not running</template>
          <template v-else-if="discoveryState === 'error'">discovery not running</template>
          <template v-else-if="discoveryState === 'scanning'">scanning…</template>
          <template v-else>{{ pairableDiscovered.length }} found</template>
        </span>
      </div>

      <div v-for="peer in pairableDiscovered" :key="peer.machineId" class="peer-discovered-row">
        <span class="peer-alias">{{ peer.alias }}</span>
        <span class="peer-address">{{ peer.address }}</span>
        <span class="peer-spacer"></span>
        <button class="btn btn--primary btn--sm peer-pair-btn" type="button" @click="onPair(peer)">Pair</button>
      </div>

      <p v-if="discoveryState === 'scanning'" class="peers-empty">
        Nothing found yet. Discovery does not cross subnets or Wi-Fi client isolation —
        add the address directly below.
      </p>

      <div class="peer-manual">
        <input
          v-model="manualAddress"
          type="text"
          class="peer-add-input focusable"
          placeholder="10.98.1.140:47474"
          :disabled="!fleetEnabled"
          @keydown.enter.prevent="onPairManual"
        />
        <button
          class="btn btn--secondary btn--sm"
          type="button"
          :disabled="!fleetEnabled || !manualAddress.trim()"
          @click="onPairManual"
        >Pair by address</button>
      </div>
    </div>

    <PeerAuditModal v-model:visible="auditVisible" />
  </div>
</template>

<style scoped>
.peers-tab {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.peers-off-hint {
  padding: 6px 8px;
  background: rgba(255,159,26,0.12);
  border: 1px solid rgba(255,159,26,0.4);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.85rem;
}
.peers-section { display: flex; flex-direction: column; gap: 6px; }
.peers-section-head { display: flex; align-items: center; gap: 8px; }
.peers-section-title { margin: 0; font-size: 0.88rem; color: var(--text-primary); }
.peers-audit-btn { margin-left: auto; }
.peers-empty { margin: 0; color: var(--text-secondary); font-size: 0.78rem; line-height: 1.35; }

.peer-row {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-primary);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.peer-row-main { display: flex; align-items: center; gap: 8px; }
.peer-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.peer-alias { font-weight: 600; font-size: 0.9rem; color: var(--text-primary); }
.peer-direction { font-size: 0.76rem; color: var(--text-secondary); }
.peer-address { font-size: 0.8rem; color: var(--text-secondary); font-family: ui-monospace, "Cascadia Code", monospace; }
.peer-spacer { margin-left: auto; }

.peer-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.peer-enable-input,
.peer-inbound-input { width: 16px; height: 16px; cursor: pointer; }
.peer-toggle-label { font-size: 0.78rem; color: var(--text-secondary); }

.peer-attach-picker {
  border-top: 1px solid var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.peer-add-input {
  flex: 1; min-width: 160px; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg-primary); color: var(--text-primary); font-size: 0.85rem;
}

.peer-discovered-row,
.peer-session-row {
  display: flex; align-items: center; gap: 8px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-primary); padding: 5px 8px;
}
.peer-attach-error {
  color: var(--danger);
  font-size: 0.8rem;
}
.peers-discovery-state {
  margin-left: auto;
  font-size: 0.76rem;
  color: var(--text-secondary);
}
.peers-discovery-state--error { color: #ff6666; }
.peers-discovery-state--found { color: #44cc44; }
.peer-manual { display: flex; gap: 8px; align-items: center; }

</style>
