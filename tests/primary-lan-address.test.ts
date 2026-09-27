/**
 * Which address the desktop tells a phone to dial. A real phone log showed it
 * dialling a WSL vEthernet address and a VirtualBox host-only address (1.5s each)
 * before the real Wi-Fi one, so virtual adapters are never advertised. A PC on
 * Wi-Fi and Ethernet at once put the route on Ethernet and stranded a Wi-Fi
 * phone, so every physical address is advertised, default-route first.
 */

import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { PrimaryLanAddressResolver, pickLanAddresses } from '../src/mobile/primary-lan-address.js';

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` };
}

/** The desktop from the phone log: Wi-Fi plus the usual virtual adapters. */
const DESKTOP: Record<string, NetworkInterfaceInfo[]> = {
  'vEthernet (WSL (Hyper-V firewall))': [v4('172.23.128.1')],
  'vEthernet (Default Switch)': [v4('172.30.16.1')],
  'VirtualBox Host-Only Network': [v4('192.168.56.1')],
  'Wi-Fi': [v4('10.98.1.140')],
  'Ethernet 3': [v4('169.254.10.20')],
  'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
};

/** Today's desktop: Ethernet and Wi-Fi on different subnets, plus virtual adapters. */
const DUAL_HOMED: Record<string, NetworkInterfaceInfo[]> = {
  'Ethernet 2': [v4('10.99.4.231')],
  'vEthernet (Default Switch)': [v4('172.23.64.1')],
  'VirtualBox Host-Only Network': [v4('192.168.56.1')],
  'Wi-Fi': [v4('10.98.1.140')],
};

describe('pickLanAddresses', () => {
  it('advertises Wi-Fi too when the default route is on Ethernet', () => {
    expect(pickLanAddresses(DUAL_HOMED, '10.99.4.231'))
      .toEqual({ addresses: ['10.99.4.231', '10.98.1.140'], fallback: false });
  });

  it('puts the default-route address first', () => {
    expect(pickLanAddresses(DUAL_HOMED, '10.98.1.140').addresses)
      .toEqual(['10.98.1.140', '10.99.4.231']);
  });

  it('never advertises virtual or link-local adapters', () => {
    expect(pickLanAddresses(DESKTOP, '10.98.1.140'))
      .toEqual({ addresses: ['10.98.1.140'], fallback: false });
  });

  it('ignores a route address that is a virtual adapter', () => {
    expect(pickLanAddresses(DUAL_HOMED, '172.23.64.1'))
      .toEqual({ addresses: ['10.99.4.231', '10.98.1.140'], fallback: true });
  });

  it('falls back to adapter order when the route address is unknown (offline)', () => {
    expect(pickLanAddresses(DUAL_HOMED, null))
      .toEqual({ addresses: ['10.99.4.231', '10.98.1.140'], fallback: true });
  });

  it('drops Docker, VMware, VPN, TAP and ZeroTier by name; keeps Tailscale last', () => {
    const result = pickLanAddresses({
      'Tailscale': [v4('100.64.0.1')],
      'vEthernet (nat)': [v4('172.17.0.1')],
      'VMware Network Adapter VMnet8': [v4('192.168.80.1')],
      'docker0': [v4('172.18.0.1')],
      'NordVPN': [v4('10.5.0.2')],
      'TAP-Windows Adapter V9': [v4('10.9.0.2')],
      'ZeroTier One [abc]': [v4('10.147.0.2')],
      'wsl-bridge': [v4('172.20.0.1')],
      'Ethernet': [v4('192.168.1.20')],
    }, null);
    expect(result.addresses).toEqual(['192.168.1.20', '100.64.0.1']);
  });
});

describe('PrimaryLanAddressResolver', () => {
  it('follows the probed route and appends the port', async () => {
    let route: string | null = '10.98.1.140';
    const resolver = new PrimaryLanAddressResolver({
      interfaces: () => DESKTOP,
      probeRoute: async () => route,
      logger: () => {},
    });
    await resolver.refresh();
    expect(resolver.addresses(47475)).toEqual(['10.98.1.140:47475']);

    route = null;
    await resolver.refresh();
    expect(resolver.addresses(47475)).toEqual(['10.98.1.140:47475']);
  });

  it('logs the fallback once per transition, not on every call', async () => {
    const logs: string[] = [];
    const resolver = new PrimaryLanAddressResolver({
      interfaces: () => DESKTOP,
      probeRoute: async () => null,
      logger: (m) => logs.push(m),
    });
    await resolver.refresh();
    resolver.addresses(1);
    resolver.addresses(1);
    expect(logs.filter((m) => m.includes('no usable default-route'))).toHaveLength(1);
  });

  it('treats a probe that throws as offline', async () => {
    const resolver = new PrimaryLanAddressResolver({
      interfaces: () => DESKTOP,
      probeRoute: async () => { throw new Error('ENETUNREACH'); },
      logger: () => {},
    });
    await resolver.refresh();
    expect(resolver.addresses(9)).toEqual(['10.98.1.140:9']);
  });
});
