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
    const telegram = new FakeBridge('telegram');
    const mobile = new FakeBridge('mobile');
    broker.register(telegram);
    broker.register(mobile);

    const results = await broker.send(MESSAGE);

    expect(telegram.sent).toEqual([MESSAGE]);
    expect(mobile.sent).toEqual([MESSAGE]);
    expect(results.filter(r => r.sent).map(r => r.provider).sort()).toEqual(['mobile', 'telegram']);
  });

  it('delivers to all THREE bridges — a future LAN surface is not a special case', async () => {
    const broker = new ChatBroker();
    const bridges = ['telegram', 'mobile', 'lan'].map(p => new FakeBridge(p));
    bridges.forEach(bridge => broker.register(bridge));

    await broker.send(MESSAGE);

    expect(bridges.map(b => b.sent.length)).toEqual([1, 1, 1]);
  });

  it('keeps delivering when one bridge throws — a Telegram outage must not silence the phone', async () => {
    const broker = new ChatBroker();
    const telegram = new FakeBridge('telegram');
    telegram.throwOnSend = new Error('Telegram API is down');
    const mobile = new FakeBridge('mobile');
    broker.register(telegram);
    broker.register(mobile);

    const results = await broker.send(MESSAGE);

    expect(mobile.sent).toEqual([MESSAGE]);
    expect(results).toContainEqual({ provider: 'telegram', sent: false, reason: 'Telegram API is down' });
  });

  it('skips an unavailable bridge without error and still reaches the others', async () => {
    const broker = new ChatBroker();
    const telegram = new FakeBridge('telegram');
    telegram.available = false;
    const mobile = new FakeBridge('mobile');
    broker.register(telegram);
    broker.register(mobile);

    const results = await broker.send(MESSAGE);

    expect(telegram.sent).toEqual([]);
    expect(mobile.sent).toEqual([MESSAGE]);
    expect(results.find(r => r.provider === 'telegram')).toEqual({
      provider: 'telegram',
      sent: false,
      reason: 'telegram is not available',
    });
  });

  it('is a no-op with zero bridges registered and never throws', async () => {
    const broker = new ChatBroker();
    await expect(broker.send(MESSAGE)).resolves.toEqual([]);
  });

  it('stops delivering to a bridge once it is unregistered', async () => {
    const broker = new ChatBroker();
    const telegram = new FakeBridge('telegram');
    broker.register(telegram);
    broker.unregister('telegram');

    await broker.send(MESSAGE);

    expect(telegram.sent).toEqual([]);
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
    const telegram = new FakeBridge('telegram');
    const mobile = new FakeBridge('mobile');
    broker.register(telegram);
    broker.register(mobile);

    telegram.receive({ provider: 'telegram', sessionId: 'session-a', text: 'from the desk phone' });
    mobile.receive({ provider: 'mobile', sessionId: 'session-b', text: 'from the kitchen' });
    await vi.waitFor(() => expect(delivered).toHaveLength(2));

    expect(delivered).toEqual([
      { sessionId: 'session-a', text: 'from the desk phone', provider: 'telegram' },
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
