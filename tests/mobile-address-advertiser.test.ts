/**
 * MobileAddressAdvertiser — the desktop telling a phone where to dial it.
 *
 * What matters here is not that a message goes out, but WHAT it means: an empty
 * list is a real instruction ("stop dialling"), the push repeats rather than
 * synchronises, and nothing about resolving an address may endanger a link.
 */

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { MobileAddressAdvertiser } from '../src/mobile/mobile-address-advertiser.js';
import { decodeRecord, type MobileLanRecord } from '../src/mobile/mobile-envelope.js';

const PHONE = 'phone-machine-1';
const OTHER = 'phone-machine-2';

/** A link layer that really tracks who is online and records what was sent. */
class FakeLinks extends EventEmitter {
  readonly sent: Array<{ machineId: string; message: Buffer }> = [];
  readonly online = new Set<string>();
  /** A send that fails the way a dropped pipe does, rather than throwing. */
  failSend = false;

  isOnline(machineId: string): boolean {
    return this.online.has(machineId);
  }

  send(machineId: string, message: Buffer): boolean {
    if (this.failSend || !this.online.has(machineId)) return false;
    this.sent.push({ machineId, message });
    return true;
  }

  /** Simulate a link coming up, exactly as MobileLinkManager announces it. */
  bringOnline(machineId: string): void {
    this.online.add(machineId);
    this.emit('online', machineId);
  }
}

function build(addresses: () => string[] = () => ['192.168.1.20:47475']) {
  const links = new FakeLinks();
  const logs: string[] = [];
  const advertiser = new MobileAddressAdvertiser({
    links,
    addresses,
    linkedMachines: () => [...links.online],
    logger: (message) => logs.push(message),
  });
  return { links, logs, advertiser };
}

/** The address list inside the one record sent at `index`. */
function addressesAt(links: FakeLinks, index: number): string[] {
  const record = decodeRecord(links.sent[index].message) as MobileLanRecord;
  expect(record.t).toBe('lan');
  return record.addresses;
}

describe('MobileAddressAdvertiser', () => {
  it('tells a phone where to dial as soon as it links', async () => {
    const { links } = build();

    links.bringOnline(PHONE);

    expect(links.sent).toHaveLength(1);
    expect(links.sent[0].machineId).toBe(PHONE);
    expect(addressesAt(links, 0)).toEqual(['192.168.1.20:47475']);
  });

  it('sends an EMPTY list when there is nothing to dial', async () => {
    // This is the instruction "stop dialling" — it is how disabling LAN reaches
    // a phone that is connected right now. Sending nothing would leave the
    // phone hammering a port that is no longer open.
    const { links } = build(() => []);

    links.bringOnline(PHONE);

    expect(links.sent).toHaveLength(1);
    expect(addressesAt(links, 0)).toEqual([]);
  });

  it('re-advertises to every live phone when the settings change', async () => {
    let port = 47475;
    const { links, advertiser } = build(() => [`192.168.1.20:${port}`]);
    links.bringOnline(PHONE);
    links.bringOnline(OTHER);

    port = 50000;
    advertiser.advertiseAll();

    expect(links.sent).toHaveLength(4);
    expect(addressesAt(links, 2)).toEqual(['192.168.1.20:50000']);
    expect(addressesAt(links, 3)).toEqual(['192.168.1.20:50000']);
  });

  it('repeats on every link rather than tracking what a phone already knows', async () => {
    // Idempotent by construction: a missed push is repaired by the next link,
    // so there is no sync state to get wrong and no version to negotiate.
    const { links } = build();

    links.bringOnline(PHONE);
    links.online.delete(PHONE);
    links.bringOnline(PHONE);

    expect(links.sent).toHaveLength(2);
  });

  it('does not advertise to a phone that has already dropped', async () => {
    // The event and the send are not atomic: a link can end in between, and the
    // event still arrives. Advertising then would push into a dead channel.
    const { links } = build();

    // An 'online' that is already stale by the time it is handled.
    links.emit('online', PHONE);

    expect(links.sent).toEqual([]);
  });

  it('never lets a failed address lookup take the link down', async () => {
    const { links, logs } = build(() => { throw new Error('no interfaces'); });

    expect(() => links.bringOnline(PHONE)).not.toThrow();
    expect(links.sent).toEqual([]);
    expect(logs.join(' ')).toContain('no interfaces');
  });

  it('reports a send that did not go, and does not pretend it did', async () => {
    const { links, logs } = build();
    links.failSend = true;

    links.bringOnline(PHONE);

    expect(links.sent).toEqual([]);
    expect(logs.join(' ')).toContain('could not send');
  });

  it('stops advertising once disposed', async () => {
    const { links, advertiser } = build();
    advertiser.dispose();

    links.bringOnline(PHONE);

    expect(links.sent).toEqual([]);
  });
});
