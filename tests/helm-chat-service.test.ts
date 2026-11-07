import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { HelmChatService } from '../src/mcp/services/helm-chat-service.js';
import { ChatBroker } from '../src/session/chat/chat-broker.js';
import type { ChatBridge, ChatOutboundMessage } from '../src/session/chat/chat-bridge.js';
import type { SessionManager } from '../src/session/manager.js';

let configDir = '';

function makeChat(available = true) {
  configDir = mkdtempSync(join(tmpdir(), 'helm-chat-service-'));
  writeFileSync(join(configDir, 'settings.yaml'), 'hapticFeedback: true\nnotifications: true\n');
  const configLoader = new ConfigLoader(configDir);
  configLoader.load();

  const session = { id: 's1', name: 'Alpha', cliType: 'api', apiTool: true };
  const sessionManager = {
    getSession: (id: string) => id === session.id ? session : null,
  } as unknown as SessionManager;
  const service = new HelmChatService(configLoader, sessionManager);
  const sent: ChatOutboundMessage[] = [];
  const broker = new ChatBroker();
  const bridge: ChatBridge = {
    provider: 'recorder',
    isAvailable: () => available,
    sendToSession: async message => {
      sent.push(message);
      return { sent: true };
    },
  };
  broker.register(bridge);
  service.setChatBroker(broker);
  return { service, sent };
}

afterEach(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = '';
});

describe('HelmChatService.sendChat', () => {
  it('fans one message to the broker for the caller session with its usage', async () => {
    const { service, sent } = makeChat();

    expect(await service.sendChat('s1', 'done', undefined, { contextTokens: 1234, toolCalls: 2 })).toEqual({ sent: true });
    expect(sent).toEqual([{ sessionId: 's1', text: 'done', usage: { contextTokens: 1234, toolCalls: 2 } }]);
  });

  it('forwards a validated attachment path', async () => {
    const { service, sent } = makeChat();
    const filePath = join(configDir, 'report.txt');
    writeFileSync(filePath, 'report');

    expect(await service.sendChat('s1', 'see attached', filePath)).toEqual({ sent: true });
    expect(sent[0]).toMatchObject({ sessionId: 's1', text: 'see attached', filePath });
  });

  it('rejects a missing attachment before fan-out', async () => {
    const { service, sent } = makeChat();

    const result = await service.sendChat('s1', 'see attached', join(configDir, 'missing.txt'));

    expect(result).toMatchObject({ sent: false, reason: expect.stringContaining('File not found') });
    expect(sent).toHaveLength(0);
  });

  it('returns a failed send when no broker surface is available', async () => {
    const { service, sent } = makeChat(false);

    const result = await service.sendChat('s1', 'done');

    expect(result.sent).toBe(false);
    expect(result.reason).toContain('recorder is not available');
    expect(sent).toHaveLength(0);
  });

  it('returns a generic failure without a broker instead of falling back to another route', async () => {
    const { service, sent } = makeChat();
    service.setChatBroker(null);

    const result = await service.sendChat('s1', 'done');

    expect(result).toEqual({ sent: false, reason: 'No chat surface is registered' });
    expect(sent).toHaveLength(0);
  });

  it('does not apply phone text limits to generic chat', async () => {
    const { service, sent } = makeChat();

    const result = await service.sendChat('s1', 'x'.repeat(200));

    expect(result).toEqual({ sent: true });
    expect(sent[0].text).toBe('x'.repeat(200));
  });

  it('resolves caller sessions by ID only', async () => {
    const { service, sent } = makeChat();

    const result = await service.sendChat('Alpha', 'by name');

    expect(result).toMatchObject({ sent: false, reason: expect.stringContaining('not found by ID') });
    expect(sent).toHaveLength(0);
  });
});
