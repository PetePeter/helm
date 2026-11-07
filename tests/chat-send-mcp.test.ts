/** chat_send is the sole MCP reply tool and routes through the neutral service. */
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
  return { sendChat: vi.fn(async () => ({ ok: true })) };
}

describe('chat_send dispatch', () => {
  it('routes through the neutral service', async () => {
    const service = fakeChatService();

    await callMcpTool(deps(service), 'chat_send', { message: 'Need a decision?' }, { sessionId: 'caller-session' });

    expect(service.sendChat).toHaveBeenCalledWith('caller-session', 'Need a decision?', undefined);
  });

  it('forwards filePath and accepts an explicit sessionId for global-token callers', async () => {
    const service = fakeChatService();

    await callMcpTool(
      deps(service),
      'chat_send',
      { sessionId: 's7', message: 'See log', filePath: 'X:\\tmp\\log.txt' },
      {},
    );

    expect(service.sendChat).toHaveBeenCalledWith('s7', 'See log', 'X:\\tmp\\log.txt');
  });

  it('rejects when no session identity exists', async () => {
    const service = fakeChatService();

    await expect(
      callMcpTool(deps(service), 'chat_send', { message: 'hi' }, {}),
    ).rejects.toThrow('chat_send could not determine your session');
    expect(service.sendChat).not.toHaveBeenCalled();
  });
});

describe('chat_send guidance', () => {
  it('has a transport-neutral description', () => {
    const def = MCP_TOOLS.find((t) => t.name === 'chat_send');
    expect(def).toBeDefined();
    expect(def!.description).toContain('paired phone');
  });

  it('appears in the discoverability guide list', () => {
    expect(getAvailableTools().map((t) => t.name)).toContain('chat_send');
  });
});

describe('session_info chat guidance', () => {
  const mgr = { getSession: () => ({ workingDir: '/home/user/project' }) } as any;

  it('points agents to chat_send', () => {
    const info = getSessionInfo(mgr, { sessionId: 's1' });
    expect(info.chat).toContain('chat_send');
  });
});
