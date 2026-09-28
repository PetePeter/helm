/**
 * Peer — a remote Helm instance this hub may exchange control traffic with.
 *
 * This is a PURE data model: it carries no networking or crypto. In particular
 * it NEVER holds secret material — `pskRef` is an opaque reference into a future
 * secret store, not the pre-shared key itself. Transport, handshake, and key
 * resolution are introduced by later plans.
 *
 * Access is one flag per side: `inbound` says whether THIS machine lets the peer
 * call it. Each machine owns only its own flag; `peerAllowsMe` mirrors the
 * peer's flag as reported over the link, for display only.
 */
export interface PeerConfig {
  /** Unique peer identifier (UUID v4). */
  id: string;
  /** Human-facing label, e.g. "the Mac". */
  alias: string;
  /** Network address as host:port. Not validated here (no networking yet). */
  address: string;
  /**
   * Opaque reference into a future secret store for this peer's pre-shared key.
   * NEVER the secret itself — only a lookup key.
   */
  pskRef: string;
  /**
   * Whether this peer may call me. True = every tool except the gate's
   * hard-deny list; false (default) = nothing. Deny-by-default.
   */
  inbound: boolean;
  /**
   * The peer's own `inbound` flag for me, as last reported over the link.
   * Display only — it never grants anything here. Undefined until first report.
   */
  peerAllowsMe?: boolean;
  /** Which way control traffic is allowed to flow for this peer. */
  direction: 'inbound' | 'outbound' | 'bidirectional';
  /** Epoch ms the peer was registered. */
  createdAt: number;
  /**
   * The peer's stable machine identity (set by the pairing flow). Optional for
   * legacy/manually-added peers. Used to find-and-update an existing peer so a
   * re-pair updates rather than duplicates.
   */
  machineId?: string;
  /**
   * Whether this peer participates in the fleet transport. Default-true
   * semantics: `undefined` is treated as ENABLED (so legacy peers without the
   * field stay active). When explicitly `false` the PeerLinkManager will NOT
   * dial the peer (an inbound-only server still exists, but nothing is dialled).
   */
  enabled?: boolean;
}
