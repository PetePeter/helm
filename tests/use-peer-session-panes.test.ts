/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { usePeerSessionPanes, type PeerSessionPaneEventSource, type PeerSessionPanePeerSource } from '../renderer/composables/usePeerSessionPanes.js';
import type { ConfiguredPeer } from '../renderer/composables/usePeers.js';
import { useDockWorkspace } from '../renderer/composables/useDockWorkspace.js';
import { createDefaultLayout, listPanes } from '../renderer/dock-layout.js';
import type { DockNode } from '../renderer/dock-types.js';
import { getPaneDescriptor } from '../renderer/dock-types.js';
import { registeredDockPaneIds, unregisterDockPane } from '../renderer/dock-pane-registry.js';
import { peerSessionStore, type PeerSessionRow } from '../renderer/peer-session-store.js';

const stops: Array<() => void> = [];

class PeerEvents implements PeerSessionPaneEventSource {
  readonly sessions = new Set<(event: { peerId: string; sessions: PeerSessionRow[] }) => void>();
  readonly status = new Set<(event: { peerId: string; online: boolean }) => void>();

  onPeerSessionsChanged(callback: (event: { peerId: string; sessions: PeerSessionRow[] }) => void): () => void {
    this.sessions.add(callback);
    return () => this.sessions.delete(callback);
  }

  onPeerLinkStatus(callback: (event: { peerId: string; online: boolean }) => void): () => void {
    this.status.add(callback);
    return () => this.status.delete(callback);
  }

  push(peerId: string, rows: PeerSessionRow[]): void {
    for (const listener of this.sessions) listener({ peerId, sessions: rows });
  }

  link(peerId: string, online: boolean): void {
    for (const listener of this.status) listener({ peerId, online });
  }
}

function makePeer(id: string, online = false, alias = `Peer ${id}`): ConfiguredPeer {
  return {
    id,
    alias,
    address: '127.0.0.1:47474',
    direction: 'bidirectional',
    inbound: true,
    enabled: true,
    online,
  };
}

function makePeers(overrides: Partial<PeerSessionPanePeerSource> = {}) {
  return {
    fleetEnabled: ref(false),
    peerConfigLoaded: ref(true),
    configuredPeers: ref<ConfiguredPeer[]>([]),
    ensureSubscribed: () => {},
    listPeerSessions: async (_peerId: string) => [] as PeerSessionRow[],
    ...overrides,
  };
}

async function makeDock(saved = createDefaultLayout()) {
  let persisted: unknown = JSON.parse(JSON.stringify(saved));
  const dock = useDockWorkspace(undefined, {
    persistence: {
      load: () => JSON.parse(JSON.stringify(persisted)),
      save: layout => { persisted = JSON.parse(JSON.stringify(layout)); },
    },
  });
  await dock.loadPersisted();
  return { dock, readPersisted: () => JSON.parse(JSON.stringify(persisted)) };
}

function start(dock: Awaited<ReturnType<typeof makeDock>>['dock'], peers: PeerSessionPanePeerSource, events: PeerEvents) {
  const owner = usePeerSessionPanes(dock, { peers, events });
  stops.push(owner.stop);
  owner.start();
  return owner;
}

function dockSideFor(node: DockNode, paneId: string): string | null {
  if (node.type === 'dock') return listPanes(node.child).includes(paneId) ? node.side : dockSideFor(node.child, paneId);
  if (node.type === 'split') {
    for (const child of node.children) {
      const side = dockSideFor(child, paneId);
      if (side) return side;
    }
  }
  return null;
}

async function flushVue(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const paneId of registeredDockPaneIds().filter(id => id.startsWith('sessions:'))) {
    unregisterDockPane(paneId);
    peerSessionStore.clear(paneId.slice('sessions:'.length));
  }
});

describe('usePeerSessionPanes', () => {
  it('keeps saved peer slots untouched while Fleet is off and renders no panes', async () => {
    const id = 'sessions:off-peer';
    const initial = createDefaultLayout();
    initial.closed.push(id);
    const { dock, readPersisted } = await makeDock(initial);
    const before = JSON.stringify(dock.layout.value);
    const savedBefore = JSON.stringify(readPersisted());
    const peers = makePeers();
    const events = new PeerEvents();

    start(dock, peers, events);
    await flushVue();

    expect(getPaneDescriptor(id)).toBeUndefined();
    expect(JSON.stringify(dock.layout.value)).toBe(before);
    expect(JSON.stringify(readPersisted())).toBe(savedBefore);
    expect(dock.closedPanes.value).toContain(id);
  });

  it('opens a newly configured peer at its descriptor home and updates its title on alias change', async () => {
    const { dock } = await makeDock();
    const peers = makePeers({
      fleetEnabled: ref(true),
      configuredPeers: ref([makePeer('workstation')]),
    });
    const events = new PeerEvents();
    start(dock, peers, events);
    await flushVue();

    expect(dock.isOpen('sessions:workstation')).toBe(true);
    expect(dock.closedPanes.value).not.toContain('sessions:workstation');
    expect(getPaneDescriptor('sessions:workstation')?.title).toBe('Sessions - Peer workstation');
    expect(getPaneDescriptor('sessions:workstation')?.home).toBe('left');
    expect(dockSideFor(dock.layout.value.root, 'sessions:workstation')).toBe('left');

    peers.configuredPeers.value = [makePeer('workstation', false, 'Build PC')];
    await flushVue();
    expect(getPaneDescriptor('sessions:workstation')?.title).toBe('Sessions - Build PC');
    expect(dock.isOpen('sessions:workstation')).toBe(true);
  });

  it('keeps a user-closed pane closed through offline and online transitions and leaves it restorable', async () => {
    const { dock } = await makeDock();
    const peers = makePeers({ fleetEnabled: ref(true), configuredPeers: ref([makePeer('reconnect', true)]) });
    const events = new PeerEvents();
    start(dock, peers, events);
    await flushVue();
    dock.close('sessions:reconnect');

    events.link('reconnect', false);
    peers.configuredPeers.value = [makePeer('reconnect', false)];
    await flushVue();
    events.link('reconnect', true);
    peers.configuredPeers.value = [makePeer('reconnect', true)];
    await flushVue();

    expect(dock.isOpen('sessions:reconnect')).toBe(false);
    expect(dock.closedPanes.value).toContain('sessions:reconnect');
    expect(registeredDockPaneIds()).toContain('sessions:reconnect');
    dock.restore('sessions:reconnect');
    expect(dock.isOpen('sessions:reconnect')).toBe(true);
  });

  it('removes an unpaired peer from the live tree, closed list, and snapshot store', async () => {
    const { dock } = await makeDock();
    const peers = makePeers({ fleetEnabled: ref(true), configuredPeers: ref([makePeer('unpair')]) });
    const events = new PeerEvents();
    start(dock, peers, events);
    await flushVue();
    peerSessionStore.applyPush('unpair', [{ id: 's1', name: 'stale', cliType: 'cli' }]);
    dock.close('sessions:unpair');

    peers.configuredPeers.value = [];
    await flushVue();

    expect(listPanes(dock.layout.value.root)).not.toContain('sessions:unpair');
    expect(dock.closedPanes.value).not.toContain('sessions:unpair');
    expect(getPaneDescriptor('sessions:unpair')).toBeUndefined();
    expect(peerSessionStore.get('unpair')).toBeUndefined();
  });

  it('fetches once on an online transition and ignores a late fetch after a newer push', async () => {
    const { dock } = await makeDock();
    const events = new PeerEvents();
    let fetches = 0;
    let finishFetch!: (rows: PeerSessionRow[]) => void;
    const peers = makePeers({
      fleetEnabled: ref(true),
      configuredPeers: ref([makePeer('race')]),
      listPeerSessions: () => {
        fetches++;
        return new Promise(resolve => { finishFetch = resolve; });
      },
    });
    start(dock, peers, events);
    await flushVue();
    expect(fetches).toBe(0);

    events.link('race', true);
    peers.configuredPeers.value = [makePeer('race', true)];
    await flushVue();
    expect(fetches).toBe(1);

    events.push('race', [{ id: 'newer', name: 'Push', cliType: 'cli' }]);
    finishFetch([{ id: 'older', name: 'Fetch', cliType: 'cli' }]);
    await flushVue();

    expect(peerSessionStore.get('race')?.sessions).toEqual([{ id: 'newer', name: 'Push', cliType: 'cli' }]);
  });

  it('unsubscribes both peer event listeners when stopped', async () => {
    const { dock } = await makeDock();
    const events = new PeerEvents();
    const peers = makePeers({ fleetEnabled: ref(true), configuredPeers: ref([makePeer('cleanup')]) });
    const owner = start(dock, peers, events);
    await flushVue();
    expect(events.sessions.size).toBe(1);
    expect(events.status.size).toBe(1);

    owner.stop();
    events.push('cleanup', [{ id: 's1', name: 'ignored', cliType: 'cli' }]);

    expect(events.sessions.size).toBe(0);
    expect(events.status.size).toBe(0);
    expect(peerSessionStore.get('cleanup')?.sessions).toEqual([]);
  });
});
