/**
 * Mobile IPC handlers — the bridge between Settings → Mobile and the paired-phone
 * registry + the pairing coordinator.
 *
 * Shaped exactly like peer-management-handlers: register once, read live state
 * through injected closures, and return a disposer. Nothing here holds state of
 * its own.
 *
 * SECRETS NEVER CROSS THIS BOUNDARY. The registry is already secret-free (only
 * `pskRef` references), and the pairing state carries the SAS digits — a KDF
 * OUTPUT, safe to display — but never key material.
 *
 * Events forwarded to every renderer:
 *   mobile-devices:changed  (from MobileDeviceStore)
 *   mobile-pairing:state    (from MobilePairing)
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger.js';
import type { MobileDeviceStore } from '../../mobile/mobile-device-store.js';
import type { MobilePairing, MobilePairingState } from '../../mobile/mobile-pairing.js';
import { describeApkRelease, apkReleaseUrl, type ApkReleaseInfo } from '../../mobile/apk-release.js';

export interface MobileHandlerDeps {
  deviceStore: MobileDeviceStore;
  /** Resolved per call — the coordinator only exists while BLE is running. */
  getPairing: () => MobilePairing | null;
  /** Whether a device currently holds a live BLE link. */
  isOnline?: (machineId: string) => boolean;
  /** Force-disconnect a device's live link (disable takes effect immediately). */
  dropLink?: (machineId: string) => void;
  /**
   * Link up/down notifications. Online state is not part of the registry, so
   * without this the tab would keep showing whatever it saw when it last loaded.
   */
  links?: {
    on(event: 'online' | 'offline', handler: () => void): unknown;
    off(event: 'online' | 'offline', handler: () => void): unknown;
  };
  /**
   * The running app version, which is what the APK download must be pinned to.
   * Injected rather than read from `app` so this module stays testable without
   * a live Electron app.
   */
  getAppVersion?: () => string;
  /**
   * Resolves whether the release asset actually exists. Optional: with no
   * checker the answer is `unknown`, which is deliberately NOT `missing`.
   */
  checkApkAsset?: (url: string) => Promise<boolean>;
}

/** A paired phone as the settings tab renders it. */
export interface MobileDeviceListItem {
  id: string;
  machineId: string;
  name: string;
  allow: string[];
  enabled: boolean;
  online: boolean;
  createdAt: number;
  lastSeenAt?: number;
}

/** What `mobile:apkRelease` answers with. Never a rejection. */
export type ApkReleaseResult =
  | ({ ok: true } & ApkReleaseInfo)
  | { ok: false; reason: string };

const INERT = { ok: false, reason: 'Mobile BLE is not running' } as const;

export function setupMobileHandlers(deps: MobileHandlerDeps): () => void {
  ipcMain.handle('mobile:list', (): MobileDeviceListItem[] =>
    deps.deviceStore.list().map((device) => ({
      id: device.id,
      machineId: device.machineId,
      name: device.name,
      allow: device.allow,
      // Default-true: an undefined enabled flag is treated as enabled.
      enabled: device.enabled !== false,
      online: deps.isOnline?.(device.machineId) ?? false,
      createdAt: device.createdAt,
      ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
    })),
  );

  ipcMain.handle('mobile:startPairing', () => {
    const pairing = deps.getPairing();
    if (!pairing) return INERT;
    return pairing.start();
  });

  ipcMain.handle('mobile:confirmPairing', (_e, accepted: boolean) => {
    const pairing = deps.getPairing();
    if (!pairing) return INERT;
    pairing.confirm(accepted === true);
    return { ok: true };
  });

  ipcMain.handle('mobile:cancelPairing', () => {
    const pairing = deps.getPairing();
    if (!pairing) return INERT;
    pairing.cancel('cancelled by the user');
    return { ok: true };
  });

  ipcMain.handle('mobile:pairingState', (): MobilePairingState =>
    deps.getPairing()?.getState() ?? { status: 'idle' },
  );

  ipcMain.handle('mobile:setAllowList', (_e, deviceId: string, allow: string[]) => {
    const cleaned = Array.isArray(allow)
      ? allow.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : [];
    return { ok: Boolean(deps.deviceStore.update(deviceId, { allow: cleaned })) };
  });

  ipcMain.handle('mobile:setEnabled', (_e, deviceId: string, enabled: boolean) => {
    const on = enabled === true;
    const updated = deps.deviceStore.update(deviceId, { enabled: on });
    if (!updated) return { ok: false };
    // "Off" must mean off immediately, not at next reconnect. The store already
    // denies every inbound call for a disabled device; this drops the radio link.
    if (!on) deps.dropLink?.(updated.machineId);
    return { ok: true };
  });

  ipcMain.handle('mobile:revoke', (_e, deviceId: string) => {
    const pairing = deps.getPairing();
    if (!pairing) return INERT;
    const revoked = pairing.revoke(deviceId);
    if (revoked) logger.info(`[mobile] Revoked device ${deviceId}`);
    return { ok: revoked };
  });

  /**
   * Where to get the app for the phone. Helm does not host it — this is a
   * GitHub release asset for the version of Helm that is running, never
   * `latest`. See src/mobile/apk-release.ts.
   */
  ipcMain.handle('mobile:apkRelease', async (): Promise<ApkReleaseResult> => {
    const version = deps.getAppVersion?.() ?? '';
    let url: string;
    try {
      url = apkReleaseUrl(version);
    } catch (err) {
      // A rejected IPC call reaches the renderer with no copy attached to it,
      // which is how a settings tab ends up blank and unexplained.
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    let availability: ApkReleaseInfo['availability'] = 'unknown';
    if (deps.checkApkAsset) {
      try {
        availability = (await deps.checkApkAsset(url)) ? 'available' : 'missing';
      } catch (err) {
        // Offline is not evidence that the release lacks an APK.
        logger.warn(`[mobile] Could not check for the APK asset: ${err}`);
      }
    }
    return { ok: true, ...describeApkRelease(version, availability) };
  });

  // ---- event forwarding ---------------------------------------------------
  const onDevicesChanged = () => broadcast((win) => win.webContents.send('mobile-devices:changed'));
  const onPairingState = (state: MobilePairingState) =>
    broadcast((win) => win.webContents.send('mobile-pairing:state', state));

  deps.deviceStore.on('mobile-devices:changed', onDevicesChanged);
  // An online/offline flip changes what the list renders, not what it stores.
  deps.links?.on('online', onDevicesChanged);
  deps.links?.on('offline', onDevicesChanged);

  // The coordinator appears/disappears with the BLE transport, so attach to
  // whichever one is live, exactly as peer-management does for the link manager.
  let pairingAttached: MobilePairing | null = null;
  const attachTimer = setInterval(() => {
    const pairing = deps.getPairing();
    if (pairing === pairingAttached) return;
    pairingAttached?.off('state', onPairingState);
    pairingAttached = pairing ?? null;
    pairingAttached?.on('state', onPairingState);
  }, 500);

  logger.info('[mobile] Registered mobile IPC handlers');

  return () => {
    for (const channel of [
      'mobile:list', 'mobile:startPairing', 'mobile:confirmPairing', 'mobile:cancelPairing',
      'mobile:pairingState', 'mobile:setAllowList', 'mobile:setEnabled', 'mobile:revoke',
      'mobile:apkRelease',
    ]) {
      ipcMain.removeHandler(channel);
    }
    deps.deviceStore.off('mobile-devices:changed', onDevicesChanged);
    deps.links?.off('online', onDevicesChanged);
    deps.links?.off('offline', onDevicesChanged);
    pairingAttached?.off('state', onPairingState);
    clearInterval(attachTimer);
  };

  function broadcast(send: (win: BrowserWindow) => void): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) send(win);
    }
  }
}
