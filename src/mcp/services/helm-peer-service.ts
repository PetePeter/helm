/**
 * HelmPeerService — the LOCAL-side surface behind the three fleet meta-tools
 * (peer_list / peer_tools / peer_call). It lets a local AI reach into a remote
 * peer's NATIVE tool vocabulary without exploding the tool catalogue: instead of
 * mirroring every remote tool as a namespaced local tool, the AI discovers peers
 * (`list`), fetches a peer's permitted surface (`tools`), then invokes one remote
 * tool by its own name (`call`) with a verbatim-forwarded argument object.
 *
 * All three delegate to the PeerLinkManager (P-0646) which owns the authenticated
 * transport. The manager may be absent when fleet is OFF (the default); in
 * that case every method surfaces a single clear "Fleet is not enabled"
 * error rather than crashing.
 *
 * SECURITY — the authoritative gate is the REMOTE peer's InboundCallGate (it owns
 * the allow-list + hard-deny + rate-limit). `call` additionally rejects a small
 * set of methods CLIENT-SIDE as defence in depth so a local AI can never even
 * attempt to nest peer calls, invoke the reserved discovery sentinel, or trigger
 * a hard-denied host/lifecycle tool on a peer.
 */

import { HARD_DENY_TOOLS, RESERVED_PEER_TOOLS_METHOD } from '../peer/inbound-call-gate.js';
import type { PeerSummary } from '../peer/peer-link-manager.js';

export type { PeerSummary };

/** The minimal PeerLinkManager surface this service depends on. */
interface PeerLinkManagerLike {
  list(): PeerSummary[];
  call(peerId: string, method: string, params: unknown): Promise<unknown>;
}

export interface PeerToolSummary {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
}

export class HelmPeerService {
  /**
   * @param getManager Lazily resolves the live PeerLinkManager, or undefined when
   *   fleet is disabled. A getter (not a stored reference) so the manager can
   *   be wired AFTER this service is constructed, once fleet actually starts.
   */
  constructor(private readonly getManager: () => PeerLinkManagerLike | undefined) {}

  /** Every configured peer with its current online status. */
  list(): { peers: PeerSummary[] } {
    return { peers: this.requireManager().list() };
  }

  /**
   * The tool surface `peer` will actually permit this host to call, fetched via
   * the reserved discovery meta-method (answered in the remote's InboundCallGate,
   * never dispatched). Unknown/offline peers surface the manager's clear error.
   */
  async tools(peer: string): Promise<{ peerId: string; tools: PeerToolSummary[] }> {
    const result = await this.requireManager().call(peer, RESERVED_PEER_TOOLS_METHOD, {}) as { tools?: PeerToolSummary[] };
    return { peerId: peer, tools: result?.tools ?? [] };
  }

  /**
   * Invoke ONE remote tool by its native name with `args` forwarded VERBATIM (no
   * mutation). The tool name is TRIMMED first so leading/trailing whitespace can't
   * smuggle a `peer_`/sentinel/hard-deny method past the guards (e.g. `' peer_call'`),
   * and the trimmed name is what gets forwarded. Rejects client-side, before
   * anything is sent, for empty/meta/hard-deny methods (defence in depth).
   * Offline/timeout/unknown peers surface the manager's clear error unchanged.
   */
  async call(peer: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const manager = this.requireManager();
    const t = tool.trim();
    if (!this.isCallableTool(t)) {
      throw new Error(`Tool not permitted for peer calls: ${tool}`);
    }
    return manager.call(peer, t, args);
  }

  /**
   * Whether `tool` may be forwarded to a peer. Blocks empty names, any nested
   * peer_* tool, the reserved discovery sentinel, and the hard-deny set — the
   * same tools the remote gate would reject, refused here first so a bad call
   * never leaves the machine.
   */
  private isCallableTool(tool: string): boolean {
    if (!tool) return false;
    if (tool.startsWith('peer_')) return false;
    if (tool === RESERVED_PEER_TOOLS_METHOD) return false;
    if (HARD_DENY_TOOLS.has(tool)) return false;
    return true;
  }

  private requireManager(): PeerLinkManagerLike {
    const manager = this.getManager();
    if (!manager) {
      throw new Error('Fleet is not enabled');
    }
    return manager;
  }
}
