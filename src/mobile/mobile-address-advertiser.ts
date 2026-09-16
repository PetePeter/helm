/**
 * MobileAddressAdvertiser — tells a linked phone where to find this desktop.
 *
 * Helm listens and the phone dials, so the phone is the end that holds an
 * address. Left to itself that address is a typed string that rots the day the
 * desktop's DHCP lease moves, and the phone then goes quiet with nothing to
 * explain why.
 *
 * mDNS is how the fleet lane repairs that, and it is not available here: mDNS
 * is multicast and does not route over a VPN, which is exactly the case this
 * transport exists to serve. So the repair rides the channel we already have.
 *
 * TRUST: addresses go out over an ALREADY AUTHENTICATED SecureChannel, and the
 * phone must accept them from nowhere else. An address learned any other way is
 * not an address — it is an invitation to dial an attacker, who would then
 * still fail the PSK handshake, but only after Helm had been pointed away from
 * its real peer.
 *
 * It is a PUSH with no acknowledgement and no versioning: sent on every link,
 * and again whenever the settings change. Idempotent by construction, so a
 * missed one is repaired by the next link rather than by a protocol.
 */

import { encodeLan } from './mobile-envelope.js';
import { logger } from '../utils/logger.js';

export interface MobileAddressAdvertiserDeps {
  /**
   * The link layer. `online` fires once per established link — including after
   * a transport swap? NO: a swap deliberately emits nothing, because the phone
   * already has the addresses and its link did not change identity.
   */
  links: {
    on(event: 'online', handler: (machineId: string) => void): unknown;
    off(event: 'online', handler: (machineId: string) => void): unknown;
    send(machineId: string, message: Buffer): boolean;
    isOnline(machineId: string): boolean;
  };
  /**
   * Where this desktop can currently be reached, `host:port`.
   *
   * Returns EMPTY when LAN is off or unbound, and that empty list is sent: it
   * is how "I disabled LAN" reaches a phone that is connected right now.
   */
  addresses: () => string[];
  /** Every machine currently linked — used when settings change, not on link. */
  linkedMachines: () => string[];
  logger?: (message: string) => void;
}

export class MobileAddressAdvertiser {
  private readonly onOnline = (machineId: string) => this.advertiseTo(machineId);

  constructor(private readonly deps: MobileAddressAdvertiserDeps) {
    this.deps.links.on('online', this.onOnline);
  }

  /** Stop advertising. Idempotent. */
  dispose(): void {
    this.deps.links.off('online', this.onOnline);
  }

  /**
   * Re-advertise to every live phone. Call after a settings change so a phone
   * that is connected RIGHT NOW learns the new port, or learns that LAN is off,
   * without waiting for its next reconnect.
   */
  advertiseAll(): void {
    for (const machineId of this.deps.linkedMachines()) this.advertiseTo(machineId);
  }

  private advertiseTo(machineId: string): void {
    // A phone that dropped between the event and here is not an error.
    if (!this.deps.links.isOnline(machineId)) return;
    let addresses: string[];
    try {
      addresses = this.deps.addresses();
    } catch (error) {
      // Enumerating interfaces can fail; a link must not die because of it.
      this.log(`could not resolve this machine's addresses: ${describe(error)}`);
      return;
    }
    if (!this.deps.links.send(machineId, encodeLan(addresses))) {
      this.log(`could not send the address list to ${machineId}`);
      return;
    }
    this.log(`advertised ${addresses.length} address(es) to ${machineId}`);
  }

  private log(message: string): void {
    if (this.deps.logger) this.deps.logger(message);
    else logger.info(`[MobileAddresses] ${message}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
