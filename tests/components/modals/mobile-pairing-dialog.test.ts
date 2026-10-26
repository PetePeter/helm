/**
 * MobilePairingDialog — the Wi-Fi half of a first pairing. Real component and
 * real useMobileDevices; IPC faked at the module boundary.
 *
 * Regression: with zero phones paired, nothing on the desktop showed its
 * address, so "Pair over Wi-Fi" on the phone had nothing to type in.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

let lanFromMain = { enabled: true, port: 47475, listening: false, addresses: [] as string[], pairingAddresses: [] as string[] };

vi.mock('../../../renderer/ipc/clients.js', () => ({
  mobileClient: {
    mobileList: async () => [],
    mobileLanConfig: async () => lanFromMain,
    mobileStartPairing: async () => ({ ok: true }),
    mobileCancelPairing: async () => ({ ok: true }),
    mobileConfirmPairing: async () => ({ ok: true }),
  },
  eventsClient: {
    onMobileDevicesChanged: () => () => {},
    onMobilePairingState: () => () => {},
  },
}));

const { default: MobilePairingDialog } = await import('../../../renderer/components/modals/MobilePairingDialog.vue');
const { useMobileDevices, resetMobileDevicesStateForTesting } =
  await import('../../../renderer/composables/useMobileDevices.js');

async function openDialog() {
  const w = mount(MobilePairingDialog);
  await useMobileDevices().startPairing();
  await flushPromises();
  return w;
}

describe('MobilePairingDialog Wi-Fi pairing', () => {
  beforeEach(() => {
    resetMobileDevicesStateForTesting();
    document.body.innerHTML = '';
  });

  it('shows the pairing address while scanning, before any phone is paired', async () => {
    lanFromMain = { enabled: true, port: 47475, listening: false, addresses: [], pairingAddresses: ['10.98.1.140:47476'] };
    const w = await openDialog();
    const chips = Array.from(document.querySelectorAll('.mp-address')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['10.98.1.140:47476']);
    w.unmount();
  });

  it('says how to turn Wi-Fi pairing on when LAN is off', async () => {
    lanFromMain = { enabled: false, port: 47475, listening: false, addresses: [], pairingAddresses: [] };
    const w = await openDialog();
    expect(document.querySelectorAll('.mp-address')).toHaveLength(0);
    expect(document.querySelector('.mp-lan-off')?.textContent).toContain('Settings → Mobile');
    w.unmount();
  });
});
