/** Owns per-peer dock descriptors and their push/fetch session snapshots. */
import { watch, type Ref, type WatchStopHandle } from 'vue';
import PeerSessionsPane from '../components/dock/PeerSessionsPane.vue';
import { getPaneDescriptor } from '../dock-types.js';
import { registerDockPane, unregisterDockPane } from '../dock-pane-registry.js';
import { peerSessionStore, type PeerSessionRow } from '../peer-session-store.js';
import { refreshPeerSessions } from '../peer-session-refresh.js';
import { eventsClient } from '../ipc/clients.js';
import { usePeers, type ConfiguredPeer } from './usePeers.js';
import type { DockWorkspace } from './useDockWorkspace.js';

export interface PeerSessionPanePeerSource {
  fleetEnabled: Ref<boolean>;
  peerConfigLoaded: Ref<boolean>;
  configuredPeers: Ref<ConfiguredPeer[]>;
  ensureSubscribed: () => void;
  listPeerSessions: (peerId: string) => Promise<PeerSessionRow[]>;
}

export interface PeerSessionPaneEventSource {
  onPeerSessionsChanged?: (callback: (event: { peerId: string; sessions: PeerSessionRow[] }) => void) => void | (() => void);
  onPeerLinkStatus?: (callback: (event: { peerId: string; online: boolean }) => void) => void | (() => void);
}

export interface PeerSessionPaneDeps {
  peers?: PeerSessionPanePeerSource;
  events?: PeerSessionPaneEventSource;
}

export function usePeerSessionPanes(dock: DockWorkspace, deps: PeerSessionPaneDeps = {}): { start: () => void; stop: () => void } {
  const peers = deps.peers ?? usePeers();
  const events = deps.events ?? {
    onPeerSessionsChanged: eventsClient.onPeerSessionsChanged?.bind(eventsClient),
    onPeerLinkStatus: eventsClient.onPeerLinkStatus?.bind(eventsClient),
  };
  const registeredPeerIds = new Set<string>();
  const lastOnline = new Map<string, boolean>();
  const unsubscribeEvents: Array<() => void> = [];
  let stopWatching: WatchStopHandle | undefined;
  let started = false;

  const onSessionsChanged = (event: { peerId: string; sessions: PeerSessionRow[] }): void => {
    const { peerId, sessions } = event;
    if (started && peers.fleetEnabled.value && peers.configuredPeers.value.some(peer => peer.id === peerId)) {
      peerSessionStore.applyPush(peerId, sessions);
    }
  };
  const onPeerLinkStatus = (event: { peerId: string; online: boolean }): void => {
    const { peerId, online } = event;
    if (!started || !peers.configuredPeers.value.some(peer => peer.id === peerId)) return;
    const wasOnline = lastOnline.get(peerId) === true;
    lastOnline.set(peerId, online);
    peerSessionStore.setOnline(peerId, online);
    if (online && !wasOnline) void refreshPeerSessions(peerId, peers);
  };

  const reconcile = (): void => {
    if (!peers.fleetEnabled.value) {
      for (const peerId of registeredPeerIds) {
        unregisterDockPane(paneId(peerId));
        peerSessionStore.setOnline(peerId, false);
        lastOnline.set(peerId, false);
      }
      return;
    }
    if (!peers.peerConfigLoaded.value) return;

    const configured = new Map(peers.configuredPeers.value.map(peer => [peer.id, peer]));
    for (const peer of configured.values()) registerPeerPane(peer);

    for (const peerId of [...registeredPeerIds]) {
      if (configured.has(peerId)) continue;
      unregisterDockPane(paneId(peerId));
      dock.forgetPane(paneId(peerId));
      peerSessionStore.clear(peerId);
      lastOnline.delete(peerId);
      registeredPeerIds.delete(peerId);
    }

    // Reconcile saved dynamic slots only after the configured peer registry is authoritative.
    dock.pruneUnregisteredPanes();
  };

  function registerPeerPane(peer: ConfiguredPeer): void {
    const id = paneId(peer.id);
    const descriptor = {
      id,
      kind: 'tool' as const,
      title: `Sessions - ${peer.alias}`,
      icon: '🗂',
      closable: true,
      home: 'left' as const,
      dynamic: true,
    };
    if (getPaneDescriptor(id)?.title !== descriptor.title) registerDockPane(descriptor, PeerSessionsPane);
    dock.ensurePane(id);
    registeredPeerIds.add(peer.id);

    const wasOnline = lastOnline.get(peer.id) === true;
    peerSessionStore.setOnline(peer.id, peer.online);
    lastOnline.set(peer.id, peer.online);
    if (peer.online && !wasOnline) void refreshPeerSessions(peer.id, peers);
  }

  return {
    start: () => {
      if (started) return;
      started = true;
      peers.ensureSubscribed();
      stopWatching = watch(
        () => [
          peers.fleetEnabled.value,
          peers.peerConfigLoaded.value,
          peers.configuredPeers.value.map(peer => `${peer.id}\n${peer.alias}\n${peer.online}`).join('\n'),
        ],
        reconcile,
        { immediate: true },
      );
      const offSessions = events.onPeerSessionsChanged?.(onSessionsChanged);
      const offStatus = events.onPeerLinkStatus?.(onPeerLinkStatus);
      if (offSessions) unsubscribeEvents.push(offSessions);
      if (offStatus) unsubscribeEvents.push(offStatus);
    },
    stop: () => {
      if (!started) return;
      started = false;
      stopWatching?.();
      stopWatching = undefined;
      for (const unsubscribe of unsubscribeEvents.splice(0)) unsubscribe();
      for (const peerId of registeredPeerIds) unregisterDockPane(paneId(peerId));
      registeredPeerIds.clear();
      lastOnline.clear();
    },
  };
}

function paneId(peerId: string): string {
  return `sessions:${peerId}`;
}
