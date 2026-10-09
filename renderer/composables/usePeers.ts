/**
 * usePeers — reactive state for the cross-machine fleet (Peers) tab.
 *
 * Module-singleton refs shared by the PeersTab, the pairing dialog and the audit
 * modal. Mirrors useRecycleBin/useRuntimeGroups: ensureSubscribed() wires every
 * peer event once and does an initial refresh; actions delegate to peersClient
 * and defensively re-refresh so the UI stays consistent even if an event is
 * missed.
 */
import { computed, ref } from 'vue';
import { peersClient, configClient, eventsClient } from '../ipc/clients.js';

export interface FleetConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface ConfiguredPeer {
  id: string;
  machineId?: string;
  alias: string;
  address: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  /** Whether this peer may call me. */
  inbound: boolean;
  /** Whether the peer lets me call it, as it last reported (undefined = not yet). */
  peerAllowsMe?: boolean;
  enabled: boolean;
  online: boolean;
}

export interface DiscoveredPeer {
  machineId: string;
  alias: string;
  address: string;
}

export interface PeerAuditEntry {
  id: string;
  peerId: string;
  method: string;
  argSummary: string;
  outcome: 'ok' | 'denied' | 'rate-limited' | 'error';
  ranAt: number;
  error?: string;
}

export interface PairingState {
  active: boolean;
  sessionId: string | null;
  sas: string | null;
  status: 'idle' | 'starting' | 'awaiting-sas' | 'confirmed' | 'paired' | 'failed';
  error: string | null;
  peerAlias: string | null;
  /** True when the OTHER machine started this pairing (we are the responder). */
  incoming: boolean;
}

/** Live health of the fleet stack — distinct from the persisted config. */
export interface FleetStatus {
  enabled: boolean;
  running: boolean;
  error: string | null;
  addresses: string[];
  allInterfaces: boolean;
}

const DEFAULT_FLEET_CONFIG: FleetConfig = { enabled: false, host: '0.0.0.0', port: 47474 };

/**
 * How long the "Paired successfully" confirmation stays up before the dialog
 * closes itself. Long enough to register that it worked, short enough that the
 * user never has to dismiss a dialog whose decision has already been made.
 */
export const PAIRED_DISMISS_MS = 1500;

const fleetEnabled = ref(false);
const fleetConfig = ref<FleetConfig>({ ...DEFAULT_FLEET_CONFIG });
const configuredPeers = ref<ConfiguredPeer[]>([]);
const peerConfigLoaded = ref(false);
const discoveredPeers = ref<DiscoveredPeer[]>([]);
const audit = ref<PeerAuditEntry[]>([]);
const pairing = ref<PairingState>(emptyPairing());
const fleetStatus = ref<FleetStatus>({ enabled: false, running: false, error: null, addresses: [], allInterfaces: false });

let subscribed = false;
/** Pending auto-dismiss for a completed pairing (see PAIRED_DISMISS_MS). */
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function cancelDismiss(): void {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

/**
 * Close the dialog shortly after a successful pairing. Guarded on sessionId so a
 * pairing started during the delay is never closed by the previous one's timer.
 */
function scheduleDismiss(sessionId: string | null): void {
  cancelDismiss();
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    if (pairing.value.sessionId === sessionId) closePairing();
  }, PAIRED_DISMISS_MS);
}

function emptyPairing(): PairingState {
  return { active: false, sessionId: null, sas: null, status: 'idle', error: null, peerAlias: null, incoming: false };
}

/** Pull live status so the UI can say WHY nothing is happening. */
async function loadFleetStatus(): Promise<void> {
  try {
    const status = await configClient.configGetFleetStatus();
    if (status) fleetStatus.value = status;
  } catch {
    /* leave the last known status rather than flapping the UI */
  }
}

async function loadFleetConfig(): Promise<void> {
  try {
    const cfg = await configClient.configGetFleetConfig();
    fleetConfig.value = {
      enabled: cfg?.enabled ?? false,
      host: cfg?.host || DEFAULT_FLEET_CONFIG.host,
      port: cfg?.port ?? DEFAULT_FLEET_CONFIG.port,
    };
    // fleetEnabled derives from the persisted config (single source of truth).
    fleetEnabled.value = fleetConfig.value.enabled;
  } catch {
    fleetConfig.value = { ...DEFAULT_FLEET_CONFIG };
    fleetEnabled.value = false;
  }
}

async function refresh(): Promise<void> {
  await loadFleetConfig();
  await loadFleetStatus();
  try {
    configuredPeers.value = (await peersClient.peerList()) ?? [];
    peerConfigLoaded.value = true;
  } catch {
    // Preserve known peers on a transient IPC failure; they may be offline, not unpaired.
  }
  try {
    discoveredPeers.value = (await peersClient.peerListDiscovered()) ?? [];
  } catch {
    discoveredPeers.value = [];
  }
}

async function refreshAudit(): Promise<void> {
  try {
    audit.value = (await peersClient.peerGetAudit()) ?? [];
  } catch {
    audit.value = [];
  }
}

/** Subscribe once to all peer events, then (re)refresh. Safe to call repeatedly. */
function ensureSubscribed(): void {
  if (subscribed) {
    // Already wired — just re-pull current state (e.g. tab re-opened / remount).
    void refresh();
    return;
  }
  subscribed = true;

  eventsClient.onPeerConfigChanged?.(() => { void refresh(); });
  eventsClient.onPeerLinkStatus?.(() => { void refresh(); });
  eventsClient.onPeerAuditChanged?.(() => { void refreshAudit(); });

  eventsClient.onPeerDiscovered?.((peer) => {
    if (!discoveredPeers.value.some((p) => p.machineId === peer.machineId)) {
      discoveredPeers.value = [...discoveredPeers.value, peer];
    }
  });
  eventsClient.onPeerLost?.(({ machineId }) => {
    discoveredPeers.value = discoveredPeers.value.filter((p) => p.machineId !== machineId);
  });

  // A peer dialled US. Without this the remote user's screen shows a code and
  // ours shows nothing, so the pairing can never be accepted and simply expires.
  eventsClient.onPeerIncoming?.(({ sessionId, alias, machineId }) => {
    pairing.value = {
      active: true,
      sessionId,
      sas: null,
      status: 'awaiting-sas',
      error: null,
      peerAlias: alias || machineId,
      incoming: true,
    };
  });

  eventsClient.onPeerSas?.(({ sessionId, sas }) => {
    if (pairing.value.sessionId && pairing.value.sessionId !== sessionId) return;
    pairing.value = { ...pairing.value, sessionId, sas, status: 'awaiting-sas' };
  });
  eventsClient.onPeerPaired?.(({ sessionId }) => {
    if (pairing.value.sessionId && pairing.value.sessionId !== sessionId) return;
    // Drop the SAS: the decision is made, and leaving the digits up invites the
    // user to keep comparing a code that no longer means anything.
    pairing.value = { ...pairing.value, sessionId, sas: null, status: 'paired' };
    scheduleDismiss(sessionId);
    void refresh();
  });
  eventsClient.onPeerFailed?.(({ sessionId, reason }) => {
    // Exact match only: cancelling emits a failure for the session just closed,
    // and a loose match would pin that stale error onto the next attempt.
    if (pairing.value.sessionId !== sessionId) return;
    pairing.value = { ...pairing.value, status: 'failed', error: reason || 'Pairing failed' };
  });

  void refresh();
}

async function startPairing(peer: DiscoveredPeer): Promise<void> {
  await beginPairing(peer.alias, () => peersClient.peerStartPairing(peer.machineId));
}

/**
 * Pair with a typed-in address. The fallback that matters when mDNS is blocked,
 * or when the two machines are on different subnets (mDNS does not route).
 */
async function startPairingByAddress(address: string): Promise<void> {
  await beginPairing(address, () => peersClient.peerStartPairingByAddress(address));
}

async function beginPairing(
  label: string,
  start: () => Promise<{ ok: boolean; sessionId?: string; reason?: string } | undefined>,
): Promise<void> {
  cancelDismiss();
  pairing.value = { active: true, sessionId: null, sas: null, status: 'starting', error: null, peerAlias: label, incoming: false };
  try {
    const result = await start();
    if (result?.ok && result.sessionId) {
      pairing.value = { ...pairing.value, sessionId: result.sessionId, status: 'awaiting-sas' };
    } else {
      pairing.value = { ...pairing.value, status: 'failed', error: result?.reason || 'Could not start pairing' };
    }
  } catch (error) {
    pairing.value = { ...pairing.value, status: 'failed', error: error instanceof Error ? error.message : 'Could not start pairing' };
  }
}

async function confirmPairing(accepted: boolean): Promise<void> {
  const sessionId = pairing.value.sessionId;
  if (!sessionId) {
    // No session to decide on (the start was refused, or has not answered yet).
    // A rejection must still get the user out of the dialog.
    if (!accepted) await cancelPairing();
    return;
  }
  pairing.value = { ...pairing.value, status: accepted ? 'confirmed' : 'failed' };
  try {
    await peersClient.peerConfirmPairing(sessionId, accepted);
  } catch { /* onPeerFailed will surface the error */ }
  if (!accepted) closePairing();
}

async function cancelPairing(): Promise<void> {
  try {
    await peersClient.peerCancelPairing();
  } catch { /* ignore */ }
  closePairing();
}

function closePairing(): void {
  cancelDismiss();
  pairing.value = emptyPairing();
}

/**
 * Persist + hot-apply a fleet config change (enabled/host/port), then refetch
 * the config and peer lists so the UI reflects the live state. Mirrors the MCP
 * onMcpUpdate flow: set → get → refresh.
 */
async function setFleetConfig(updates: Partial<FleetConfig>): Promise<void> {
  await configClient.configSetFleetConfig(updates);
  await loadFleetConfig();
  await refresh();
}

async function setInbound(peerId: string, inbound: boolean): Promise<void> {
  await peersClient.peerSetInbound(peerId, inbound);
  await refresh();
}

async function setEnabled(peerId: string, enabled: boolean): Promise<void> {
  await peersClient.peerSetEnabled(peerId, enabled);
  await refresh();
}

async function unpair(peerId: string): Promise<void> {
  await peersClient.peerUnpair(peerId);
  await refresh();
}

/** Remote: the sessions running on a peer, offered for attach. */
async function listPeerSessions(peerId: string): Promise<PeerSession[]> {
  return (await peersClient.peerSessions(peerId)) ?? [];
}

/**
 * Machines a session can be spawned on besides this one: enabled, online, and
 * reporting that they let me call them (their own `inbound` for me).
 */
const spawnTargets = computed(() => configuredPeers.value
  .filter((p) => p.enabled && p.online && p.peerAllowsMe === true)
  .map((p) => ({ id: p.id, alias: p.alias })));

/** Remote spawn: a peer's spawnable directories, shaped like the local dir picker's. */
async function listPeerDirs(peerId: string): Promise<Array<{ name: string; path: string; projectId?: string; projectName?: string }>> {
  return (await peersClient.peerDirs(peerId)) ?? [];
}

/** Remote spawn: the tool ids belong to that peer and cannot be reused locally. */
async function listPeerCliTypes(peerId: string): Promise<Array<{ id: string; name: string; kind?: 'cli' | 'api' | 'comfyui' }>> {
  return peersClient.peerCliTypes(peerId);
}

/** Remote spawn: start a CLI on the peer and open it here. */
async function spawnOnPeer(peerId: string, cliType: string, dirPath: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  return peersClient.peerSpawn(peerId, cliType, dirPath);
}

/** Remote: open a peer's session here as a local row. */
async function attachPeerSession(peerId: string, sessionId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  return peersClient.peerAttach(peerId, sessionId);
}

/**
 * TEST-ONLY: reset the module-singleton so each test re-subscribes cleanly and
 * starts from empty state. Not used by production code — the singleton is meant
 * to persist for the app's lifetime.
 */
export interface PeerSession {
  id: string;
  name: string;
  cliType: string;
  state?: string;
  activityLevel?: 'active' | 'inactive' | 'idle';
}

export function resetPeersStateForTesting(): void {
  cancelDismiss();
  subscribed = false;
  fleetStatus.value = { enabled: false, running: false, error: null, addresses: [], allInterfaces: false };
  fleetEnabled.value = false;
  fleetConfig.value = { ...DEFAULT_FLEET_CONFIG };
  configuredPeers.value = [];
  peerConfigLoaded.value = false;
  discoveredPeers.value = [];
  audit.value = [];
  pairing.value = emptyPairing();
}

export function usePeers() {
  return {
    fleetEnabled,
    fleetConfig,
    fleetStatus,
    setFleetConfig,
    configuredPeers,
    peerConfigLoaded,
    discoveredPeers,
    audit,
    pairing,
    ensureSubscribed,
    refresh,
    refreshAudit,
    startPairing,
    startPairingByAddress,
    confirmPairing,
    cancelPairing,
    closePairing,
    setInbound,
    setEnabled,
    unpair,
    listPeerSessions,
    attachPeerSession,
    spawnTargets,
    listPeerDirs,
    listPeerCliTypes,
    spawnOnPeer,
  };
}
