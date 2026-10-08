/**
 * Pairing IPC handlers — the THIN bridge between the renderer pairing UI (P-0650)
 * and the SAS pairing machinery. The discovery + coordinator LIFECYCLE lives in
 * FleetController (P-0658); this module only registers the 5 IPC channels
 * ONCE and delegates each call to the controller's LIVE pairing runtime via the
 * injected `getPairingRuntime()` closure.
 *
 * WHY register once: `ipcMain.handle` throws on a double registration, so a live
 * fleet toggle must NOT re-run this setup. Instead the handlers read the
 * current runtime each call; when fleet is OFF the runtime is null and the
 * handlers return an inert result ([] / a clear "Fleet is not running" error)
 * rather than crashing — no mDNS bound, nothing advertised.
 *
 * Channels:
 *   peer:listDiscovered  → LAN peers seen via mDNS (presence only, no access)
 *   peer:startPairing    → begin a SAS session with a discovered peer
 *   peer:startPairingByAddress → begin a SAS session with a typed-in host:port
 *   peer:confirmPairing  → the user's ONE accept/reject decision (codes match?)
 *   peer:cancelPairing   → abort the active session
 *
 * SECURITY: the 6-digit SAS is surfaced for the USER to compare; it is never a
 * KDF/MAC input. Persistence (pin + secret + PeerConfig) happens ONLY inside
 * PeerPairing after both-accept + peer-confirm, atomic with rollback.
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger.js';
import type { PairingRuntime } from '../../mcp/peer/fleet-controller.js';
import type { PairingPeerInfo } from '../../mcp/peer/peer-pairing.js';

export interface PairingHandlerDeps {
  /** Resolve the live pairing runtime, or null when fleet is not running. */
  getPairingRuntime: () => PairingRuntime | null;
}

const NOT_RUNNING = { ok: false, reason: 'Fleet is not running' } as const;

/**
 * Register the 5 pairing IPC handlers ONCE. Returns a disposer that removes them
 * (for app shutdown only — never on a fleet toggle).
 */
export function setupPairingHandlers(deps: PairingHandlerDeps): () => void {
  ipcMain.handle('peer:listDiscovered', () => {
    const runtime = deps.getPairingRuntime();
    return runtime ? [...runtime.discovered.values()] : [];
  });

  ipcMain.handle('peer:startPairing', (_e, machineId: string) => {
    const runtime = deps.getPairingRuntime();
    if (!runtime) return NOT_RUNNING;
    const peer = runtime.discovered.get(machineId);
    if (!peer) return { ok: false, reason: 'peer not currently discovered' };
    const info: PairingPeerInfo = {
      machineId: peer.machineId,
      alias: peer.alias,
      address: peer.address,
      candidateAddresses: peer.addresses,
      certFp: '',
    };
    return runtime.coordinator.start(info);
  });

  /**
   * Pair with a typed-in `host:port`. mDNS does not cross subnets or survive
   * client isolation, so on many real networks this is the ONLY way two machines
   * can find each other. The peer's machineId is unknown here — it is learned
   * from the responder's own hello and folded into the SAS, so a wrong address
   * shows up as a mismatched code rather than a silent mispairing.
   */
  ipcMain.handle('peer:startPairingByAddress', (_e, address: string) => {
    const runtime = deps.getPairingRuntime();
    if (!runtime) return NOT_RUNNING;
    const trimmed = (address ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'enter an address like 10.98.1.140:47474' };
    const info: PairingPeerInfo = { machineId: '', alias: '', address: trimmed, certFp: '' };
    return runtime.coordinator.start(info);
  });

  ipcMain.handle('peer:confirmPairing', (_e, sessionId: string, accepted: boolean) => {
    const runtime = deps.getPairingRuntime();
    if (!runtime) return NOT_RUNNING;
    runtime.coordinator.confirm(sessionId, accepted === true);
    return { ok: true };
  });

  ipcMain.handle('peer:cancelPairing', () => {
    const runtime = deps.getPairingRuntime();
    if (!runtime) return NOT_RUNNING;
    runtime.coordinator.cancel();
    return { ok: true };
  });

  logger.info('[pairing] Registered pairing IPC handlers (delegating to live runtime)');
  return () => {
    ipcMain.removeHandler('peer:listDiscovered');
    ipcMain.removeHandler('peer:startPairing');
    ipcMain.removeHandler('peer:startPairingByAddress');
    ipcMain.removeHandler('peer:confirmPairing');
    ipcMain.removeHandler('peer:cancelPairing');
  };
}
