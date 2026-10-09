import { peerSessionStore } from './peer-session-store.js';
import { usePeers } from './composables/usePeers.js';

export interface PeerSessionReader {
  fleetEnabled: { value: boolean };
  listPeerSessions: (peerId: string) => Promise<import('./peer-session-store.js').PeerSessionRow[]>;
}

/** Shared fetch path for connect/reconnect and the manual old-peer fallback. */
export async function refreshPeerSessions(peerId: string, peerSource: PeerSessionReader = usePeers()): Promise<void> {
  const peers = peerSource;
  if (!peers.fleetEnabled.value) return;
  const request = peerSessionStore.beginRefresh(peerId);
  try {
    const sessions = await peers.listPeerSessions(peerId);
    peerSessionStore.completeRefresh(peerId, request, sessions);
  } catch {
    // A peer that predates push support still works from this fetch when available.
  }
}
