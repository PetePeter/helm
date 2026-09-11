/**
 * MobileChatBridge — the phone as a chat surface, and the inbound call path.
 *
 * The load-bearing assertion in this file is that EVERY inbound record reaches a
 * tool only through MobileGate. That was the one unproven half of "no path skips
 * the gate" until this bridge existed.
 *
 * Real bridge, real envelope codec, real MobileGate over a fake dispatcher and a
 * real MobileDeviceStore. Only the radio is faked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { MobileChatBridge } from '../src/mobile/mobile-chat-bridge';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store';
import { MobileGate, MOBILE_DENY_MESSAGE, createDefaultMobileRateLimiter } from '../src/mobile/mobile-gate';
import { MobileAuditLog } from '../src/mobile/mobile-audit-log';
import { decodeRecord, encodeCall } from '../src/mobile/mobile-envelope';
import type { MobileDevice } from '../src/types/mobile-device';

/** The slice of MobileLinkManager the bridge drives, with a recorder attached. */
class FakeLinks extends EventEmitter {
  readonly sent: Array<{ machineId: string; payload: Buffer }> = [];
  readonly online = new Set<string>();
  failSendTo: string | null = null;

  isOnline(machineId: string): boolean {
    return this.online.has(machineId);
  }

  send(machineId: string, payload: Buffer): boolean {
    if (this.failSendTo === machineId) return false;
    this.sent.push({ machineId, payload });
    return true;
  }

  /** Simulate the phone sending Helm a decrypted application record. */
  receive(machineId: string, payload: Buffer): void {
    this.emit('message', machineId, payload);
  }

  /** Every record the bridge sent back to a phone, decoded. */
  records() {
    return this.sent.map((entry) => decodeRecord(entry.payload));
  }
}

let links: FakeLinks;
let deviceStore: MobileDeviceStore;
let dispatched: Array<{ method: string; params: unknown; deviceId: string }>;
let gate: MobileGate;
let bridge: MobileChatBridge;
let phone: MobileDevice;

const SESSIONS = new Map([['s1', { id: 's1', name: 'work' }]]);

beforeEach(() => {
  links = new FakeLinks();
  deviceStore = new MobileDeviceStore(() => {});
  phone = deviceStore.add({
    name: 'Pixel',
    machineId: 'phone-machine',
    deviceId: 'aa:bb:cc',
    pskRef: 'secret-1',
    allow: ['session_list', 'session_send_text'],
  });
  dispatched = [];
  gate = new MobileGate({
    deviceStore,
    dispatch: async (method, params, ctx) => {
      dispatched.push({ method, params, deviceId: ctx.sessionId ?? '' });
      return { ok: method };
    },
    rateLimiter: createDefaultMobileRateLimiter(),
    audit: new MobileAuditLog(() => {}),
  });
  bridge = new MobileChatBridge({
    links,
    deviceStore,
    gate: () => gate,
    sessions: { getSession: (id: string) => SESSIONS.get(id) ?? null },
    now: () => 1700000000000,
  });
  bridge.start();
});

describe('MobileChatBridge as a chat surface', () => {
  it('is unavailable until a paired phone is actually linked', async () => {
    expect(bridge.isAvailable()).toBe(false);
    links.online.add('phone-machine');
    expect(bridge.isAvailable()).toBe(true);
  });

  it('reports not-sent rather than throwing when no phone is online', async () => {
    await expect(bridge.sendToSession({ sessionId: 's1', text: 'hello' }))
      .resolves.toEqual({ sent: false, reason: 'No phone is linked' });
  });

  it('encodes an agent message as a chat record and sends it to every linked phone', async () => {
    const second = deviceStore.add({ name: 'Tablet', machineId: 'tablet-machine', pskRef: 'secret-2', allow: [] });
    links.online.add('phone-machine');
    links.online.add(second.machineId);

    const result = await bridge.sendToSession({ sessionId: 's1', text: 'the build is green' });

    expect(result.sent).toBe(true);
    expect(links.sent.map(entry => entry.machineId).sort()).toEqual(['phone-machine', 'tablet-machine']);
    expect(links.records()[0]).toEqual({
      v: 1, t: 'chat', sessionId: 's1', sessionName: 'work', text: 'the build is green', at: 1700000000000,
    });
  });

  it('skips a disabled device even while its link is still up', async () => {
    links.online.add('phone-machine');
    deviceStore.update(phone.id, { enabled: false });

    await bridge.sendToSession({ sessionId: 's1', text: 'hello' });

    expect(links.sent).toEqual([]);
  });

  it('reports sent when at least one phone took the message', async () => {
    const second = deviceStore.add({ name: 'Tablet', machineId: 'tablet-machine', pskRef: 'secret-2', allow: [] });
    links.online.add('phone-machine');
    links.online.add(second.machineId);
    links.failSendTo = 'phone-machine';

    await expect(bridge.sendToSession({ sessionId: 's1', text: 'hi' })).resolves.toEqual({ sent: true });
  });

  it('carries an attachment path and the voice flag through to the record', async () => {
    links.online.add('phone-machine');

    await bridge.sendToSession({ sessionId: 's1', text: '', filePath: 'C:\\tmp\\note.ogg', asVoice: true });

    expect(links.records()[0]).toMatchObject({ filePath: 'C:\\tmp\\note.ogg', voice: true });
  });

  it('refuses to send for a session that does not exist', async () => {
    links.online.add('phone-machine');

    await expect(bridge.sendToSession({ sessionId: 'gone', text: 'hi' }))
      .resolves.toEqual({ sent: false, reason: 'Session not found: gone' });
    expect(links.sent).toEqual([]);
  });
});

describe('MobileChatBridge inbound calls go through MobileGate and nowhere else', () => {
  it('dispatches a permitted call under the mobile proxy identity and answers with a result', async () => {
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('c1', 'session_list', { limit: 5 }));
    await vi.waitFor(() => expect(links.sent).toHaveLength(1));

    expect(dispatched).toEqual([{ method: 'session_list', params: { limit: 5 }, deviceId: `mobile:${phone.id}` }]);
    expect(links.records()[0]).toEqual({ v: 1, t: 'result', id: 'c1', result: { ok: 'session_list' } });
  });

  it('answers a denied call with the uniform deny message and never dispatches it', async () => {
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('c2', 'session_close', { sessionId: 's1' }));
    await vi.waitFor(() => expect(links.sent).toHaveLength(1));

    expect(dispatched).toEqual([]);
    expect(links.records()[0]).toEqual({
      v: 1, t: 'error', id: 'c2', error: { code: -32000, message: MOBILE_DENY_MESSAGE },
    });
  });

  it('drops a record from a machine that is not a registered device', async () => {
    links.receive('stranger-machine', encodeCall('c3', 'session_list'));
    await Promise.resolve();

    expect(dispatched).toEqual([]);
    expect(links.sent).toEqual([]);
  });

  it('drops a malformed record without dispatching or answering', async () => {
    links.receive('phone-machine', Buffer.from('not json at all', 'utf8'));
    await Promise.resolve();

    expect(dispatched).toEqual([]);
    expect(links.sent).toEqual([]);
  });

  it('drops a non-call record — a phone may not push results or chat at Helm', async () => {
    links.receive('phone-machine', Buffer.from(JSON.stringify({
      v: 1, t: 'chat', sessionId: 's1', sessionName: 'work', text: 'injected', at: 1,
    }), 'utf8'));
    await Promise.resolve();

    expect(dispatched).toEqual([]);
    expect(links.sent).toEqual([]);
  });

  it('denies every call when no gate is wired, rather than falling through to a dispatcher', async () => {
    const ungatedLinks = new FakeLinks();
    const ungated = new MobileChatBridge({
      links: ungatedLinks,
      deviceStore,
      gate: () => undefined,
      sessions: { getSession: (id: string) => SESSIONS.get(id) ?? null },
    });
    ungated.start();

    ungatedLinks.receive('phone-machine', encodeCall('c4', 'session_list'));
    await vi.waitFor(() => expect(ungatedLinks.sent).toHaveLength(1));

    expect(dispatched).toEqual([]);
    expect(ungatedLinks.records()[0]).toMatchObject({ t: 'error', error: { message: MOBILE_DENY_MESSAGE } });
  });

  it('stops answering once stopped', async () => {
    bridge.stop();

    links.receive('phone-machine', encodeCall('c5', 'session_list'));
    await Promise.resolve();

    expect(dispatched).toEqual([]);
    expect(links.sent).toEqual([]);
  });
});
