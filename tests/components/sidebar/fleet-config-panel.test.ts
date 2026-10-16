/**
 * FleetConfigPanel component tests (P-0658) — mirrors McpTab's panel: an
 * enabled checkbox, host + port inputs, and a status line. Emits `update` with a
 * partial on each change; port is normalised; status reflects off vs running.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FleetConfigPanel from '../../../renderer/components/settings/pages/FleetConfigPanel.vue';

type Status = { enabled: boolean; running: boolean; error: string | null; addresses: string[]; allInterfaces: boolean };

function mountPanel(
  over: Partial<{ enabled: boolean; host: string; port: number }> = {},
  status?: Status,
) {
  const config = { enabled: false, host: '0.0.0.0', port: 47474, ...over };
  return mount(FleetConfigPanel, {
    props: {
      config,
      // Default to a healthy running stack so tests that only care about config
      // do not have to describe status.
      status: status ?? {
        enabled: config.enabled, running: config.enabled, error: null,
        addresses: [], allInterfaces: true,
      },
    },
  });
}

describe('FleetConfigPanel.vue', () => {
  it('renders the enabled checkbox and port from props', () => {
    const w = mountPanel({ enabled: true, host: '127.0.0.1', port: 50000 });
    expect((w.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    expect((w.find('input[type="number"]').element as HTMLInputElement).value).toBe('50000');
  });

  it('offers no host input — the status line already shows the usable addresses', () => {
    // A wildcard bind is right in every real deployment, and the address a peer
    // must dial is the only actionable fact; a host box just adds a way to get
    // it wrong. settings.yaml still honours the value for pinning an interface.
    const w = mountPanel({ enabled: true, host: '0.0.0.0', port: 47474 });
    expect(w.find('input[type="text"]').exists()).toBe(false);
  });

  it('emits { enabled } when the checkbox is toggled', async () => {
    const w = mountPanel({ enabled: false });
    const box = w.find('input[type="checkbox"]');
    await box.setValue(true);
    expect(w.emitted('update')).toContainEqual([{ enabled: true }]);
  });

  it('emits { port } on port change, normalising an out-of-range value to the default', async () => {
    const w = mountPanel();
    const port = w.find('input[type="number"]');
    await port.setValue('99999');
    await port.trigger('change');
    expect(w.emitted('update')).toContainEqual([{ port: 47474 }]);
  });

  it('emits the parsed port on a valid change', async () => {
    const w = mountPanel();
    const port = w.find('input[type="number"]');
    await port.setValue('40000');
    await port.trigger('change');
    expect(w.emitted('update')).toContainEqual([{ port: 40000 }]);
  });

  it('status text is Off when disabled', () => {
    const w = mountPanel({ enabled: false });
    expect(w.find('.fcp-status-value').text()).toMatch(/off/i);
  });

  it('shows the addresses a peer can actually reach, not the wildcard bind', () => {
    // "0.0.0.0:47474" is true and useless — nobody can type it into the other Helm.
    const w = mountPanel(
      { enabled: true, host: '0.0.0.0', port: 47474 },
      { enabled: true, running: true, error: null, addresses: ['10.98.1.140:47474'], allInterfaces: true },
    );
    expect(w.find('.fcp-status-value').text()).toMatch(/running/i);
    expect(w.text()).toContain('10.98.1.140:47474');
    expect(w.text()).not.toContain('0.0.0.0:47474');
  });

  it('surfaces a start failure instead of claiming to be running', () => {
    // The real bug: mDNS threw at startup, the UI said nothing, and the user had
    // no way to tell a dead stack from a quiet network.
    const w = mountPanel(
      { enabled: true, host: '0.0.0.0', port: 47474 },
      { enabled: true, running: false, error: 'Dynamic require of "bonjour-service" is not supported', addresses: [], allInterfaces: true },
    );
    expect(w.find('.fcp-status-value').text()).toMatch(/failed/i);
    expect(w.text()).toContain('bonjour-service');
  });

  it('status follows props.config (server-confirmed), NOT the local form — ticking the box does not flip status until props update', async () => {
    // props.config still disabled; user ticks the checkbox (optimistic local edit).
    const w = mountPanel({ enabled: false, host: '0.0.0.0', port: 47474 });
    await w.find('input[type="checkbox"]').setValue(true);

    // The update event fired, but the round-trip has not confirmed yet, so status
    // must STILL read Off (derived from props.config, not localEnabled).
    expect(w.emitted('update')).toContainEqual([{ enabled: true }]);
    expect(w.find('.fcp-status-value').text()).toMatch(/off/i);

    // Once the parent persists + re-fetches and passes the confirmed config down,
    // the status flips to Running.
    await w.setProps({
      config: { enabled: true, host: '0.0.0.0', port: 47474 },
      status: { enabled: true, running: true, error: null, addresses: [], allInterfaces: true },
    });
    expect(w.find('.fcp-status-value').text()).toMatch(/running/i);
  });

  it('status reverts to Off if props.config stays disabled even when the port is edited', async () => {
    const w = mountPanel({ enabled: false, host: '0.0.0.0', port: 47474 });
    const port = w.find('input[type="number"]');
    await port.setValue('50001');
    await port.trigger('change');
    // Local port changed, but props.config.enabled is false → status stays Off.
    expect(w.find('.fcp-status-value').text()).toMatch(/off/i);
  });
});
