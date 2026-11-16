/**
 * PeerAuditModal component tests — mirrors the ScheduledTaskHistoryModal test
 * style: entries grouped by day, outcome badges rendered with explicit colours.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const auditEntries: any[] = [];
const peerGetAudit = vi.fn(async () => auditEntries);

const handlers: Record<string, ((data?: any) => void) | undefined> = {};
function capture(name: string) {
  return (cb: (data?: any) => void) => { handlers[name] = cb; return () => { handlers[name] = undefined; }; };
}

vi.mock('../../../renderer/ipc/clients.js', () => ({
  peersClient: {
    peerFleetEnabled: vi.fn(async () => true),
    peerList: vi.fn(async () => []),
    peerListDiscovered: vi.fn(async () => []),
    peerGetAudit: (...a: any[]) => peerGetAudit(...a),
  },
  eventsClient: {
    onPeerConfigChanged: capture('config'),
    onPeerLinkStatus: capture('link'),
    onPeerAuditChanged: capture('audit'),
    onPeerDiscovered: capture('discovered'),
    onPeerLost: capture('lost'),
    onPeerSas: capture('sas'),
    onPeerPaired: capture('paired'),
    onPeerFailed: capture('failed'),
  },
}));

import PeerAuditModal from '../../../renderer/components/modals/PeerAuditModal.vue';

const DAY = 86_400_000;

function setEntries(list: any[]) {
  auditEntries.length = 0;
  auditEntries.push(...list);
}

beforeEach(() => {
  vi.clearAllMocks();
  setEntries([]);
});

describe('PeerAuditModal', () => {
  it('groups entries by day and renders outcome badges', async () => {
    const now = Date.now();
    setEntries([
      { id: '1', peerId: 'p1', method: 'session_list', argSummary: 'keys: none', outcome: 'ok', ranAt: now },
      { id: '2', peerId: 'p1', method: 'artifact_get', argSummary: 'keys: id', outcome: 'denied', ranAt: now - 1000 },
      { id: '3', peerId: 'p2', method: 'session_send_text', argSummary: 'keys: text', outcome: 'error', ranAt: now - DAY, error: 'boom' },
    ]);

    const w = mount(PeerAuditModal, { props: { visible: true } });
    await flushPromises();

    // Two day groups: Today + Yesterday.
    const labels = document.querySelectorAll('.pa-day-label');
    const labelText = Array.from(labels).map(l => l.textContent);
    expect(labelText).toContain('Today');
    expect(labelText).toContain('Yesterday');

    // Outcome badges present with their labels.
    const badges = Array.from(document.querySelectorAll('.peer-audit-status')).map(b => b.textContent);
    expect(badges).toContain('OK');
    expect(badges).toContain('Denied');
    expect(badges).toContain('Error');

    // Error entry shows its message.
    expect(document.querySelector('.pa-err')?.textContent).toContain('boom');

    w.unmount();
  });

  it('badge css classes map to explicit outcome styling (dark-mode legibility)', async () => {
    const now = Date.now();
    setEntries([
      { id: '1', peerId: 'p1', method: 'm_ok', argSummary: '', outcome: 'ok', ranAt: now },
      { id: '2', peerId: 'p1', method: 'm_rl', argSummary: '', outcome: 'rate-limited', ranAt: now },
      { id: '3', peerId: 'p1', method: 'm_err', argSummary: '', outcome: 'error', ranAt: now },
    ]);

    const w = mount(PeerAuditModal, { props: { visible: true } });
    await flushPromises();

    expect(document.querySelector('.badge--ok')).not.toBeNull();
    expect(document.querySelector('.badge--warn')).not.toBeNull(); // rate-limited
    expect(document.querySelector('.badge--error')).not.toBeNull();

    w.unmount();
  });

  it('shows an empty-state message when there are no entries', async () => {
    const w = mount(PeerAuditModal, { props: { visible: true } });
    await flushPromises();
    expect(document.querySelector('.pa-empty')?.textContent).toContain('No proxied peer calls');
    w.unmount();
  });
});
