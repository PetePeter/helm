/**
 * chat_send — the transport-neutral chat MCP tool (alias of telegram_chat).
 * Both names must ride the exact same service path: one handler, two names.
 */
import { describe, expect, it, vi } from 'vitest';
import { callMcpTool, type McpToolDispatcherDeps } from '../src/mcp/tools/dispatcher.js';
import type { HelmControlService } from '../src/mcp/helm-control-service.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';
import { getAvailableTools } from '../src/mcp/guides/available-tools.js';
import { getSessionInfo } from '../src/mcp/guides/session-info-guide.js';

function deps(service: unknown): McpToolDispatcherDeps {
  return {
    service: service as HelmControlService,
    setPlanStateWithValidation: () => ({}),
    completePlanWithValidation: () => ({}),
  };
}

function fakeChatService() {
  return { sendTelegramChat: vi.fn(async () => ({ ok: true })) };
}

describe('chat_send dispatch', () => {
  it('reaches the same service method as telegram_chat with the same args', async () => {
    const service = fakeChatService();

    await callMcpTool(deps(service), 'chat_send', { message: 'Need a decision?' }, { sessionId: 'caller-session' });
    await callMcpTool(deps(service), 'telegram_chat', { message: 'Need a decision?' }, { sessionId: 'caller-session' });

    expect(service.sendTelegramChat).toHaveBeenCalledTimes(2);
    expect(service.sendTelegramChat).toHaveBeenNthCalledWith(1, 'caller-session', 'Need a decision?', undefined);
    expect(service.sendTelegramChat).toHaveBeenNthCalledWith(2, 'caller-session', 'Need a decision?', undefined);
  });

  it('forwards filePath and accepts an explicit sessionId for global-token callers', async () => {
    const service = fakeChatService();

    await callMcpTool(
      deps(service),
      'chat_send',
      { sessionId: 's7', message: 'See log', filePath: 'X:\\tmp\\log.txt' },
      {},
    );

    expect(service.sendTelegramChat).toHaveBeenCalledWith('s7', 'See log', 'X:\\tmp\\log.txt');
  });

  it('rejects with a chat_send-prefixed error when no session identity exists', async () => {
    const service = fakeChatService();

    await expect(
      callMcpTool(deps(service), 'chat_send', { message: 'hi' }, {}),
    ).rejects.toThrow('chat_send could not determine your session');
    expect(service.sendTelegramChat).not.toHaveBeenCalled();
  });

  it('still names telegram_chat in the telegram_chat identity error', async () => {
    const service = fakeChatService();

    await expect(
      callMcpTool(deps(service), 'telegram_chat', { message: 'hi' }, {}),
    ).rejects.toThrow('telegram_chat could not determine your session');
  });
});

describe('chat_send tool surface', () => {
  it('is defined alongside telegram_chat with a transport-neutral description', () => {
    const def = MCP_TOOLS.find((t) => t.name === 'chat_send');
    expect(def).toBeDefined();
    expect(def!.description).not.toContain('via Telegram');
    expect(def!.description).toContain('paired phone');
    expect(def!.description).toContain('Telegram');
  });

  it('shares telegram_chat\'s input schema exactly', () => {
    const chatSend = MCP_TOOLS.find((t) => t.name === 'chat_send')!;
    const telegramChat = MCP_TOOLS.find((t) => t.name === 'telegram_chat')!;
    expect(chatSend.inputSchema).toEqual(telegramChat.inputSchema);
  });

  it('documents telegram_chat as an alias without changing its schema', () => {
    const telegramChat = MCP_TOOLS.find((t) => t.name === 'telegram_chat')!;
    expect(telegramChat).toBeDefined();
    expect(telegramChat.description.toLowerCase()).toContain('alias');
  });

  it('appears in the discoverability guide list', () => {
    expect(getAvailableTools().map((t) => t.name)).toContain('chat_send');
  });
});

describe('session_info chat guidance', () => {
  const mgr = { getSession: () => ({ workingDir: '/home/user/project' }) } as any;

  it('points agents at chat_send as the neutral name with telegram_chat as alias', () => {
    const info = getSessionInfo(mgr, { sessionId: 's1' });
    expect(info.chat).toContain('chat_send');
    expect(info.chat).toContain('telegram_chat');
    expect(info.chat.toLowerCase()).toContain('alias');
  });
});
