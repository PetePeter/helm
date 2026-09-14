/**
 * MobileArtifactNotifier — an artifact changing on the desktop becomes a chat
 * record on the phone.
 *
 * The sink is the REAL MobileChatBridge over a recorded radio, so what is
 * asserted is the actual record bytes a Kotlin side will parse — including the
 * additive `kind: 'artifact'` and its artifactId/title payload, which must ride
 * in a FIXED key position because key order is part of this wire format.
 *
 * The manager is real too, wired to the notifier the way production is, because
 * the load-bearing behaviour is the changed→reveal pairing across BOTH events,
 * not either one alone.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MobileArtifactNotifier } from '../src/mobile/mobile-artifact-notifier';
import { MobileChatBridge } from '../src/mobile/mobile-chat-bridge';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store';
import { ArtifactManager } from '../src/session/artifact-manager';
import { decodeRecord } from '../src/mobile/mobile-envelope';
import { EventEmitter } from 'node:events';

class FakeLinks extends EventEmitter {
  readonly online = new Set<string>();
  readonly sent: Array<{ machineId: string; payload: Buffer }> = [];
  isOnline(machineId: string): boolean { return this.online.has(machineId); }
  send(machineId: string, payload: Buffer): boolean {
    this.sent.push({ machineId, payload });
    return true;
  }
  records() {
    return this.sent.map(entry => decodeRecord(entry.payload));
  }
}

let links: FakeLinks;
let bridge: MobileChatBridge;
let notifier: MobileArtifactNotifier;
let artifacts: ArtifactManager;

/** Wire the manager to the notifier exactly as handlers.ts does. */
function wire(): void {
  artifacts.on('artifact:changed', (sessionId: string, artifactIds: string[]) =>
    notifier.changed(sessionId, artifactIds));
  artifacts.on('artifact:reveal', (sessionId: string, artifactId: string) =>
    notifier.revealed(sessionId, artifactId));
}

beforeEach(() => {
  links = new FakeLinks();
  const deviceStore = new MobileDeviceStore(() => {});
  deviceStore.add({ name: 'Pixel', machineId: 'phone-machine', pskRef: 'secret-1', allow: [] });
  bridge = new MobileChatBridge({
    links,
    deviceStore,
    gate: () => undefined,
    sessions: { getSession: (id: string) => (id === 's1' ? { id: 's1', name: 'work' } : null) },
    now: () => 1700000000000,
  });
  bridge.start();
  artifacts = new ArtifactManager(undefined, () => 1700000000000);
  notifier = new MobileArtifactNotifier(bridge, artifacts);
  links.online.add('phone-machine');
});

describe('MobileArtifactNotifier', () => {
  it('pushes one artifact record when a change is followed by its reveal', () => {
    wire();

    const artifact = artifacts.create('s1', 'Q3 report', 'markdown', '# q3');

    expect(links.sent).toHaveLength(1);
    expect(links.records()[0]).toEqual({
      v: 1,
      t: 'chat',
      sessionId: 's1',
      sessionName: 'work',
      text: 'Q3 report',
      at: 1700000000000,
      artifactId: artifact.id,
      title: 'Q3 report',
      kind: 'artifact',
    });
  });

  it('emits the additive keys BEFORE kind, keeping kind last in key order', () => {
    wire();

    artifacts.create('s1', 'Q3 report', 'markdown', '# q3');

    const keys = Object.keys(JSON.parse(links.sent[0].payload.toString('utf8')));
    expect(keys.indexOf('artifactId')).toBeLessThan(keys.indexOf('kind'));
    expect(keys[keys.length - 1]).toBe('kind');
  });

  it('collapses a change into its reveal instead of buzzing twice', () => {
    wire();

    const artifact = artifacts.create('s1', 'report', 'markdown', 'v1');
    artifacts.update(artifact.id, 'v2');

    expect(links.sent).toHaveLength(2);
  });

  it('stays quiet when an artifact is only brought forward, not changed', () => {
    // artifact:reveal also fires when someone just opens an artifact they have
    // already read. Re-opening is not news; only a change marks the artifact.
    const artifact = artifacts.create('s1', 'report', 'markdown', 'v1');
    links.sent.length = 0;

    notifier.revealed('s1', artifact.id);

    expect(links.sent).toHaveLength(0);
  });

  it('never spends one artifact\'s change on a different artifact\'s reveal', () => {
    // The regression: a session-level dirty mark let rename A (changed, no
    // reveal) leak onto a later plain re-open of B, buzzing the wrong artifact.
    wire();

    const a = artifacts.create('s1', 'A', 'markdown', 'a');
    artifacts.create('s1', 'B', 'markdown', 'b');
    links.sent.length = 0;

    artifacts.rename(a.id, 'A — renamed'); // changed, but no reveal follows
    notifier.revealed('s1', 'not-even-a-real-id'); // an unrelated open

    expect(links.sent).toHaveLength(0);

    artifacts.reveal(a.id); // only A's own reveal spends A's mark

    expect(links.sent).toHaveLength(1);
    expect(links.records()[0]).toMatchObject({ artifactId: a.id, title: 'A — renamed' });
  });

  it('buzzes only the changed artifact when a session owns several', () => {
    wire();

    artifacts.create('s1', 'A', 'markdown', 'a');
    const b = artifacts.create('s1', 'B', 'markdown', 'b');
    links.sent.length = 0;

    artifacts.update(b.id, 'b2');
    artifacts.reveal(b.id);

    expect(links.sent).toHaveLength(1);
    expect(links.records()[0]).toMatchObject({ artifactId: b.id, title: 'B' });
  });

  it('names the artifact from the manager, not from the event', () => {
    wire();

    const artifact = artifacts.create('s1', 'renamed later', 'markdown', 'v1');
    artifacts.rename(artifact.id, 'final title');
    links.sent.length = 0;

    artifacts.update(artifact.id, 'v2');

    expect(links.records()[0]).toMatchObject({ artifactId: artifact.id, title: 'final title' });
  });

  it('drops the record when the artifact is gone by reveal time', () => {
    wire();

    artifacts.create('s1', 'report', 'markdown', 'v1');
    artifacts.deleteAllForSession('s1');
    links.sent.length = 0;

    notifier.revealed('s1', 'unknown-artifact');

    expect(links.sent).toHaveLength(0);
  });

  it('sends nothing when no phone is linked, and does not queue it', () => {
    links.online.delete('phone-machine');
    wire();

    artifacts.create('s1', 'report', 'markdown', 'v1');

    // The bridge answered false for every machine; nothing was delivered and
    // nothing is retried — an artifact notice is only true while it happens.
    expect(links.sent).toHaveLength(0);
  });

  it('survives a sink that throws, because a notice must not break its trigger', () => {
    const exploding = new MobileArtifactNotifier(
      { sendArtifact: () => { throw new Error('the radio is gone'); } },
      artifacts,
    );

    expect(() => exploding.changed('s1', ['a1'])).not.toThrow();
    expect(() => exploding.revealed('s1', 'a1')).not.toThrow();
  });

  it('ignores a change event that names no artifact', () => {
    // Nothing moved, so no reveal can spend anything — but recording the call
    // would leave a permanent dirty entry if ids were ignored.
    notifier.changed('s1', []);

    expect(() => notifier.revealed('s1', 'a1')).not.toThrow();
    expect(links.sent).toHaveLength(0);
  });
});
