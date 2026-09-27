/**
 * The IPv4 addresses a phone should dial to reach this desktop over LAN:
 * every physical adapter, the default-route one first.
 *
 * Why not every interface (as the fleet pairing panel shows)? A phone dials the
 * advertised list in order with a per-address timeout, and a Windows dev box
 * owns a pile of addresses no phone can ever reach — WSL/Hyper-V vEthernet,
 * VirtualBox host-only, Docker, VPN tunnels. A real phone spent ~3s timing out
 * on 172.23.128.1 and 192.168.56.1 before reaching 10.98.1.140. Those are
 * dropped by name.
 *
 * Why not only the default-route address? A PC on Ethernet and Wi-Fi at once
 * routes out Ethernet, stranding a phone on the Wi-Fi subnet. The route
 * address only decides the order. Tailscale is kept but dialled last: it
 * reaches a phone on the tailnet, but a LAN hop is preferred.
 *
 * The OS is asked for the route via a connected UDP socket: connect() on UDP
 * sends nothing, it just makes the kernel pick a route and bind the local
 * address.
 */

import { createSocket } from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { logger } from '../utils/logger.js';

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Adapter names that are never the LAN a phone is on. */
const VIRTUAL_NAME = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|vpn|TAP|ZeroTier/i;

/** Reachable only over the tailnet — kept, but after every LAN address. */
const OVERLAY_NAME = /Tailscale/i;

/** Any routable unicast works; no packet is sent to it. */
const ROUTE_PROBE_TARGET = '8.8.8.8';

export interface PickedAddresses {
  addresses: string[];
  /** True when the default route is not one of the advertised addresses. */
  fallback: boolean;
}

/** Pure selection over an interface table — the testable heart of this module. */
export function pickLanAddresses(interfaces: Interfaces, routeAddress: string | null): PickedAddresses {
  const physical = externalIpv4(interfaces)
    .filter((c) => !VIRTUAL_NAME.test(c.name) && !c.address.startsWith('169.254.'));
  const rank = (c: { name: string; address: string }) =>
    c.address === routeAddress ? 0 : OVERLAY_NAME.test(c.name) ? 2 : 1;
  const addresses = physical
    .map((c, i) => ({ c, i }))
    .sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i)
    .map(({ c }) => c.address);
  return { addresses, fallback: !physical.some((c) => c.address === routeAddress) };
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

  /** `host:port` strings to advertise, default-route first. */
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
      ? `no usable default-route address; advertising [${picked.addresses.join(', ')}] in adapter order`
      : `default-route address is ${picked.addresses[0]}; advertising [${picked.addresses.join(', ')}]`;
    if (this.deps.logger) this.deps.logger(message);
    else logger.info(`[MobileAddresses] ${message}`);
  }
}
