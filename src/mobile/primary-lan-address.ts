/**
 * The ONE address a phone should dial: the IPv4 on the interface that carries
 * the default route.
 *
 * Why not every interface (as the fleet pairing panel shows)? A phone dials the
 * advertised list in order with a per-address timeout, and a Windows dev box
 * owns a pile of addresses no phone can ever reach — WSL/Hyper-V vEthernet,
 * VirtualBox host-only, Docker, VPN tunnels. A real phone spent ~3s timing out
 * on 172.23.128.1 and 192.168.56.1 before reaching 10.98.1.140. The default-
 * route interface is the one the LAN (and the phone) actually sits on.
 *
 * The OS is asked via a connected UDP socket: connect() on UDP sends nothing,
 * it just makes the kernel pick a route and bind the local address. Offline
 * (no default route) falls back to a name/range filter over the interfaces.
 */

import { createSocket } from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { logger } from '../utils/logger.js';

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Adapter names that are never the LAN a phone is on. */
const VIRTUAL_NAME = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|vpn|TAP|Tailscale|ZeroTier/i;

/** Any routable unicast works; no packet is sent to it. */
const ROUTE_PROBE_TARGET = '8.8.8.8';

export interface PickedAddresses {
  addresses: string[];
  /** True when the default route could not be used and the name filter chose. */
  fallback: boolean;
}

/** Pure selection over an interface table — the testable heart of this module. */
export function pickLanAddresses(interfaces: Interfaces, routeAddress: string | null): PickedAddresses {
  const candidates = externalIpv4(interfaces);
  if (routeAddress && candidates.some((c) => c.address === routeAddress)) {
    return { addresses: [routeAddress], fallback: false };
  }
  const addresses = candidates
    .filter((c) => !VIRTUAL_NAME.test(c.name) && !c.address.startsWith('169.254.'))
    .map((c) => c.address);
  return { addresses, fallback: true };
}

function externalIpv4(interfaces: Interfaces): Array<{ name: string; address: string }> {
  const out: Array<{ name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      // Node <18 reported family as the number 4; both forms are accepted.
      const isIpv4 = entry.family === 'IPv4' || (entry.family as unknown) === 4;
      if (!entry.internal && isIpv4) out.push({ name, address: entry.address });
    }
  }
  return out;
}

/** Ask the OS which local address it would use for the default route. */
export function probeDefaultRouteAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const finish = (address: string | null) => {
      try { socket.close(); } catch { /* already closed */ }
      resolve(address);
    };
    socket.once('error', () => finish(null));
    socket.connect(53, ROUTE_PROBE_TARGET, () => {
      try { finish(socket.address().address); } catch { finish(null); }
    });
  });
}

export interface PrimaryLanAddressResolverDeps {
  interfaces?: () => Interfaces;
  probeRoute?: () => Promise<string | null>;
  logger?: (message: string) => void;
}

/**
 * Caches the last probed route address so `addresses()` can stay synchronous
 * (the advertiser calls it inside a link event); `refresh()` re-probes.
 */
export class PrimaryLanAddressResolver {
  private routeAddress: string | null = null;
  private lastFallback: boolean | null = null;

  constructor(private readonly deps: PrimaryLanAddressResolverDeps = {}) {}

  /** Re-ask the OS for the default-route address. Never throws. */
  async refresh(): Promise<void> {
    try {
      this.routeAddress = await (this.deps.probeRoute ?? probeDefaultRouteAddress)();
    } catch {
      this.routeAddress = null;
    }
  }

  /** `host:port` strings to advertise — normally exactly one. */
  addresses(port: number): string[] {
    const picked = pickLanAddresses((this.deps.interfaces ?? networkInterfaces)(), this.routeAddress);
    this.noteFallback(picked);
    return picked.addresses.map((address) => `${address}:${port}`);
  }

  /** Log only on a transition, so a 30s poll does not spam the log. */
  private noteFallback(picked: PickedAddresses): void {
    if (picked.fallback === this.lastFallback) return;
    this.lastFallback = picked.fallback;
    const message = picked.fallback
      ? `no default-route address; fallback filter chose [${picked.addresses.join(', ')}]`
      : `default-route address is ${picked.addresses[0]}`;
    if (this.deps.logger) this.deps.logger(message);
    else logger.info(`[MobileAddresses] ${message}`);
  }
}
