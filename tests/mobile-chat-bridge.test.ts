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
import { MobileChatJournal } from '../src/mobile/mobile-chat-journal';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store';
import { MobileGate, MOBILE_DENY_MESSAGE, createDefaultMobileRateLimiter } from '../src/mobile/mobile-gate';
import { decodeBlobResult, decodeRecord, encodeCall, isBlobPayload } from '../src/mobile/mobile-envelope';
import type { MobileDevice } from '../src/types/mobile-device';

/** The slice of MobileLinkManager the bridge drives, with a recorder attached. */
class FakeLinks extends EventEmitter {
  readonly sent: Array<{ machineId: string; payload: Buffer }> = [];
  readonly online = new Set<string>();
  failSendTo: string | null = null;
  /**
   * When set, sends to [failSendTo] fail only from this index in [sent] onward —
   * how a real link dies mid-conversation: the ack fits, the next frame does not.
   */
  failSendFromIndex: number | null = null;

  isOnline(machineId: string): boolean {
    return this.online.has(machineId);
  }

  send(machineId: string, payload: Buffer): boolean {
    if (this.failSendTo === machineId
      && (this.failSendFromIndex === null || this.sent.length >= this.failSendFromIndex)) {
      return false;
    }
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
let journal: MobileChatJournal;
let phone: MobileDevice;

const SESSIONS = new Map<string, { id: string; name: string; interactionChannel: 'telegram' | 'desktop' }>([
  ['s1', { id: 's1', name: 'work', interactionChannel: 'desktop' }],
]);
const sessionUpdates: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
const NOW = 1_700_000_000_000;

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
  sessionUpdates.length = 0;
  SESSIONS.get('s1')!.interactionChannel = 'desktop';
  gate = new MobileGate({
    deviceStore,
    dispatch: async (method, params, ctx) => {
      dispatched.push({ method, params, deviceId: ctx.sessionId ?? '' });
      return { ok: method };
    },
    rateLimiter: createDefaultMobileRateLimiter(),
  });
  // Same clock as the bridge: a journal entry stamped with the bridge's `at`
  // must not be born already older than the ttl.
  journal = new MobileChatJournal({ now: () => NOW });
  bridge = new MobileChatBridge({
    links,
    deviceStore,
    gate: () => gate,
    sessions: {
      getSession: (id: string) => SESSIONS.get(id) ?? null,
      updateSession: (sessionId: string, patch: { interactionChannel: 'telegram' | 'desktop' }) => {
        sessionUpdates.push({ sessionId, patch: { ...patch } });
        const session = SESSIONS.get(sessionId);
        if (session) session.interactionChannel = patch.interactionChannel;
      },
    },
    journal,
    now: () => NOW,
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
      v: 1, t: 'chat', sessionId: 's1', sessionName: 'work', text: 'the build is green',
      at: 1700000000000, seq: 1,
    });
  });

  it('journals a message once with its seq, before and regardless of delivery', async () => {
    // No phone online: the fan-out row will say not-sent, the journal must not care.
    await bridge.sendToSession({ sessionId: 's1', text: 'nobody heard this' });
    links.online.add('phone-machine');
    await bridge.sendToSession({ sessionId: 's1', text: 'and this' });

    expect(journal.since(0).map(entry => [entry.seq, entry.record.text])).toEqual([
      [1, 'nobody heard this'],
      [2, 'and this'],
    ]);
    // And the wire record carries the seq a catching-up phone will key on.
    expect(links.records()[0]).toMatchObject({ text: 'and this', seq: 2 });
  });

  it('alerts and artifact notices are journaled by nothing and carry no seq', () => {
    links.online.add('phone-machine');

    bridge.sendAlert('s1', 'completion', 'Finished');
    bridge.sendArtifact('s1', 'art-1', 'Report');

    expect(journal.since(0)).toEqual([]);
    expect(links.records()[0]).not.toHaveProperty('seq');
  });

  it('marks an alert with its kind, which is what keeps it out of the phone thread', () => {
    links.online.add('phone-machine');

    expect(bridge.sendAlert('s1', 'completion', 'Finished')).toBe(true);
    expect(links.records()[0]).toEqual({
      v: 1, t: 'chat', sessionId: 's1', sessionName: 'work', text: 'Finished',
      at: 1700000000000, kind: 'completion',
    });
  });

  it('an ordinary message still carries no kind, so it stays a message', async () => {
    links.online.add('phone-machine');

    await bridge.sendToSession({ sessionId: 's1', text: 'the build is green' });

    expect(links.records()[0]).not.toHaveProperty('kind');
  });

  it('drops an alert for a session that no longer exists rather than naming it blank', () => {
    links.online.add('phone-machine');

    expect(bridge.sendAlert('gone', 'attention', 'Needs input')).toBe(false);
    expect(links.sent).toHaveLength(0);
  });

  it('reports an alert nobody could receive, and sends nothing', () => {
    expect(bridge.sendAlert('s1', 'attention', 'Needs input')).toBe(false);
    expect(links.sent).toHaveLength(0);
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

  it('carries the ids a phone can fetch an attachment by', async () => {
    links.online.add('phone-machine');

    await bridge.sendToSession({
      sessionId: 's1',
      text: 'here it is',
      filePath: 'C:\\tmp\\holiday.jpg',
      attachment: {
        artifactId: 'art-1',
        attachmentId: 'att-1',
        filename: 'holiday.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 2_400_000,
      },
    });

    // The path rides along for an older phone build, but the ids are the only
    // part this end of the link can ever act on.
    expect(links.records()[0]).toMatchObject({
      artifactId: 'art-1',
      attachmentId: 'att-1',
      filename: 'holiday.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2_400_000,
    });
  });

  it('refuses to send for a session that does not exist', async () => {
    links.online.add('phone-machine');

    await expect(bridge.sendToSession({ sessionId: 'gone', text: 'hi' }))
      .resolves.toEqual({ sent: false, reason: 'Session not found: gone' });
    expect(links.sent).toEqual([]);
  });
});

/**
 * Catch-up. A phone reports the seq of the last chat message it holds; the
 * bridge replays the journal gap over the same link, oldest first. The gate is
 * real in every test here — the cursor call is a gated call like any other,
 * which is what keeps a disabled device from pulling the journal.
 */
describe('MobileChatBridge catch-up from a phone cursor', () => {
  /** Journal three messages; only `online` (default none) were linked at send time. */
  async function seedJournal(online: string[] = []) {
    online.forEach(machineId => links.online.add(machineId));
    await bridge.sendToSession({ sessionId: 's1', text: 'one' });
    await bridge.sendToSession({ sessionId: 's1', text: 'two' });
    await bridge.sendToSession({ sessionId: 's1', text: 'three' });
    links.sent.length = 0;
  }

  it('replays the gap after the reported cursor, oldest first, after answering the call', async () => {
    await seedJournal();
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('k1', '__chat_cursor__', { seq: 1 }));
    await vi.waitFor(() => expect(links.sent.length).toBe(3));

    const records = links.records();
    // The ack first — the replay is not the answer to the call, it follows it.
    expect(records[0]).toMatchObject({ t: 'result', id: 'k1' });
    expect(records.slice(1).map(record => (record as { text?: string; seq?: number }).text))
      .toEqual(['two', 'three']);
    expect(records[1]).toMatchObject({ t: 'chat', seq: 2 });
    expect(records[2]).toMatchObject({ t: 'chat', seq: 3 });
  });

  it('a cursor at zero — or absent, or unreadable — replays the whole journal', async () => {
    await seedJournal();
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('k2', '__chat_cursor__'));
    await vi.waitFor(() => expect(links.sent.length).toBeGreaterThanOrEqual(4));

    expect(links.records().slice(1).map(record => (record as { text?: string }).text))
      .toEqual(['one', 'two', 'three']);
  });

  it('a current cursor replays nothing but still gets its ack', async () => {
    await seedJournal();
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('k3', '__chat_cursor__', { seq: 3 }));
    await vi.waitFor(() => expect(links.sent).toHaveLength(1));

    expect(links.records()).toEqual([{ v: 1, t: 'result', id: 'k3', result: { ok: true } }]);
  });

  it('each phone catches up against its own cursor over the one shared journal', async () => {
    const second = deviceStore.add({ name: 'Tablet', machineId: 'tablet-machine', pskRef: 'secret-2', allow: [] });
    await seedJournal(['phone-machine', second.machineId]);
    links.online.add('phone-machine');
    links.online.add(second.machineId);

    links.receive('phone-machine', encodeCall('k4', '__chat_cursor__', { seq: 3 }));
    links.receive(second.machineId, encodeCall('k5', '__chat_cursor__', { seq: 0 }));
    await vi.waitFor(() => expect(links.sent.length).toBeGreaterThanOrEqual(5));

    const forPhone = links.sent.filter(entry => entry.machineId === 'phone-machine');
    const forTablet = links.sent.filter(entry => entry.machineId === second.machineId);
    expect(decodeRecord(forPhone[0].payload)).toMatchObject({ t: 'result', id: 'k4' });
    expect(forPhone).toHaveLength(1); // already caught up
    // The tablet resets to zero and takes everything, whatever the phone took.
    expect(forTablet[0].payload).toBeDefined();
    expect(decodeRecord(forTablet[0].payload)).toMatchObject({ t: 'result', id: 'k5' });
    expect(forTablet.slice(1).map(entry => (decodeRecord(entry.payload) as { text?: string }).text))
      .toEqual(['one', 'two', 'three']);
  });

  it('a link that refuses a send mid-stream stops there, and the cursor story resumes it', async () => {
    await seedJournal();
    links.online.add('phone-machine');
    // The ack still fits; everything after it is refused, like a link dying
    // between two frames.
    links.failSendTo = 'phone-machine';
    links.failSendFromIndex = 1;

    links.receive('phone-machine', encodeCall('k6', '__chat_cursor__', { seq: 1 }));
    await vi.waitFor(() => expect(links.sent).toHaveLength(1));

    // Only the ack got through; no replayed record followed it, so the phone's
    // cursor stays at 1 and the next link up re-requests exactly the remainder.
    expect(links.records()).toEqual([{ v: 1, t: 'result', id: 'k6', result: { ok: true } }]);

    links.failSendTo = null;
    links.failSendFromIndex = null;
    links.receive('phone-machine', encodeCall('k7', '__chat_cursor__', { seq: 1 }));
    await vi.waitFor(() => expect(links.sent.length).toBe(4));
    expect(links.records().slice(2).map(record => (record as { text?: string }).text))
      .toEqual(['two', 'three']);
  });

  it('the cursor call is gated: a disabled device gets the deny, never the replay', async () => {
    await seedJournal();
    links.online.add('phone-machine');
    deviceStore.update(phone.id, { enabled: false });

    links.receive('phone-machine', encodeCall('k8', '__chat_cursor__', { seq: 0 }));
    await vi.waitFor(() => expect(links.sent).toHaveLength(1));

    expect(dispatched).toEqual([]); // answered in-gate, like __mobile_tools__
    expect(links.records()[0]).toMatchObject({ t: 'error', error: { message: MOBILE_DENY_MESSAGE } });
    expect(links.sent).toHaveLength(1); // and nothing after it
  });

  it('accepts the seq as the string the phone param encoder also produces', async () => {
    await seedJournal();
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('k9', '__chat_cursor__', { seq: '2' }));
    await vi.waitFor(() => expect(links.sent.length).toBe(2));

    expect(links.records()[1]).toMatchObject({ t: 'chat', seq: 3, text: 'three' });
  });

  it('replayed records carry replay:true — the phone must not buzz for its own backlog', async () => {
    await seedJournal();
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('k10', '__chat_cursor__', { seq: 0 }));
    await vi.waitFor(() => expect(links.sent.length).toBe(4));

    for (const record of links.records().slice(1)) {
      expect(record).toMatchObject({ replay: true });
    }
  });
});

/**
 * Phone-origin echoes. A phone's ACCEPTED `session_send_text` call is part of
 * the conversation, so it is echoed into the journal — journaled ONLY, never
 * live-fanned, and named by the sending phone so it can drop its own echo.
 */
describe('MobileChatBridge journaling a phone reply', () => {
  it('a phone reply the gate accepted is journaled phone-origin and fanned nowhere', async () => {
    const second = deviceStore.add({ name: 'Tablet', machineId: 'tablet-machine', pskRef: 'secret-2', allow: [] });
    links.online.add('phone-machine');
    links.online.add(second.machineId);

    links.receive('phone-machine', encodeCall('r1', 'session_send_text', { sessionId: 's1', text: 'on my way' }));
    await vi.waitFor(() => expect(links.sent).toHaveLength(1));

    // The gate's result went back, and NOTHING else — no live fan-out of the echo.
    expect(links.records()).toEqual([{ v: 1, t: 'result', id: 'r1', result: { ok: 'session_send_text' } }]);
    expect(journal.since(0)).toEqual([
      {
        seq: 1,
        record: {
          sessionId: 's1', sessionName: 'work', text: 'on my way',
          at: 1700000000000, originId: 'phone-machine:r1',
        },
      },
    ]);
  });

  it('the echo id is namespaced per phone, so two phones numbering calls alike never collide', async () => {
    const second = deviceStore.add({
      name: 'Tablet', machineId: 'tablet-machine', pskRef: 'secret-2', allow: ['session_send_text'],
    });
    links.online.add('phone-machine');
    links.online.add(second.machineId);

    links.receive('phone-machine', encodeCall('p1', 'session_send_text', { sessionId: 's1', text: 'from pixel' }));
    links.receive(second.machineId, encodeCall('p1', 'session_send_text', { sessionId: 's1', text: 'from tablet' }));
    await vi.waitFor(() => expect(journal.latestSeq()).toBe(2));

    expect(journal.since(0).map(entry => entry.record.originId)).toEqual([
      'phone-machine:p1',
      'tablet-machine:p1',
    ]);
  });

  it('a reply for a session that does not exist is answered but journaled as nothing', async () => {
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('r2', 'session_send_text', { sessionId: 'gone', text: 'hi' }));
    await vi.waitFor(() => expect(links.sent).toHaveLength(1));

    expect(links.records()[0]).toMatchObject({ t: 'result' });
    expect(journal.since(0)).toEqual([]);
  });

  it('an inbound phone message sets the session channel to telegram, exactly as the Telegram relay does', async () => {
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('r3', 'session_send_text', { sessionId: 's1', text: 'from the phone' }));
    await vi.waitFor(() => expect(journal.latestSeq()).toBe(1));

    // Same value the Telegram relay sets (relay-service.ts) — deliberately NOT
    // a new enum member: the G2 deny keys on "not at the desktop".
    expect(sessionUpdates).toEqual([{ sessionId: 's1', patch: { interactionChannel: 'telegram' } }]);
    expect(SESSIONS.get('s1')!.interactionChannel).toBe('telegram');
  });

  it('does not rewrite the channel when the session is already telegram', async () => {
    SESSIONS.get('s1')!.interactionChannel = 'telegram';
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('r4', 'session_send_text', { sessionId: 's1', text: 'again' }));
    await vi.waitFor(() => expect(journal.latestSeq()).toBe(1));

    expect(sessionUpdates).toEqual([]);
  });

  it('a reply the gate denied is journaled as nothing — a refusal is not conversation', async () => {
    deviceStore.update(phone.id, { allow: [] });
    links.online.add('phone-machine');

    links.receive('phone-machine', encodeCall('r3', 'session_send_text', { sessionId: 's1', text: 'hi' }));
    await vi.waitFor(() => expect(links.sent).toHaveLength(1));

    expect(links.records()[0]).toMatchObject({ t: 'error' });
    expect(journal.since(0)).toEqual([]);
  });

  it('the echo rides the replay back with its origin id, replay-marked', async () => {
    links.online.add('phone-machine');
    links.receive('phone-machine', encodeCall('r4', 'session_send_text', { sessionId: 's1', text: 'from pixel' }));
    await vi.waitFor(() => expect(journal.latestSeq()).toBe(1));
    links.sent.length = 0;

    links.receive('phone-machine', encodeCall('r5', '__chat_cursor__', { seq: 0 }));
    await vi.waitFor(() => expect(links.sent.length).toBe(2));

    expect(links.records()[1]).toMatchObject({
      t: 'chat', text: 'from pixel', seq: 1, originId: 'phone-machine:r4', replay: true,
    });
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
      sessions: {
        getSession: (id: string) => SESSIONS.get(id) ?? null,
        updateSession: () => undefined,
      },
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

/**
 * The binary download reply. The bridge is the ONE place a result is turned into
 * bytes, and the rule it must keep is narrow: downloads go out as a blob record,
 * everything else stays JSON, and NOTHING skips the gate to get there.
 */
describe('MobileChatBridge answering a download', () => {
  /** A bridge whose gate returns one fixed dispatch result. */
  function bridgeReturning(result: unknown, allow: string[] = ['session_artifact_download']) {
    const downloadLinks = new FakeLinks();
    const store = new MobileDeviceStore(() => {});
    store.add({
      name: 'Pixel',
      machineId: 'phone-machine',
      deviceId: 'aa:bb:cc',
      pskRef: 'secret-1',
      allow,
    });
    const downloadBridge = new MobileChatBridge({
      links: downloadLinks,
      deviceStore: store,
      gate: () => new MobileGate({
        deviceStore: store,
        dispatch: async () => result,
        rateLimiter: createDefaultMobileRateLimiter(),
      }),
      sessions: {
        getSession: (id: string) => SESSIONS.get(id) ?? null,
        updateSession: () => undefined,
      },
    });
    downloadBridge.start();
    return downloadLinks;
  }

  const body = Buffer.from([0x00, 0x7b, 0xff, 0x10]);

  it('answers a download with raw bytes in a blob record, not base64 JSON', async () => {
    const downloadLinks = bridgeReturning({
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      bytes: body,
      offset: 0,
      total: 9,
      eof: false,
    });

    downloadLinks.receive('phone-machine', encodeCall('d1', 'session_artifact_download'));
    await vi.waitFor(() => expect(downloadLinks.sent).toHaveLength(1));

    const payload = downloadLinks.sent[0].payload;
    const blob = decodeBlobResult(payload);
    expect(blob).not.toBeNull();
    expect(blob!.id).toBe('d1');
    expect(blob!.bytes.equals(body)).toBe(true);
    expect(blob!.total).toBe(9);
    // No base64 anywhere on the wire — the whole point of the record.
    expect(payload.toString('latin1')).not.toContain('base64');
  });

  it('leaves every other answer as a JSON result record', async () => {
    const otherLinks = bridgeReturning({ sessions: [] }, ['session_list']);

    otherLinks.receive('phone-machine', encodeCall('d2', 'session_list'));
    await vi.waitFor(() => expect(otherLinks.sent).toHaveLength(1));

    expect(otherLinks.records()[0]).toMatchObject({ t: 'result', id: 'd2' });
    expect(isBlobPayload(otherLinks.sent[0].payload)).toBe(false);
  });

  it('still goes through the gate: a tool outside the allow-list gets an error, never bytes', async () => {
    const deniedLinks = bridgeReturning({
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      bytes: body,
    }, ['session_list']);

    deniedLinks.receive('phone-machine', encodeCall('d3', 'session_artifact_download'));
    await vi.waitFor(() => expect(deniedLinks.sent).toHaveLength(1));

    expect(isBlobPayload(deniedLinks.sent[0].payload)).toBe(false);
    expect(deniedLinks.records()[0]).toMatchObject({ t: 'error', error: { message: MOBILE_DENY_MESSAGE } });
  });
});
