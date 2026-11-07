/**
 * ChatBroker — fan-out and inbound routing.
 *
 * Real broker, fake bridges. The fakes are real ChatBridge implementations that
 * record what they were asked to send, not mocks with verify() calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ChatBroker } from '../src/session/chat/chat-broker';
import type {
  ChatBridge,
  ChatInboundMessage,
  ChatOutboundMessage,
  ChatSendResult,
} from '../src/session/chat/chat-bridge';

class FakeBridge extends EventEmitter implements ChatBridge {
  readonly sent: ChatOutboundMessage[] = [];
  available = true;
  throwOnSend: Error | null = null;

  constructor(readonly provider: string) {
    super();
  }

  isAvailable(): boolean {
    return this.available;
  }

  async sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult> {
    if (this.throwOnSend) throw this.throwOnSend;
    this.sent.push(message);
    return { sent: true };
  }

  /** Simulate the user replying from this surface. */
  receive(message: ChatInboundMessage): void {
    this.emit('inbound', message);
  }
}

const MESSAGE: ChatOutboundMessage = { sessionId: 'session-1', text: 'build finished' };

describe('ChatBroker fan-out', () => {
  it('delivers a message to every registered bridge', async () => {
    const broker = new ChatBroker();
    const mobile = new FakeBridge('mobile');
    const lan = new FakeBridge('lan');
    broker.register(mobile);
    broker.register(lan);

    const results = await broker.send(MESSAGE);

    expect(mobile.sent).toEqual([MESSAGE]);
    expect(lan.sent).toEqual([MESSAGE]);
    expect(results.filter(r => r.sent).map(r => r.provider).sort()).toEqual(['lan', 'mobile']);
  });

  it('delivers to every registered surface — LAN is not a special case', async () => {
    const broker = new ChatBroker();
    const bridges = ['mobile', 'lan'].map(p => new FakeBridge(p));
    bridges.forEach(bridge => broker.register(bridge));

    await broker.send(MESSAGE);

    expect(bridges.map(b => b.sent.length)).toEqual([1, 1]);
  });

  it('keeps delivering when one bridge throws — a LAN failure must not silence the phone', async () => {
    const broker = new ChatBroker();
    const lan = new FakeBridge('lan');
    lan.throwOnSend = new Error('LAN bridge is down');
    const mobile = new FakeBridge('mobile');
    broker.register(lan);
    broker.register(mobile);

    const results = await broker.send(MESSAGE);

    expect(mobile.sent).toEqual([MESSAGE]);
    expect(results).toContainEqual({ provider: 'lan', sent: false, reason: 'LAN bridge is down' });
  });

  it('skips an unavailable bridge without error and still reaches the others', async () => {
    const broker = new ChatBroker();
    const lan = new FakeBridge('lan');
    lan.available = false;
    const mobile = new FakeBridge('mobile');
    broker.register(lan);
    broker.register(mobile);

    const results = await broker.send(MESSAGE);

    expect(lan.sent).toEqual([]);
    expect(mobile.sent).toEqual([MESSAGE]);
    expect(results.find(r => r.provider === 'lan')).toEqual({
      provider: 'lan',
      sent: false,
      reason: 'lan is not available',
    });
  });

  it('is a no-op with zero bridges registered and never throws', async () => {
    const broker = new ChatBroker();
    await expect(broker.send(MESSAGE)).resolves.toEqual([]);
  });

  it('stops delivering to a bridge once it is unregistered', async () => {
    const broker = new ChatBroker();
    const lan = new FakeBridge('lan');
    broker.register(lan);
    broker.unregister('lan');

    await broker.send(MESSAGE);

    expect(lan.sent).toEqual([]);
  });

  it('replaces a bridge registered twice under the same provider', async () => {
    const broker = new ChatBroker();
    const first = new FakeBridge('mobile');
    const second = new FakeBridge('mobile');
    broker.register(first);
    broker.register(second);

    await broker.send(MESSAGE);

    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual([MESSAGE]);
  });
});

describe('ChatBroker inbound routing', () => {
  it('routes inbound from either bridge to the session it names', async () => {
    const delivered: Array<{ sessionId: string; text: string; provider: string }> = [];
    const broker = new ChatBroker({
      deliver: async (message) => {
        delivered.push({ sessionId: message.sessionId, text: message.text, provider: message.provider });
      },
    });
    const lan = new FakeBridge('lan');
    const mobile = new FakeBridge('mobile');
    broker.register(lan);
    broker.register(mobile);

    lan.receive({ provider: 'lan', sessionId: 'session-a', text: 'from the local network' });
    mobile.receive({ provider: 'mobile', sessionId: 'session-b', text: 'from the kitchen' });
    await vi.waitFor(() => expect(delivered).toHaveLength(2));

    expect(delivered).toEqual([
      { sessionId: 'session-a', text: 'from the local network', provider: 'lan' },
      { sessionId: 'session-b', text: 'from the kitchen', provider: 'mobile' },
    ]);
  });

  it('stops routing inbound from an unregistered bridge', async () => {
    const delivered: ChatInboundMessage[] = [];
    const broker = new ChatBroker({ deliver: async (m) => { delivered.push(m); } });
    const mobile = new FakeBridge('mobile');
    broker.register(mobile);
    broker.unregister('mobile');

    mobile.receive({ provider: 'mobile', sessionId: 'session-b', text: 'ignored' });
    await Promise.resolve();

    expect(delivered).toEqual([]);
  });

  it('survives a delivery sink that rejects', async () => {
    const broker = new ChatBroker({ deliver: async () => { throw new Error('PTY is gone'); } });
    const mobile = new FakeBridge('mobile');
    broker.register(mobile);

    expect(() => mobile.receive({ provider: 'mobile', sessionId: 'x', text: 'boom' })).not.toThrow();
  });
});
