/**
 * DesktopVoiceBridge — the desktop speaker as one more ChatBridge. Only the
 * operator's chat_send messages are voiced; everything else is declined so a
 * normal session's chat_send never talks out of the desktop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DesktopVoiceBridge, type OperatorReply } from '../src/voice/desktop-voice-bridge';
import { ChatBroker } from '../src/session/chat/chat-broker';

let operatorId: string | null;
let replies: OperatorReply[];
let bridge: DesktopVoiceBridge;

beforeEach(() => {
  operatorId = 'op-1';
  replies = [];
  bridge = new DesktopVoiceBridge({
    getOperatorId: () => operatorId,
    emitReply: (reply) => replies.push(reply),
  });
});

describe('DesktopVoiceBridge', () => {
  it('forwards an operator chat_send to the desktop', async () => {
    const result = await bridge.sendToSession({ sessionId: 'op-1', text: 'Plan P-12 is done.' });

    expect(result).toEqual({ sent: true });
    expect(replies).toEqual([{ sessionId: 'op-1', text: 'Plan P-12 is done.' }]);
  });

  it('declines messages from any other session', async () => {
    const result = await bridge.sendToSession({ sessionId: 'worker', text: 'hi' });

    expect(result.sent).toBe(false);
    expect(replies).toEqual([]);
  });

  it('declines an attachment-only message (nothing to speak)', async () => {
    const result = await bridge.sendToSession({ sessionId: 'op-1', text: '  ', filePath: 'x.png' });

    expect(result.sent).toBe(false);
    expect(replies).toEqual([]);
  });

  it('is only available while an operator exists', () => {
    expect(bridge.isAvailable()).toBe(true);
    operatorId = null;
    expect(bridge.isAvailable()).toBe(false);
  });

  it('rides the broker fan-out alongside other surfaces', async () => {
    const broker = new ChatBroker();
    broker.register(bridge);

    const results = await broker.send({ sessionId: 'op-1', text: 'Done.' });

    expect(results).toEqual([{ provider: 'desktop-voice', sent: true }]);
    expect(replies).toHaveLength(1);
  });
});
