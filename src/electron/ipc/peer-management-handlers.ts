/**
 * Peer-management IPC handlers — the bridge between the Settings → Peers UI
 * (P-0650) and the peer registry / trust stores / audit log.
 *
 * Distinct from pairing-handlers.ts (which owns discovery + the SAS handshake),
 * this module owns the STEADY-STATE surface: listing configured peers with their
 * live link status, editing a peer's allow-list, enabling/disabling a peer,
 * unpairing (clean removal of config + secret + pin), and reading the audit log.
 *
 * Everything is guarded by `enabled` (fleet wired). When fleet is OFF
 * the channels still register but return empty/inert results, so the tab renders
 * its "fleet is off" hint gracefully without a manager.
 *
 * Events forwarded to every renderer:
 *   peer-config:changed  (from PeerConfigManager)
 *   peer-link:status     (from PeerLinkManager online/offline, normalised)
 *   peer-audit:changed   (from PeerAuditLog)
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger.js';
import type { PeerConfigManager } from '../../session/peer-config-manager.js';
import type { PeerLinkManager } from '../../mcp/peer/peer-link-manager.js';
import type { PeerAuditLog } from '../../mcp/peer/peer-audit-log.js';
import type { PinnedCertStore } from '../../mcp/peer/pinned-cert-store.js';
import type { SecretStore } from '../../mcp/peer/secret-store.js';

export interface PeerManagementDeps {
  /** Live fleet-enabled state, read per call (P-0658 in-app toggle). */
  isEnabled: () => boolean;
  peerConfigManager: PeerConfigManager;
  pinnedCertStore: PinnedCertStore;
  secretStore: SecretStore;
  audit: PeerAuditLog;
  /** Resolve the live transport (constructed asynchronously after start). */
  getLinkManager: () => PeerLinkManager | null;
  /** Remote: open a peer's session here as a local row (RemoteService.open). */
  attach: (peerId: string, sessionId: string) => Promise<{ id: string }>;
}

/** A session on a peer, as offered in the Peers tab's Attach picker. */
export interface PeerSessionItem {
  id: string;
  name: string;
  cliType: string;
}

export interface PeerListItem {
  id: string;
  machineId?: string;
  alias: string;
  address: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  allow: string[];
  enabled: boolean;
  online: boolean;
}

/**
 * Register the peer-management handlers + event forwarding. Returns a disposer
 * that removes the handlers and detaches the event listeners.
 */
export function setupPeerManagementHandlers(deps: PeerManagementDeps): () => void {
  ipcMain.handle('peer:fleetEnabled', () => deps.isEnabled());

  ipcMain.handle('peer:list', (): PeerListItem[] => {
    if (!deps.isEnabled()) return [];
    const link = deps.getLinkManager();
    return deps.peerConfigManager.list().map((peer) => ({
      id: peer.id,
      ...(peer.machineId ? { machineId: peer.machineId } : {}),
      alias: peer.alias,
      address: peer.address,
      direction: peer.direction,
      allow: peer.allow,
      // Default-true: an undefined enabled flag is treated as enabled.
      enabled: peer.enabled !== false,
      online: link ? link.status(peer.id) === 'online' : false,
    }));
  });

  ipcMain.handle('peer:setAllowList', (_e, peerId: string, allow: string[]) => {
    if (!deps.isEnabled()) return { ok: false };
    const cleaned = Array.isArray(allow) ? allow.filter((a) => typeof a === 'string' && a.length > 0) : [];
    const updated = deps.peerConfigManager.update(peerId, { allow: cleaned });
    return { ok: Boolean(updated) };
  });

  ipcMain.handle('peer:setEnabled', (_e, peerId: string, enabled: boolean) => {
    if (!deps.isEnabled()) return { ok: false };
    const on = enabled === true;
    const updated = deps.peerConfigManager.update(peerId, { enabled: on });
    if (!updated) return { ok: false };
    // Reflect the toggle in the LIVE transport immediately so "Off" means off in
    // both directions (the InboundCallGate independently denies disabled peers).
    const link = deps.getLinkManager();
    if (link) {
      if (on) link.addPeer(updated);   // re-dial (no-op for inbound-only peers)
      else link.disposePeer(peerId);   // drop any live link now
    }
    return { ok: true };
  });

  ipcMain.handle('peer:unpair', (_e, peerId: string) => {
    if (!deps.isEnabled()) return { ok: false };
    const peer = deps.peerConfigManager.get(peerId);
    if (!peer) return { ok: false };
    // Clean removal: config → secret (by pskRef) → pin (by peerId). Order chosen so
    // the registry entry is gone even if a later step is a no-op.
    deps.peerConfigManager.remove(peerId);
    if (peer.pskRef) deps.secretStore.remove(peer.pskRef);
    deps.pinnedCertStore.removePin(peerId);
    // Pins may have been keyed by machineId in some flows — clear that too.
    if (peer.machineId) deps.pinnedCertStore.removePin(peer.machineId);
    logger.info(`[peer-management] Unpaired peer ${peerId}`);
    return { ok: true };
  });

  // Remote — discovery rides Fleet (the peer's own session_list, gated by its
  // allow-list); attach adopts the chosen session as a local row.
  ipcMain.handle('peer:sessions', async (_e, peerId: string): Promise<PeerSessionItem[]> => {
    const link = deps.getLinkManager();
    if (!deps.isEnabled() || !link) return [];
    const listed = await link.call(peerId, 'session_list', {}) as { sessions?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const sessions = Array.isArray(listed) ? listed : listed?.sessions ?? [];
    return sessions
      // A peer's own Remote rows are views of someone else — not attachable.
      .filter((s) => typeof s.id === 'string' && !s.remote)
      .map((s) => ({ id: s.id as string, name: String(s.name ?? s.id), cliType: String(s.cliTypeName ?? s.cliType ?? '') }));
  });

  ipcMain.handle('peer:attach', async (_e, peerId: string, sessionId: string) => {
    if (!deps.isEnabled()) return { ok: false, error: 'Fleet is off' };
    try {
      const session = await deps.attach(peerId, sessionId);
      return { ok: true, sessionId: session.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('peer:getAudit', () => {
    if (!deps.isEnabled()) return [];
    return deps.audit.list();
  });

  // ---- event forwarding ---------------------------------------------------
  const onConfigChanged = () => broadcast((win) => win.webContents.send('peer-config:changed'));
  const onAuditChanged = () => broadcast((win) => win.webContents.send('peer-audit:changed'));
  const onOnline = (e: { peerId: string }) =>
    broadcast((win) => win.webContents.send('peer-link:status', { peerId: e.peerId, online: true }));
  const onOffline = (e: { peerId: string }) =>
    broadcast((win) => win.webContents.send('peer-link:status', { peerId: e.peerId, online: false }));

  deps.peerConfigManager.on('peer-config:changed', onConfigChanged);
  deps.audit.on('peer-audit:changed', onAuditChanged);

  // The link manager appears/disappears as fleet is toggled (P-0658), so keep
  // polling: attach online/offline forwarding when a new manager appears, and
  // detach cleanly when it goes away or is replaced. The timer runs for the app
  // lifetime (cleared only by the disposer).
  let linkAttached: PeerLinkManager | null = null;
  const attachLinkTimer = setInterval(() => {
    const link = deps.getLinkManager();
    if (link === linkAttached) return;
    if (linkAttached) {
      linkAttached.off('peer-link:online', onOnline);
      linkAttached.off('peer-link:offline', onOffline);
    }
    linkAttached = link ?? null;
    if (linkAttached) {
      linkAttached.on('peer-link:online', onOnline);
      linkAttached.on('peer-link:offline', onOffline);
    }
  }, 500);

  logger.info('[peer-management] Registered peer-management IPC handlers');

  return () => {
    ipcMain.removeHandler('peer:fleetEnabled');
    ipcMain.removeHandler('peer:list');
    ipcMain.removeHandler('peer:setAllowList');
    ipcMain.removeHandler('peer:setEnabled');
    ipcMain.removeHandler('peer:unpair');
    ipcMain.removeHandler('peer:getAudit');
    ipcMain.removeHandler('peer:sessions');
    ipcMain.removeHandler('peer:attach');
    deps.peerConfigManager.off('peer-config:changed', onConfigChanged);
    deps.audit.off('peer-audit:changed', onAuditChanged);
    if (linkAttached) {
      linkAttached.off('peer-link:online', onOnline);
      linkAttached.off('peer-link:offline', onOffline);
    }
    clearInterval(attachLinkTimer);
  };

  function broadcast(send: (win: BrowserWindow) => void): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) send(win);
    }
  }
}
