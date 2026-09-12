/**
 * HelmMobileService — the LOCAL-ONLY surface behind the six `mobile_*` tools.
 *
 * Pairing a phone used to be reachable only by clicking through the desktop UI.
 * That is fine for a human at the machine and useless for an AI driving the hub
 * headlessly, so this exposes the SAME coordinator the renderer drives: arm the
 * scan, read the SAS, confirm it, then grant the new device an allow-list.
 *
 * WHY THE ALLOW-LIST TOOL EXISTS. `MobilePairing.finalize` deliberately gives a
 * NEW phone `allow: []`, and `MobileDeviceStore.isToolAllowed` denies everything
 * on an empty list. Pairing therefore produces a device that connects and is
 * refused every call — correct deny-by-default, but it means pairing ALONE can
 * never reach a working phone. Granting is a first-class step, not an afterthought.
 *
 * SECURITY — these tools are in `HARD_DENY_TOOLS`, so neither a paired phone nor
 * a fleet peer can invoke them however permissive its allow-list is. Without that
 * a phone could pair further devices or widen its OWN grants: privilege
 * escalation straight through the gate that is supposed to contain it. The
 * boundary is "local AI only", and the hard-deny set is what enforces it.
 *
 * Mobile may be absent (nothing wired yet during early startup), so every method
 * surfaces one clear "Mobile support is not enabled" rather than crashing —
 * the same lazy-getter shape as HelmPeerService, for the same reason.
 */

import type { MobilePairing, MobilePairingState, StartResult } from '../../mobile/mobile-pairing.js';
import type { MobileDeviceStore } from '../../mobile/mobile-device-store.js';
import type { MobileDevice } from '../../types/mobile-device.js';

/** What the mobile stack must provide for these tools to work. */
export interface MobileDeps {
  pairing: MobilePairing;
  deviceStore: MobileDeviceStore;
  /** Whether a device currently holds a live BLE link. */
  isOnline(machineId: string): boolean;
}

/** One paired phone, as reported to a local AI. Never any key material. */
export interface MobileDeviceSummary {
  id: string;
  machineId: string;
  name: string;
  allow: string[];
  enabled: boolean;
  online: boolean;
  createdAt: number;
  lastSeenAt?: number;
}

export class HelmMobileService {
  /**
   * @param getDeps Lazily resolves the live mobile stack, or undefined when it
   *   has not been wired. A getter (not a stored reference) so the service can be
   *   constructed before the BLE stack exists.
   */
  constructor(private readonly getDeps: () => MobileDeps | undefined) {}

  /**
   * Arm pairing: the radio starts scanning and the next phone offering a link
   * becomes the pairing candidate. Returns the coordinator's own verdict, so a
   * refusal (already pairing, for instance) surfaces as `ok: false` with a
   * reason rather than an exception.
   */
  pairStart(): StartResult {
    return this.requireDeps().pairing.start();
  }

  /**
   * The live pairing state, including the SAS digits once a candidate is found.
   * The SAS is a KDF output — safe to display, and the whole point of the flow:
   * it must be compared against the phone's screen BEFORE confirming.
   */
  pairStatus(): MobilePairingState {
    return this.requireDeps().pairing.getState();
  }

  /**
   * Accept or reject the candidate. Pass `accepted: false` — never a silent
   * timeout — when the SAS digits do not match the phone, because a mismatch is
   * the one signal that distinguishes a real phone from a man in the middle.
   */
  pairConfirm(accepted: boolean): MobilePairingState {
    const deps = this.requireDeps();
    deps.pairing.confirm(accepted);
    return deps.pairing.getState();
  }

  /** Abandon an armed scan or a pending confirmation. */
  pairCancel(reason?: string): MobilePairingState {
    const deps = this.requireDeps();
    if (reason === undefined) deps.pairing.cancel();
    else deps.pairing.cancel(reason);
    return deps.pairing.getState();
  }

  /** Every paired phone with its grants and current online status. */
  deviceList(): { devices: MobileDeviceSummary[] } {
    const deps = this.requireDeps();
    return {
      devices: deps.deviceStore.list().map(device => this.summarise(device, deps)),
    };
  }

  /**
   * REPLACE a device's allow-list (it is not merged — the caller states the full
   * intended grant, so revoking is the same operation as granting and there is no
   * way to widen permissions by accident).
   *
   * Patterns are the same globs the gate matches, e.g. `session_*`. A `*` grants
   * everything the hard-deny set and the unreachable-prefix filter still permit;
   * it does NOT hand over the host-lifecycle tools.
   */
  deviceAllow(deviceId: string, allow: string[]): MobileDeviceSummary {
    const deps = this.requireDeps();
    const updated = deps.deviceStore.update(deviceId, { allow });
    if (!updated) throw new Error(`Unknown mobile device: ${deviceId}`);
    return this.summarise(updated, deps);
  }

  private summarise(device: MobileDevice, deps: MobileDeps): MobileDeviceSummary {
    return {
      id: device.id,
      machineId: device.machineId,
      name: device.name,
      allow: [...device.allow],
      enabled: device.enabled !== false,
      online: deps.isOnline(device.machineId),
      createdAt: device.createdAt,
      ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
    };
  }

  private requireDeps(): MobileDeps {
    const deps = this.getDeps();
    if (!deps) throw new Error('Mobile support is not enabled');
    return deps;
  }
}
