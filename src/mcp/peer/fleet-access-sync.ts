/**
 * FleetAccessSync — tells each peer whether THIS machine lets it call in.
 *
 * Access is one flag per side (`PeerConfig.inbound`) and each machine owns only
 * its own. The peer's flag is mirrored here as `peerAllowsMe` purely so the UI
 * can show the combined direction (Off / Me→Them / Them→Me / Both). A report
 * never grants anything: the receiving gate reads only its local `inbound`.
 *
 * Reports are fire-and-forget notifications, sent when a link comes up and when
 * the local grant changes; a lost one is repaired by the next reconnect.
 */

import type { PeerConfigManager } from '../../session/peer-config-manager.js';

export const ACCESS_METHOD = 'fleet.access';

/** The slice of PeerLinkManager the sync needs. */
export interface AccessLinks {
  onlinePeerIds(): string[];
  notify(peerId: string, method: string, params: unknown): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

type Peers = Pick<PeerConfigManager, 'isInboundAllowed' | 'setPeerAllowsMe' | 'on' | 'off'>;

export class FleetAccessSync {
  private links: AccessLinks | null = null;
  /** Last grant reported per peer, so config churn doesn't resend unchanged flags. */
  private readonly sent = new Map<string, boolean>();

  private readonly onOnline = ({ peerId }: { peerId: string }): void => {
    this.sent.delete(peerId);
    this.report(peerId);
  };

  private readonly onNotification = ({ peerId, method, params }: { peerId: string; method: string; params: unknown }): void => {
    if (method !== ACCESS_METHOD) return;
    const allowsYou = (params as { allowsYou?: unknown } | null)?.allowsYou;
    if (typeof allowsYou === 'boolean') this.peers.setPeerAllowsMe(peerId, allowsYou);
  };

  private readonly onConfigChanged = (): void => {
    for (const peerId of this.links?.onlinePeerIds() ?? []) this.report(peerId);
  };

  constructor(private readonly peers: Peers) {
    peers.on('peer-config:changed', this.onConfigChanged);
  }

  /** Bind to the live fleet link manager (null when fleet is off). */
  setLinks(links: AccessLinks | null): void {
    if (this.links) {
      this.links.off('peer-link:online', this.onOnline);
      this.links.off('peer-notification', this.onNotification);
    }
    this.links = links;
    this.sent.clear();
    if (links) {
      links.on('peer-link:online', this.onOnline);
      links.on('peer-notification', this.onNotification);
    }
  }

  dispose(): void {
    this.setLinks(null);
    this.peers.off('peer-config:changed', this.onConfigChanged);
  }

  private report(peerId: string): void {
    const allowsYou = this.peers.isInboundAllowed(peerId);
    if (this.sent.get(peerId) === allowsYou) return;
    if (this.links?.notify(peerId, ACCESS_METHOD, { allowsYou })) this.sent.set(peerId, allowsYou);
  }
}
