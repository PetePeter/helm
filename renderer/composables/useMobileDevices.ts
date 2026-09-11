/**
 * useMobileDevices — reactive state for the Settings → Mobile tab.
 *
 * Module-singleton refs shared by MobileTab and MobilePairingDialog, mirroring
 * usePeers: ensureSubscribed() wires every mobile event once and does an initial
 * refresh; actions delegate to mobileClient and defensively re-refresh so the UI
 * stays consistent even if an event is missed.
 *
 * The SAS digits held here are a KDF OUTPUT and safe to display. No PSK ever
 * reaches the renderer — the main process does not send one.
 */
import { ref } from 'vue';
import { mobileClient, eventsClient } from '../ipc/clients.js';

export interface MobileDeviceItem {
  id: string;
  machineId: string;
  name: string;
  allow: string[];
  enabled: boolean;
  online: boolean;
  createdAt: number;
  lastSeenAt?: number;
}

export type MobilePairingStatus = 'idle' | 'scanning' | 'awaiting-sas' | 'paired' | 'failed';

export interface MobilePairingState {
  status: MobilePairingStatus;
  sas?: string;
  deviceName?: string;
  reason?: string;
}

/** How long the "paired" confirmation stays up before the dialog closes itself. */
export const PAIRED_DISMISS_MS = 1500;

const devices = ref<MobileDeviceItem[]>([]);
const pairing = ref<MobilePairingState>({ status: 'idle' });
const dialogOpen = ref(false);

let subscribed = false;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function cancelDismiss(): void {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

async function refresh(): Promise<void> {
  devices.value = await mobileClient.mobileList();
}

/** Wire every mobile event exactly once, then do the initial load. */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;

  eventsClient.onMobileDevicesChanged(() => { void refresh(); });
  eventsClient.onMobilePairingState((state: MobilePairingState) => {
    pairing.value = state;
    // A successful pair closes the dialog on its own, so the user is not left
    // dismissing a modal that has nothing left to say.
    if (state.status === 'paired') {
      cancelDismiss();
      dismissTimer = setTimeout(() => {
        dialogOpen.value = false;
        dismissTimer = null;
      }, PAIRED_DISMISS_MS);
    }
    void refresh();
  });

  void refresh();
  void mobileClient.mobilePairingState().then((state: MobilePairingState) => {
    // A dialog opened mid-flow (or after a renderer reload) picks up the truth.
    if (state.status !== 'idle') pairing.value = state;
  });
}

async function startPairing(): Promise<{ ok: boolean; reason?: string }> {
  cancelDismiss();
  dialogOpen.value = true;
  pairing.value = { status: 'scanning' };
  const result = await mobileClient.mobileStartPairing();
  if (!result.ok) pairing.value = { status: 'failed', reason: result.reason };
  return result;
}

async function confirmPairing(accepted: boolean): Promise<void> {
  await mobileClient.mobileConfirmPairing(accepted);
  await refresh();
}

async function cancelPairing(): Promise<void> {
  cancelDismiss();
  await mobileClient.mobileCancelPairing();
  dialogOpen.value = false;
  pairing.value = { status: 'idle' };
}

/** Close the dialog without abandoning a pairing that already succeeded. */
function closePairing(): void {
  cancelDismiss();
  dialogOpen.value = false;
  pairing.value = { status: 'idle' };
}

async function setAllowList(deviceId: string, allow: string[]): Promise<void> {
  await mobileClient.mobileSetAllowList(deviceId, allow);
  await refresh();
}

async function setEnabled(deviceId: string, enabled: boolean): Promise<void> {
  await mobileClient.mobileSetEnabled(deviceId, enabled);
  await refresh();
}

async function revoke(deviceId: string): Promise<void> {
  await mobileClient.mobileRevoke(deviceId);
  await refresh();
}

/**
 * TEST ONLY: drop the module singleton so each test starts from empty state.
 * Not used by production code — the singleton persists for the app's lifetime.
 */
export function resetMobileDevicesStateForTesting(): void {
  cancelDismiss();
  subscribed = false;
  devices.value = [];
  pairing.value = { status: 'idle' };
  dialogOpen.value = false;
}

export function useMobileDevices() {
  return {
    devices,
    pairing,
    dialogOpen,
    ensureSubscribed,
    refresh,
    startPairing,
    confirmPairing,
    cancelPairing,
    closePairing,
    setAllowList,
    setEnabled,
    revoke,
  };
}
