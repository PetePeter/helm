import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { LocalhostMcpServer } from '../src/mcp/localhost-mcp-server.js';
import { mintSessionAuthToken } from '../src/mcp/session-auth.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeService(): HelmControlService {
  return {
    listClis: vi.fn(() => [{ cliType: 'codex', name: 'codex', command: 'codex', supportsResume: false, supportedDirPaths: ['X:\\coding\\gamepad-cli-hub'] }]),
    listSkills: vi.fn(() => [{ id: 'skill-1', name: 'Review', triggerCondition: 'Use for reviews' }]),
    getSkill: vi.fn((id: string) => ({ id, name: 'Review', description: 'Use for reviews', body: 'Check the diff', aiAmendable: false, allProjects: true, projectIds: [] })),
    createSkill: vi.fn((input: Record<string, unknown>) => ({ id: 'skill-created', description: '', body: '', aiAmendable: false, allProjects: true, projectIds: [], ...input })),
    updateSkill: vi.fn((id: string, updates: Record<string, unknown>) => ({ id, name: 'Review', description: 'Use for reviews', body: 'Check the diff', aiAmendable: true, allProjects: true, projectIds: [], ...updates })),
    resolveSkill: vi.fn((type: string, _filter?: { projectId?: string; dirPath?: string }) => ({
      id: 'resolved-1',
      name: 'System Guide',
      description: 'Built-in guide',
      body: 'System guide body',
      type,
      source: 'system',
      aiAmendable: false,
      allProjects: true,
      projectIds: [],
    })),
    submitSkillFeedback: vi.fn((_id: string, _stars: number, _summary: string, _improvement?: string) => ({ received: true })),
    getSkillStats: vi.fn(() => ({
      useCount: 7,
      avgRating: 2.5,
      reviewCount: 2,
      reviews: [
        { stars: 1, summary: 'Did nothing useful', improvement: 'Drop step 3', cliName: 'codex-a', cliType: 'codex', timestamp: '2026-01-01T00:00:00.000Z' },
        { stars: 4, summary: 'Mostly worked', cliName: 'claude-b', cliType: 'claude', timestamp: '2026-01-02T00:00:00.000Z' },
      ],
    })),
    clearSkillReviews: vi.fn(() => ({ useCount: 7, avgRating: 0, reviewCount: 0, reviews: [] })),
    deleteSkill: vi.fn(() => true),
    listDirectories: vi.fn(() => [{ dirPath: 'X:\\coding\\gamepad-cli-hub', name: 'Helm', source: ['config', 'plans'], planCount: 8, sessionCount: 0 }]),
    listPlans: vi.fn((dirPath: string) => [{ id: 'p1', dirPath, title: 'Task', description: 'Desc', status: 'ready' }]),
    plansSummary: vi.fn(() => [{ id: 'p1', humanId: 'P-0001', title: 'Task', status: 'ready', blockedBy: [], blocks: [] }]),
    getPlan: vi.fn((id: string) => ({
      id,
      dirPath: '/proj',
      title: 'Task',
      description: 'Desc',
      status: 'ready',
      sequenceId: 'seq-1',
      sequenceContextMetadata: [{ id: 'ctx-1', title: 'Testing Strategy', type: 'Testing', permission: 'readonly' }],
    })),
    listPlanContexts: vi.fn((_planId: string) => [{ id: 'ctx-1', type: 'Testing', source: 'both' }]),
    getPlanSequence: vi.fn((id: string) => ({ id, dirPath: '/proj', title: 'Sequence', missionStatement: 'Mission', sharedMemory: 'Shared', order: 0, createdAt: 1, updatedAt: 1, memberPlanIds: ['p1'], memberHumanIds: ['P-0001'] })),
    createPlan: vi.fn((dirPath: string, title: string, description: string, type?: string) => ({ id: 'created', dirPath, title, description, status: 'ready', ...(type ? { type } : {}) })),
    updatePlan: vi.fn((id: string, updates: { title?: string; description?: string; type?: string | null; autoImplement?: boolean; completionRecap?: boolean }) => ({ id, dirPath: '/proj', title: updates.title ?? 'Task', description: updates.description ?? 'Desc', status: 'ready', ...(updates.type ? { type: updates.type } : {}), ...(updates.autoImplement !== undefined ? { autoImplement: updates.autoImplement } : {}), ...(updates.completionRecap !== undefined ? { completionRecap: updates.completionRecap } : {}) })),
    deletePlan: vi.fn(() => true),
    completePlan: vi.fn((id: string, _notes?: string) => ({ id, dirPath: '/proj', title: 'Task', description: 'Desc', status: 'done' })),
    setPlanState: vi.fn((id: string, status: string) => ({ id, dirPath: '/proj', title: 'Task', description: 'Desc', status })),
    linkPlans: vi.fn(),
    unlinkPlans: vi.fn(),
    listContexts: vi.fn((projectId: string) => [{ id: 'ctx-1', projectId, title: 'Testing Strategy', type: 'Testing', permission: 'readonly', content: 'Use vitest', x: null, y: null, createdAt: 1, updatedAt: 1, sequenceIds: ['seq-1'], planIds: ['p1'] }]),
    getContext: vi.fn((id: string) => ({ id, projectId: 'proj-1', title: 'Testing Strategy', type: 'Testing', permission: 'readonly', content: 'Use vitest', x: null, y: null, createdAt: 1, updatedAt: 1, sequenceIds: ['seq-1'], planIds: ['p1'] })),
    createContext: vi.fn((input: Record<string, unknown>) => ({ id: 'ctx-1', createdAt: 1, updatedAt: 1, x: null, y: null, content: '', type: 'Knowledge', permission: 'readonly', ...input })),
    updateContext: vi.fn((id: string, updates: Record<string, unknown>) => ({ id, projectId: 'proj-1', title: 'Updated Context', type: 'Knowledge', permission: 'readonly', content: '', x: null, y: null, createdAt: 1, updatedAt: 2, ...updates })),
    deleteContext: vi.fn(() => true),
    appendContext: vi.fn((id: string, text: string) => ({ id, projectId: 'proj-1', title: 'Running Notes', type: 'Knowledge', permission: 'writable', content: `Before\n\n${text}`, x: null, y: null, createdAt: 1, updatedAt: 2 })),
    setContextPosition: vi.fn((id: string, x: number | null, y: number | null) => ({ id, projectId: 'proj-1', title: 'Visual Anchor', type: 'Knowledge', permission: 'readonly', content: '', x, y, createdAt: 1, updatedAt: 2 })),
    bindContext: vi.fn(() => true),
    unbindContext: vi.fn(() => true),
    listPlanAttachments: vi.fn(() => [{ id: 'a1', planId: 'p1', filename: 'note.txt', sizeBytes: 5, relativePath: 'p1/a1.txt', createdAt: 1, updatedAt: 1 }]),
    addPlanAttachment: vi.fn((planId: string, input: { filePath: string; contentType?: string }) => {
      const filename = input.filePath.split('/').pop() ?? input.filePath.split('\\').pop() ?? 'file';
      return {
        id: 'a1',
        planId,
        filename,
        ...(input.contentType ? { contentType: input.contentType } : {}),
        sizeBytes: 3,
        relativePath: `${planId}/a1.txt`,
        createdAt: 1,
        updatedAt: 1,
      };
    }),
    deletePlanAttachment: vi.fn(() => true),
    getPlanAttachment: vi.fn((planId: string, attachmentId: string) => ({
      attachment: { id: attachmentId, planId, filename: 'note.txt', sizeBytes: 5, relativePath: `${planId}/${attachmentId}.txt`, createdAt: 1, updatedAt: 1 },
      tempPath: 'C:\\Temp\\helm-attachment-a1-note.txt',
    })),
    exportDirectory: vi.fn((dirPath: string) => ({ dirPath, items: [], dependencies: [] })),
    exportItem: vi.fn((id: string) => ({ item: { id, dirPath: '/proj', title: 'Task', description: 'Desc', status: 'ready' }, dependencies: [] })),
    spawnCli: vi.fn((cliType: string, dirPath: string, name: string) => ({ id: 's2', name, cliType, workingDir: dirPath })),
    listSessions: vi.fn((dirPath?: string, projectId?: string) => [{ id: 's1', name: 'Claude', cliType: 'claude-code', ...(dirPath ? { workingDir: dirPath } : {}), ...(projectId ? { projectId } : {}) }]),
    getSession: vi.fn((sessionId: string) => ({ id: sessionId, name: 'Claude', cliType: 'claude-code' })),
    sendTextToSession: vi.fn(async (sessionRef: string, text: string, _options?: { submit?: boolean; senderSessionId?: string; senderSessionName?: string; expectsResponse?: boolean }) => ({ success: true, sessionId: sessionRef, name: 'Claude' })),
    sendInputToSession: vi.fn(async (sessionRef: string, _sequence: string, _options?: { senderSessionId?: string; senderSessionName?: string; impliedSubmit?: boolean; verify?: boolean }) => ({ success: true, sessionId: sessionRef, name: 'Claude' })),
    clearSession: vi.fn(async (sessionRef: string, _options: { senderSessionId: string; senderSessionName: string; context?: string }) => ({ ok: true, contextRelayed: false, usedTempFile: false, sessionId: sessionRef })),
    readSessionTerminal: vi.fn((sessionRef: string, lines = 50, mode = 'both') => ({
      sessionId: sessionRef,
      name: 'Claude',
      cliType: 'claude-code',
      requestedLines: lines,
      returnedLines: 1,
      mode,
      ptyRunning: true,
      raw: ['\x1b[32mhello\x1b[0m'],
      stripped: ['hello'],
      lastOutputAt: 1234,
    })),
    claimSessionPlan: vi.fn((sessionRef: string, planId: string) => ({ sessionId: sessionRef, name: 'Claude', planId, planTitle: 'Task', planStatus: 'coding' })),
    getTelegramStatus: vi.fn(() => ({
      enabled: true,
      configured: true,
      running: true,
      available: true,
      chatConfigured: true,
      allowedUsersConfigured: true,
      openChannels: 1,
      guidance: 'Use Telegram only for mobile-friendly urgent blockers.',
    })),
    listTelegramChannels: vi.fn(() => []),
    closeTelegramChannel: vi.fn(async (channelId: string) => ({ id: channelId, sessionId: 's1', sessionName: 'Claude', topicId: 42, status: 'closed', createdAt: 1, updatedAt: 3 })),
    sendTelegramChat: vi.fn(async (sessionRef: string, message: string) => ({
      sent: true,
    })),
    notifyUser: vi.fn((sessionRef: string, title: string, content: string) => ({ delivered: 'bubble', sessionRef, title, content })),
    getAppVisibility: vi.fn(() => ({ visibility: 'visible-focused', screenLocked: false, activeSessionId: 's1' })),
    restartHelm: vi.fn((resume = true, _options?: { callerSessionId?: string; resumePrompt?: string }) => ({ sessionsClosed: resume ? 0 : 2, resume })),
    createScheduledTask: vi.fn((params: Record<string, unknown>) => ({ id: 'task-1', status: 'pending', ...params })),
    listScheduledTasks: vi.fn(() => [{ id: 'task-1', title: 'Follow up', status: 'pending' }]),
    getScheduledTask: vi.fn((id: string) => ({ id, title: 'Follow up', status: 'pending' })),
    updateScheduledTask: vi.fn((id: string, updates: Record<string, unknown>) => ({ id, title: 'Updated', status: 'pending', ...updates })),
    cancelScheduledTask: vi.fn(() => true),
    deleteScheduledTask: vi.fn(() => true),
    getPlanIdMapping: vi.fn((humanId: string) => ({ uuid: 'p1', humanId: 'P-0001' })),
  } as unknown as HelmControlService;
}

async function rpc(port: number, token: string | null, body: unknown, headers: Record<string, string> = {}) {
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };
  if (token !== null) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
});
}

describe('LocalhostMcpServer', () => {
  const servers: LocalhostMcpServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()!;
      await server.close();
    }
  });

  it('does not start when HELM_MCP_TOKEN is missing', async () => {
    const server = new LocalhostMcpServer(makeService(), { env: {} });
    servers.push(server);
    await expect(server.start()).resolves.toBe(false);
    expect(server.getAddress()).toBeNull();
  });

  it('retries the same port until it frees (EADDRINUSE resilience)', async () => {
    const blocker = createHttpServer();
    const blockerPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as AddressInfo).port));
    });

    const server = new LocalhostMcpServer(makeService(), { token: 'secret-token', port: blockerPort });
    servers.push(server);

    // Free the port mid-flight; a subsequent retry should bind the same port.
    setTimeout(() => blocker.close(), 250);

    await expect(server.start({ attempts: 20, delayMs: 100 })).resolves.toBe(true);
    expect(server.getAddress()!.port).toBe(blockerPort);
  });

  it('throws EADDRINUSE after exhausting retries while the port stays busy', async () => {
    const blocker = createHttpServer();
    const blockerPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as AddressInfo).port));
    });

    const server = new LocalhostMcpServer(makeService(), { token: 'secret-token', port: blockerPort });
    servers.push(server);

    await expect(server.start({ attempts: 3, delayMs: 20 })).rejects.toMatchObject({ code: 'EADDRINUSE' });

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it('close() resolves promptly even with an idle keep-alive connection open', async () => {
    const server = new LocalhostMcpServer(makeService(), { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    // Open a keep-alive connection and leave the socket idle (not closed).
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/mcp', method: 'GET', agent },
        (res) => { res.on('data', () => {}); res.on('end', () => resolve()); },
      );
      req.on('error', reject);
      req.end();
    });

    // Without closeAllConnections() the lingering socket would make this hang.
    await expect(
      Promise.race([
        server.close().then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]),
    ).resolves.toBe('closed');

    agent.destroy();
  });

  it('requires bearer auth', async () => {
    const server = new LocalhostMcpServer(makeService(), { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(response.status).toBe(401);
  });

  it('serves initialize and tools/list requests', async () => {
    const server = new LocalhostMcpServer(makeService(), { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const initResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });
    const initJson = await initResponse.json();
    expect(initJson.result.protocolVersion).toBe('2025-06-18');

    const toolsResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const toolsJson = await toolsResponse.json();
    expect(Array.isArray(toolsJson.result.tools)).toBe(true);
    expect(toolsJson.result.tools.some((tool: { name: string }) => tool.name === 'plan_list')).toBe(true);
    const planCreateTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'plan_create');
    const planCompleteTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'plan_complete');
    const planNextLinkTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'plan_nextplan_link');
    const planSetStateTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'plan_set_state');
    const sendTextTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'session_send_text');
    const readTerminalTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'session_read_terminal');
    const setAiagentStateTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'session_set_aiagent_state');
    const attachmentAddTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'plan_attachment_add');
    const attachmentGetTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'plan_attachment_get');
    const telegramStatusTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'telegram_status');
    const telegramChatTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'telegram_chat');
    const schedulerCreateTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'scheduler_create');
    const schedulerDeleteTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'scheduler_delete');
    const notifyUserTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'notify_user');
    const appVisibilityTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'get_app_visibility');
    const restartHelmTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'restart_helm');
    const skillsUpdateTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'skill_update');
    const skillsDeleteTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'skill_delete');
    const contextBindTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'context_bind');
    const contextUnbindTool = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'context_unbind');
    expect(planCreateTool.description).toContain('Problem Statement');
    expect(planCreateTool.description).toContain('Acceptance Criteria');
    expect(planCreateTool.description).toContain('QUESTION:');
    expect(planCreateTool.description).toContain('plan_nextplan_link');
    expect(planCreateTool.description).toContain('session_plan_claim');
    expect(planCompleteTool.description).toContain('P-00xx');
    expect(planCompleteTool.description).toContain('implemented behavior');
    expect(planCompleteTool.description).toContain('tests or review');
    expect(planNextLinkTool.description).toContain('blocking questions');
    expect(planSetStateTool.description).toContain('planning');
    expect(planSetStateTool.description).toContain('ready');
    expect(planSetStateTool.description).not.toContain('session_set_working_plan');
    expect(sendTextTool.description).toContain('always submitted atomically');
    expect(sendTextTool.description).toContain('session_read_terminal');
    expect(readTerminalTool.description).toContain('terminal tail');
    expect(readTerminalTool.description).toContain('verify the recipient received');
    expect(readTerminalTool.description).toContain('raw ANSI');
    expect(readTerminalTool.inputSchema.properties.stripBlankLines).toEqual({
      type: 'boolean',
      description: 'When true, omit empty and whitespace-only rows from the returned tail.',
    });
    expect(setAiagentStateTool.description).toContain('Valid states');
    expect(setAiagentStateTool.description).toContain('planning');
    expect(setAiagentStateTool.description).toContain('Helm does not scrape terminal output');
    expect(setAiagentStateTool.inputSchema.properties.state.enum).toEqual(['planning', 'implementing', 'completed', 'idle']);
    expect(setAiagentStateTool.inputSchema.properties.sessionId.description).toContain('UUID');
    expect(attachmentAddTool.description).toContain('file path');
    expect(attachmentAddTool.description).toContain('Helm config');
    expect(attachmentGetTool.description).toContain('temp file');
    expect(attachmentGetTool.description).toContain('inline');
    expect(telegramStatusTool.description).toContain('No bot token');
    expect(telegramChatTool!.description).toContain('mobile-friendly');
    expect(schedulerCreateTool!.description).toContain('scheduled task');
    expect(schedulerDeleteTool!.description).toContain('Delete');
    expect(notifyUserTool!.description).toContain('smart delivery routing');
    expect(notifyUserTool!.description).toContain('completion');
    expect(notifyUserTool!.description).toContain('blocked');
    expect(notifyUserTool!.description).toContain('error');
    expect(appVisibilityTool!.description).toContain('screen-lock');
    expect(restartHelmTool!.description).toContain('restart');
    expect(restartHelmTool!.description).toContain('resumePrompt');
    expect(restartHelmTool!.inputSchema.required).toEqual(['resumePrompt']);
    expect(skillsUpdateTool!.inputSchema.properties.aiAmendable).toEqual({ type: 'boolean' });
    expect(skillsUpdateTool!.inputSchema.properties.projectIds).toEqual({ type: 'array', items: { type: 'string' } });
    expect(skillsDeleteTool!.description).toContain('Delete');
    expect(skillsDeleteTool!.inputSchema.required).toEqual(['id']);
    expect(contextBindTool!.description).toContain('plan or sequence');
    expect(contextUnbindTool!.description).toContain('without deleting');
  });

  it('dispatches tool calls into the shared service', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'session_send_text',
        arguments: { sessionId: 's1', text: 'hello', senderSessionId: 's1' },
      },
    }, {
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'session_send_text',
    });
    const json = await response.json();
    expect((service.sendTextToSession as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('s1', 'hello', { senderSessionId: 's1', senderSessionName: 'Claude' });
    expect(json.result.structuredContent).toEqual({ success: true, sessionId: 's1', name: 'Claude' });

    const restartResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'restart_helm',
        arguments: { resumePrompt: 'Continue after restart.' },
      },
    }, {
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'restart_helm',
      'X-Helm-Session-Id': 'sender-1',
    });
    const restartJson = await restartResponse.json();
    // No resume arg → defaults to resume:true (sessions preserved for auto-resume).
    expect((service.restartHelm as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(true, {
      callerSessionId: 'sender-1',
      resumePrompt: 'Continue after restart.',
    });
    expect(restartJson.result.structuredContent).toEqual({ sessionsClosed: 0, resume: true });

    const forceResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'restart_helm',
        arguments: { resume: false, resumePrompt: 'Continue after restart.' },
      },
    }, {
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'restart_helm',
      'X-Helm-Session-Id': 'sender-1',
    });
    const forceJson = await forceResponse.json();
    expect((service.restartHelm as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(false, {
      callerSessionId: 'sender-1',
      resumePrompt: 'Continue after restart.',
    });
    expect(forceJson.result.structuredContent).toEqual({ sessionsClosed: 2, resume: false });
  });

  it('rejects restart_helm without a resumePrompt — a restart must not strand the caller', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'restart_helm',
        arguments: {},
      },
    });
    const json = await response.json();
    expect(json.error.message).toContain('resumePrompt is required');
    expect((service.restartHelm as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('dispatches skills tools through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const listResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: { name: 'skill_list', arguments: {} },
    });
    const listJson = await listResponse.json();
    expect(listJson.result.structuredContent.items[0].name).toBe('Review');
    expect(listJson.result.structuredContent.items[0].triggerCondition).toBe('Use for reviews');
    expect(listJson.result.structuredContent.items[0]).not.toHaveProperty('description');
    expect(listJson.result.structuredContent.items[0]).not.toHaveProperty('allProjects');
    expect(listJson.result.structuredContent.items[0]).not.toHaveProperty('projectIds');
    expect(listJson.result.structuredContent.items[0]).not.toHaveProperty('aiAmendable');
    expect(listJson.result.structuredContent.items[0]).not.toHaveProperty('useCount');
    expect(listJson.result.structuredContent.items[0]).not.toHaveProperty('avgRating');
    expect(listJson.result.structuredContent.items[0]).not.toHaveProperty('reviewCount');
    expect(service.listSkills).toHaveBeenCalledWith({}, expect.objectContaining({}));

    const filteredListResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 310,
      method: 'tools/call',
      params: { name: 'skill_list', arguments: { projectId: 'project-1' } },
    });
    await filteredListResponse.json();
    expect(service.listSkills).toHaveBeenCalledWith({ projectId: 'project-1' }, expect.objectContaining({}));

    const getResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: { name: 'skill_get', arguments: { id: 'skill-1' } },
    });
    const getJson = await getResponse.json();
    expect(getJson.result.structuredContent.body).toBe('Check the diff');

    const feedbackResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 321,
      method: 'tools/call',
      params: { name: 'skill_submit_feedback', arguments: { skillId: 'skill-1', stars: 5, summary: 'Useful' } },
    }, { 'x-helm-session-id': 's1' });
    const feedbackJson = await feedbackResponse.json();
    expect(feedbackJson.result.structuredContent).toEqual({ received: true });
    expect(feedbackJson.result.content[0].text).toBe('{\n  "received": true\n}');
    expect(service.submitSkillFeedback).toHaveBeenCalledWith('skill-1', 5, 'Useful', undefined, expect.objectContaining({ sessionId: 's1' }));

    const createResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: { name: 'skill_create', arguments: { name: 'Commit', aiAmendable: true, allProjects: false, projectIds: ['project-1'] } },
    });
    const createJson = await createResponse.json();
    expect(createJson.result.structuredContent).toMatchObject({ name: 'Commit', aiAmendable: true, allProjects: false, projectIds: ['project-1'] });

    const updateResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: { name: 'skill_update', arguments: { id: 'skill-1', body: 'Updated', aiAmendable: true, allProjects: false, projectIds: ['project-1'] } },
    });
    const updateJson = await updateResponse.json();
    expect(updateJson.result.structuredContent.body).toBe('Updated');
    expect(service.updateSkill).toHaveBeenCalledWith('skill-1', { body: 'Updated', aiAmendable: true, allProjects: false, projectIds: ['project-1'] });
  });

  it('reads and clears skill reviews through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const toolsResponse = await rpc(port, 'secret-token', { jsonrpc: '2.0', id: 40, method: 'tools/list', params: {} });
    const toolNames = (await toolsResponse.json()).result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain('skill_get_feedback');
    expect(toolNames).toContain('skill_clear_reviews');

    const statsResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'skill_get_feedback', arguments: { skillId: 'skill-1' } },
    });
    const stats = (await statsResponse.json()).result.structuredContent;
    expect(service.getSkillStats).toHaveBeenCalledWith('skill-1');
    expect(stats).toMatchObject({ useCount: 7, avgRating: 2.5, reviewCount: 2 });
    expect(stats.reviews[0]).toMatchObject({ stars: 1, summary: 'Did nothing useful', improvement: 'Drop step 3', cliName: 'codex-a' });

    const clearResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'skill_clear_reviews', arguments: { skillId: 'skill-1' } },
    });
    const cleared = (await clearResponse.json()).result.structuredContent;
    expect(service.clearSkillReviews).toHaveBeenCalledWith('skill-1');
    // Clearing wipes opinions but keeps the usage signal.
    expect(cleared).toEqual({ useCount: 7, avgRating: 0, reviewCount: 0, reviews: [] });
  });

  it('supports type-based skill lookup via skill_get', async () => {
    const server = new LocalhostMcpServer(makeService(), { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'skill_get',
        arguments: { type: 'session-guide' },
      },
    });
    const json = await response.json();
    expect(json.result.content[0].text).toContain('resolved-1');
    expect(json.result.content[0].text).toContain('session-guide');
  });

  it('supports skill_delete', async () => {
    const server = new LocalhostMcpServer(makeService(), { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'skill_delete',
        arguments: { id: 'skill-1' },
      },
    });
    const json = await response.json();
    expect(json.result.content[0].text).toContain('"deleted": true');
  });

  it('skill_get with type returns error when not found', async () => {
    const svc = makeService();
    (svc.resolveSkill as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const server = new LocalhostMcpServer(svc, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'skill_get',
        arguments: { type: 'nonexistent' },
      },
    });
    const json = await response.json();
    expect(json.error.message).toContain('not found');
  });

  it('skill_get rejects ambiguous id and type lookup', async () => {
    const server = new LocalhostMcpServer(makeService(), { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'skill_get',
        arguments: { id: 'skill-1', type: 'session-guide' },
      },
    });
    const json = await response.json();
    expect(json.error.message).toContain('either id or type');
  });

  it('dispatches context tools through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const listResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: {
        name: 'context_list',
        arguments: { projectId: 'proj-1' },
      },
    });
    const listJson = await listResponse.json();
    expect((service.listContexts as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('proj-1');
    expect(listJson.result.structuredContent.items[0].id).toBe('ctx-1');

    const createResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: {
        name: 'context_create',
        arguments: { projectId: 'proj-1', title: 'Testing Strategy', permission: 'readonly' },
      },
    });
    const createJson = await createResponse.json();
    expect((service.createContext as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      projectId: 'proj-1',
      title: 'Testing Strategy',
      permission: 'readonly',
    });
    expect(createJson.result.structuredContent.title).toBe('Testing Strategy');

    const bindResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 38,
      method: 'tools/call',
      params: {
        name: 'context_bind',
        arguments: { id: 'ctx-1', targetType: 'sequence', targetId: 'seq-1' },
      },
    });
    const bindJson = await bindResponse.json();
    expect((service.bindContext as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('ctx-1', 'sequence', 'seq-1');
    expect(bindJson.result.structuredContent.bound).toBe(true);

    const unbindResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 39,
      method: 'tools/call',
      params: {
        name: 'context_unbind',
        arguments: { id: 'ctx-1', targetType: 'sequence', targetId: 'seq-1' },
      },
    });
    const unbindJson = await unbindResponse.json();
    expect((service.unbindContext as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('ctx-1', 'sequence', 'seq-1');
    expect(unbindJson.result.structuredContent.unbound).toBe(true);
  });

  it('dispatches effective plan context listing through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 36,
      method: 'tools/call',
      params: {
        name: 'plan_context_list',
        arguments: { planId: 'P-0001' },
      },
    });
    const json = await response.json();
    expect((service.listPlanContexts as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('P-0001');
    expect(json.result.structuredContent.items).toEqual([{ id: 'ctx-1', type: 'Testing', source: 'both' }]);
  });

  it('plan_get includes lightweight context metadata in its structured response', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 37,
      method: 'tools/call',
      params: {
        name: 'plan_get',
        arguments: { uuid: 'P-0001' },
      },
    });
    const json = await response.json();

    expect((service.getPlan as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('P-0001');
    expect(json.result.structuredContent.sequenceId).toBe('seq-1');
    expect(json.result.structuredContent.sequenceContextMetadata).toEqual([
      { id: 'ctx-1', title: 'Testing Strategy', type: 'Testing', permission: 'readonly' },
    ]);
  });

  it('plan_get_id converts humanId to uuid format', async () => {
    const service = makeService();
    (service.getPlanIdMapping as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      uuid: 'p1',
      humanId: 'P-0001',
    });
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'plan_get_id',
        arguments: { humanId: 'P-0001' },
      },
    });
    const json = await response.json();

    expect((service.getPlanIdMapping as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('P-0001');
    expect(json.result.structuredContent).toEqual({
      uuid: 'p1',
      humanId: 'P-0001',
    });
  });

  it('dispatches session_plan_claim through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 36,
      method: 'tools/call',
      params: {
        name: 'session_plan_claim',
        arguments: { sessionId: 's1', planId: 'plan-1' },
      },
    });
    const json = await response.json();
    expect((service.claimSessionPlan as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('s1', 'plan-1');
    expect(json.result.structuredContent).toEqual({
      sessionId: 's1',
      name: 'Claude',
      planId: 'plan-1',
      planTitle: 'Task',
      planStatus: 'coding',
    });
  });

  it('dispatches session_read_terminal through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'session_read_terminal',
        arguments: { name: 'Claude', lines: 120, mode: 'both', stripBlankLines: true },
      },
    });
    const json = await response.json();

    expect((service.readSessionTerminal as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('Claude', 120, 'both', true);
    expect(json.result.structuredContent).toMatchObject({
      sessionId: 'Claude',
      requestedLines: 120,
      raw: ['\x1b[32mhello\x1b[0m'],
      stripped: ['hello'],
    });
  });

  it('adds ownership reminders to plan_create and plan_set_state text without changing structured content', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const createResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 37,
      method: 'tools/call',
      params: {
        name: 'plan_create',
        arguments: { dirPath: '/proj', title: 'Task', description: 'Desc' },
      },
    });
    const createJson = await createResponse.json();
    expect(createJson.result.structuredContent).toEqual({
      id: 'created',
      dirPath: '/proj',
      title: 'Task',
      description: 'Desc',
      status: 'ready',
    });
    expect(createJson.result.content[0].text).toContain('Reminder: creating a plan does not assign ownership');
    expect(createJson.result.content[0].text).toContain('Problem Statement');
    expect(createJson.result.content[0].text).toContain('QUESTION:');
    expect(createJson.result.content[0].text).toContain('plan_nextplan_link');
    expect(createJson.result.content[0].text).toContain('session_plan_claim');

    const setStateResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 38,
      method: 'tools/call',
      params: {
        name: 'plan_set_state',
        arguments: { uuid: 'p1', status: 'coding', sessionId: 's1' },
      },
    });
    const setStateJson = await setStateResponse.json();
    expect(setStateJson.result.structuredContent).toEqual({
      id: 'p1',
      dirPath: '/proj',
      title: 'Task',
      description: 'Desc',
      status: 'coding',
    });
    expect(setStateJson.result.content[0].text).toContain('Reminder: to claim work');
    expect(setStateJson.result.content[0].text).toContain('session_plan_claim');
  });

  it('sets plan type through plan_create and plan_update MCP calls', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const createResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 39,
      method: 'tools/call',
      params: {
        name: 'plan_create',
        arguments: { dirPath: '/proj', title: 'Task', description: 'Desc', type: 'bug' },
      },
    });
    const createJson = await createResponse.json();
    expect((service.createPlan as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('/proj', 'Task', 'Desc', 'bug', undefined);
    expect(createJson.result.structuredContent.type).toBe('bug');

    const updateResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: {
        name: 'plan_update',
        arguments: { uuid: 'p1', type: 'research' },
      },
    });
    const updateJson = await updateResponse.json();
    expect((service.updatePlan as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('p1', { type: 'research' });
    expect(updateJson.result.structuredContent.type).toBe('research');
  });

  it('advertises and sets autoImplement through plan_update MCP calls', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const toolsResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 401,
      method: 'tools/list',
    });
    const toolsJson = await toolsResponse.json();
    const planUpdate = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'plan_update');
    expect(planUpdate.description).toContain('auto-implement');
    expect(planUpdate.description).toContain('autoImplement true or false');

    const updateResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 402,
      method: 'tools/call',
      params: {
        name: 'plan_update',
        arguments: { uuid: 'p1', autoImplement: true },
      },
    });
    const updateJson = await updateResponse.json();
    expect((service.updatePlan as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('p1', { autoImplement: true });
    expect(updateJson.result.structuredContent.autoImplement).toBe(true);
  });

  it('advertises and sets completionRecap through plan_update MCP calls', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const toolsResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 403,
      method: 'tools/list',
    });
    const toolsJson = await toolsResponse.json();
    const planUpdate = toolsJson.result.tools.find((tool: { name: string }) => tool.name === 'plan_update');
    expect(planUpdate.description).toContain('completion recap');
    expect(planUpdate.description).toContain('completionRecap true or false');
    expect(planUpdate.inputSchema.properties.completionRecap).toEqual({ type: 'boolean' });

    const updateResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 404,
      method: 'tools/call',
      params: {
        name: 'plan_update',
        arguments: { uuid: 'p1', completionRecap: true },
      },
    });
    const updateJson = await updateResponse.json();
    expect((service.updatePlan as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('p1', { completionRecap: true });
    expect(updateJson.result.structuredContent.completionRecap).toBe(true);
  });

  it('dispatches plan attachment tools through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const addResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 60,
      method: 'tools/call',
      params: {
        name: 'plan_attachment_add',
        arguments: { planId: 'P-0001', filePath: '/tmp/note.txt', contentType: 'text/plain' },
      },
    });
    const addJson = await addResponse.json();
    expect((service.addPlanAttachment as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('P-0001', {
      filePath: '/tmp/note.txt',
      contentType: 'text/plain',
    });
    expect(addJson.result.structuredContent).toMatchObject({ id: 'a1', planId: 'P-0001', filename: 'note.txt' });

    const listResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 61,
      method: 'tools/call',
      params: {
        name: 'plan_attachment_list',
        arguments: { planId: 'P-0001' },
      },
    });
    const listJson = await listResponse.json();
    expect((service.listPlanAttachments as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('P-0001');
    expect(listJson.result.structuredContent.items[0].id).toBe('a1');

    const getResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 62,
      method: 'tools/call',
      params: {
        name: 'plan_attachment_get',
        arguments: { planId: 'P-0001', attachmentId: 'a1' },
      },
    });
    const getJson = await getResponse.json();
    expect((service.getPlanAttachment as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('P-0001', 'a1');
    expect(getJson.result.structuredContent.tempPath).toContain('helm-attachment');

    const deleteResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 63,
      method: 'tools/call',
      params: {
        name: 'plan_attachment_delete',
        arguments: { planId: 'P-0001', attachmentId: 'a1' },
      },
    });
    const deleteJson = await deleteResponse.json();
    expect((service.deletePlanAttachment as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('P-0001', 'a1');
    expect(deleteJson.result.structuredContent).toEqual({ deleted: true });
  });

  it('dispatches telegram tools through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const statusResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 70,
      method: 'tools/call',
      params: { name: 'telegram_status', arguments: {} },
    });
    const statusJson = await statusResponse.json();
    expect((service.getTelegramStatus as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(statusJson.result.structuredContent.available).toBe(true);
    expect(JSON.stringify(statusJson.result.structuredContent)).not.toContain('botToken');

    const chatResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 71,
      method: 'tools/call',
      params: { name: 'telegram_chat', arguments: { sessionId: 's1', message: 'Need a quick decision?' } },
    });
    const chatJson = await chatResponse.json();
    expect((service.sendTelegramChat as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('s1', 'Need a quick decision?', undefined);
    expect(chatJson.result.structuredContent.sent).toBe(true);

    // Create a temporary file for the filePath test
    const tempDir = mkdtempSync(join(tmpdir(), 'test-'));
    const tempFile = join(tempDir, 'log.txt');
    writeFileSync(tempFile, 'hello');

    const filePath = tempFile;
    await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 711,
      method: 'tools/call',
      params: { name: 'telegram_chat', arguments: { sessionId: 's1', message: 'See log', filePath } },
    });
    expect((service.sendTelegramChat as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('s1', 'See log', filePath);
    rmSync(tempDir, { recursive: true, force: true });

    const closeResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 72,
      method: 'tools/call',
      params: { name: 'telegram_channel_close', arguments: { channelId: 'tc1' } },
    });
    const closeJson = await closeResponse.json();
    expect((service.closeTelegramChannel as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('tc1');
    expect(closeJson.result.structuredContent.status).toBe('closed');
  });

  it('dispatches LLM notification tools through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const notifyResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 73,
      method: 'tools/call',
      params: { name: 'notify_user', arguments: { sessionId: 's1', title: 'Need input', content: 'Choose one' } },
    });
    const notifyJson = await notifyResponse.json();
    expect((service.notifyUser as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('s1', 'Need input', 'Choose one');
    expect(notifyJson.result.structuredContent.delivered).toBe('bubble');

    const visibilityResponse = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 74,
      method: 'tools/call',
      params: { name: 'get_app_visibility', arguments: {} },
    });
    const visibilityJson = await visibilityResponse.json();
    expect((service.getAppVisibility as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(visibilityJson.result.structuredContent).toMatchObject({ visibility: 'visible-focused', activeSessionId: 's1' });
  });

  it('dispatches scheduler tools through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 81,
      method: 'tools/call',
      params: {
        name: 'scheduler_create',
        arguments: {
          title: 'Follow up',
          initialPrompt: 'check status',
          cliType: 'claude-code',
          dirPath: 'X:\\coding\\gamepad-cli-hub',
          scheduledTime: '2026-05-04T10:00:00Z',
        },
      },
    });
    expect((service.createScheduledTask as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Follow up',
      scheduledTime: '2026-05-04T10:00:00Z',
    }));

    await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 811,
      method: 'tools/call',
      params: {
        name: 'scheduler_create',
        arguments: {
          title: 'Weekday report',
          initialPrompt: 'report',
          cliType: 'claude-code',
          dirPath: 'X:\\coding\\gamepad-cli-hub',
          scheduledTime: '2026-05-04T08:00:00Z',
          scheduleKind: 'cron',
          cronExpression: '0 9 * * 1-5',
          endDate: '2026-12-31T23:59:59Z',
        },
      },
    });
    expect((service.createScheduledTask as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
      scheduleKind: 'cron',
      cronExpression: '0 9 * * 1-5',
      endDate: '2026-12-31T23:59:59Z',
    }));

    await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 82,
      method: 'tools/call',
      params: { name: 'scheduler_list', arguments: {} },
    });
    expect((service.listScheduledTasks as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();

    await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 83,
      method: 'tools/call',
      params: { name: 'scheduler_update', arguments: { id: 'task-1', title: 'Updated' } },
    });
    expect((service.updateScheduledTask as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('task-1', { title: 'Updated' });

    await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 84,
      method: 'tools/call',
      params: { name: 'scheduler_delete', arguments: { id: 'task-1' } },
    });
    expect((service.deleteScheduledTask as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('task-1');
  });

  it('clears plan type through plan_update when type is null', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'plan_update',
        arguments: { uuid: 'p1', type: null },
      },
    });

    expect((service.updatePlan as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('p1', { type: null });
  });

  it('wraps array results in a record for structuredContent', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'plan_list',
        arguments: { dirPath: 'X:\\coding\\gamepad-cli-hub' },
      },
    });
    const json = await response.json();
    expect(json.result.structuredContent).toEqual({
      items: [{ id: 'p1', dirPath: 'X:\\coding\\gamepad-cli-hub', title: 'Task', description: 'Desc', status: 'ready' }],
    });
  });

  it('plan_summary dispatches to plansSummary and wraps array result', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'plan_summary',
        arguments: { dirPath: 'X:\\coding\\gamepad-cli-hub' },
      },
    });
    const json = await response.json();
    expect(service.plansSummary).toHaveBeenCalledWith('X:\\coding\\gamepad-cli-hub', 'active');
    expect(json.result.structuredContent).toEqual({
      items: [{ id: 'p1', humanId: 'P-0001', title: 'Task', status: 'ready', blockedBy: [], blocks: [] }],
    });
  });

  it('lists configured cli types through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: {
        name: 'tool_list',
        arguments: {},
      },
    });
    const json = await response.json();
    expect(json.result.structuredContent).toEqual({
      items: [{ cliType: 'codex', name: 'codex', command: 'codex', supportsResume: false, supportedDirPaths: ['X:\\coding\\gamepad-cli-hub'] }],
    });
  });

  it('spawns a cli session through the MCP surface', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: {
        name: 'session_create',
        arguments: { cliType: 'codex', dirPath: 'X:\\coding\\gamepad-cli-hub', name: 'Builder' },
      },
    });
    const json = await response.json();
    expect((service.spawnCli as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('codex', 'X:\\coding\\gamepad-cli-hub', 'Builder', {});
    expect(json.result.structuredContent).toEqual({ id: 's2', name: 'Builder', cliType: 'codex', workingDir: 'X:\\coding\\gamepad-cli-hub' });
  });

  it('passes an optional dirPath filter into session_list', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: {
        name: 'session_list',
        arguments: { dirPath: 'X:\\coding\\gamepad-cli-hub' },
      },
    });

    expect((service.listSessions as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('X:\\coding\\gamepad-cli-hub', undefined);
  });

  it('passes an optional projectId filter into session_list', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: {
        name: 'session_list',
        arguments: { projectId: 'proj-123' },
      },
    });

    expect((service.listSessions as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(undefined, 'proj-123');
  });

  it('calls listDirectories for directory_list', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: {
        name: 'directory_list',
        arguments: {},
      },
    });

    expect((service.listDirectories as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    const json = await response.json();
    expect(json.result.structuredContent.items).toEqual([{ dirPath: 'X:\\coding\\gamepad-cli-hub', name: 'Helm', source: ['config', 'plans'], planCount: 8, sessionCount: 0 }]);
  });

  it('returns explicit errors instead of null structured content for invalid plan transitions', async () => {
    const service = makeService();
    (service.getPlan as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'p1', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'ready' });
    (service.setPlanState as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('Plan p1 could not be set to blocked'); });

    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'plan_set_state',
        arguments: { uuid: 'p1', status: 'blocked', stateInfo: 'waiting' },
      },
    });
    const json = await response.json();
    expect(json.error.message).toContain('could not be set to blocked');
  });

  it('sets plan to coding without sessionId (P-0342: plans are shared)', async () => {
    const service = makeService();
    const plan = { id: 'p1', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'ready' };
    (service.getPlan as unknown as ReturnType<typeof vi.fn>).mockReturnValue(plan);
    (service.setPlanState as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ ...plan, status: 'coding' });

    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'plan_set_state',
        arguments: { uuid: 'p1', status: 'coding' },
      },
    });
    const json = await response.json();
    expect(json.error).toBeUndefined();
    expect(service.setPlanState).toHaveBeenCalled();
  });

  it('returns explicit not-found errors for session_get', async () => {
    const service = makeService();
    (service.getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'session_get',
        arguments: { sessionId: 'missing-session' },
      },
    });
    const json = await response.json();
    expect(json.error.message).toBe('Session not found: missing-session');
  });

  it('passes sender info into sendTextToSession', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 38,
      method: 'tools/call',
      params: {
        name: 'session_send_text',
        arguments: { sessionId: 's1', text: 'hello', senderSessionId: 's1' },
      },
    });
    const json = await response.json();
    expect((service.sendTextToSession as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('s1', 'hello', { senderSessionId: 's1', senderSessionName: 'Claude' });
    expect(json.result.structuredContent).toEqual({ success: true, sessionId: 's1', name: 'Claude' });
  });

  it('infers sender info from a trusted session token when explicit sender fields are omitted', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;
    const sessionToken = mintSessionAuthToken('secret-token', 'sender-1', 'Codex Session');

    const response = await rpc(port, sessionToken, {
      jsonrpc: '2.0',
      id: 38.5,
      method: 'tools/call',
      params: {
        name: 'session_send_text',
        arguments: { sessionId: 's1', text: 'hello', expectsResponse: true },
      },
    });
    const json = await response.json();
    expect((service.sendTextToSession as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('s1', 'hello', {
      senderSessionId: 'sender-1',
      senderSessionName: 'Codex Session',
      expectsResponse: true,
    });
    expect(json.result.structuredContent).toEqual({ success: true, sessionId: 's1', name: 'Claude' });
  });

  it('infers sender info from session headers with the shared bearer token', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 38.6,
      method: 'tools/call',
      params: {
        name: 'session_send_text',
        arguments: { sessionId: 's1', text: 'hello', expectsResponse: true },
      },
    }, {
      'X-Helm-Session-Id': 'sender-1',
      'X-Helm-Session-Name': 'Header Session',
    });
    const json = await response.json();
    expect((service.sendTextToSession as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('s1', 'hello', {
      senderSessionId: 'sender-1',
      senderSessionName: 'Claude',
      expectsResponse: true,
    });
    expect(json.result.structuredContent).toEqual({ success: true, sessionId: 's1', name: 'Claude' });
  });

  it('passes expectsResponse into sendTextToSession', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 39,
      method: 'tools/call',
      params: {
        name: 'session_send_text',
        arguments: { sessionId: 's1', text: 'hello', senderSessionId: 's1', expectsResponse: true },
      },
    });
    const json = await response.json();
    expect((service.sendTextToSession as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('s1', 'hello', { senderSessionId: 's1', senderSessionName: 'Claude', expectsResponse: true });
    expect(json.result.structuredContent).toEqual({ success: true, sessionId: 's1', name: 'Claude' });
  });

  it('rejects session_send_text when sender info is missing', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: {
        name: 'session_send_text',
        arguments: { sessionId: 's1', text: 'hello' },
      },
    });
    const json = await response.json();
    expect(json.error.message).toContain('senderSessionId is required');
  });

  it('rejects session_send_text when senderSessionId does not match a known session', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 40.1,
      method: 'tools/call',
      params: {
        name: 'session_send_text',
        arguments: { sessionId: 's1', text: 'hello', senderSessionId: 'unknown-id' },
      },
    });
    const json = await response.json();
    expect(json.error.message).toContain('Unknown sender session');
    expect(json.error.message).toContain('HELM_SESSION_ID');
  });

  it('rejects session_send_text when neither sessionId nor name is provided', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'session_send_text',
        arguments: { text: 'hello', senderSessionId: 's1' },
      },
    });
    const json = await response.json();
    expect(json.error.message).toContain('sessionId is required');
  });

  it('rejects session_send_text when text is missing', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'session_send_text',
        arguments: { sessionId: 's1', senderSessionId: 's1' },
      },
    });
    const json = await response.json();
    expect(json.error.message).toContain('text is required');
  });

  it('returns 405 for GET requests', async () => {
    const server = new LocalhostMcpServer(makeService(), { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET' });
    expect(response.status).toBe(405);
  });

  it('session_info keeps AIAGENT state compact and leaves detailed usage on the state tool', () => {
    const service = new HelmControlService(
      {} as any,
      {
        getSession: vi.fn(() => ({
          id: 'sess-123',
          name: 'Claude-Main',
          cliType: 'claude-code',
          processId: 42,
          workingDir: 'X:\\coding\\gamepad-cli-hub',
        })),
      } as any,
      {} as any,
      {
        getMcpConfig: vi.fn(() => ({ port: 47373, authToken: 'secret-token-value' })),
        getWorkingDirectories: vi.fn(() => [{ path: 'X:\\coding\\gamepad-cli-hub', name: 'Helm' }]),
        getTelegramConfig: vi.fn(() => ({ enabled: false })),
      } as any,
      {} as any,
    );

    const content = service.getSessionInfo({ sessionId: 'sess-123', sessionName: 'Claude-Main' });

    expect(content).not.toHaveProperty('aiagent_states');
    expect(content).not.toHaveProperty('system_skill_types');
    expect(content).not.toHaveProperty('aiagent_state_guide');
    expect(content).not.toHaveProperty('agent_plan_guide');
    expect(content).not.toHaveProperty('notification_guide');
  });

  it('session_info returns tiny identity response with helm_workflow pointer', async () => {
    const service = makeService();
    (service as any).getSessionInfo = vi.fn(() => ({
      your_session_id: 'sess-123',
      your_working_dir: 'X:\\coding\\gamepad-cli-hub',
      helm_workflow: 'call skill_get(type:"startup") for mandatory rules',
    }));
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: { name: 'session_info', arguments: {} },
    });

    const json = await response.json();
    const content = json.result.structuredContent;
    expect(Object.keys(content).sort()).toEqual(['helm_workflow', 'your_session_id', 'your_working_dir']);
    expect(content.helm_workflow).toContain('startup');
    expect(content).not.toHaveProperty('mandatory_rules');
    expect(content).not.toHaveProperty('mcp_url');
    expect(content).not.toHaveProperty('available_projects');
  });

  it('session_info tool is included in tools/list response', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/list',
      params: {},
    });

    const json = await response.json();
    const sessionInfoTool = json.result.tools.find((t: { name: string }) => t.name === 'session_info');
    expect(sessionInfoTool).toBeDefined();
    expect(sessionInfoTool.title).toBe('Get Session Info');
    expect(sessionInfoTool.description).toContain('session_set_aiagent_state');
    expect(sessionInfoTool.description).toContain('startup');
    expect(sessionInfoTool.inputSchema.properties).toEqual({});
  });

  it('session_info response reminds agents to set AIAGENT state', async () => {
    const service = makeService();
    (service as any).getSessionInfo = vi.fn(() => ({
      your_session_id: 'test-session',
      your_working_dir: '/home/user/project',
      helm_workflow: 'call skill_get(type:"startup") for mandatory rules',
    }));
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: { name: 'session_info', arguments: {} },
    });

    const json = await response.json();
    expect(json.result.content[0].text).toContain('Reminder: now call session_set_aiagent_state');
    expect(json.result.structuredContent.helm_workflow).toContain('startup');
  });

  it('session_read_terminal response reminds agents to verify handoff receipt', async () => {
    const service = makeService();
    const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
    servers.push(server);
    await server.start();
    const port = server.getAddress()!.port;

    const response = await rpc(port, 'secret-token', {
      jsonrpc: '2.0',
      id: 103,
      method: 'tools/call',
      params: {
        name: 'session_read_terminal',
        arguments: { sessionId: 's1', lines: 20, mode: 'stripped' },
      },
    });

    const json = await response.json();
    expect(json.result.content[0].text).toContain('inspect this terminal tail for receipt evidence');
    expect(json.result.content[0].text).toContain('report that uncertainty');
  });

  describe('plan_complete with documentation', () => {
    it('accepts valid documentation and passes it through', async () => {
      const service = makeService();
      (service.getPlan as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'p1', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'coding' });
      (service.completePlan as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'p1', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'done', completionNotes: 'All tests pass and feature works' });
      (service.exportDirectory as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        dirPath: '/proj',
        items: [
          { id: 'p1', humanId: 'P-0001', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'done' },
          { id: 'p2', humanId: 'P-0002', dirPath: '/proj', title: 'Follow up', description: 'More', status: 'ready', autoImplement: true },
          { id: 'p3', humanId: 'P-0003', dirPath: '/proj', title: 'Manual QA', description: 'Check', status: 'planning' },
        ],
        dependencies: [
          { fromId: 'p1', toId: 'p2' },
          { fromId: 'p1', toId: 'p3' },
        ],
      });

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: {
          name: 'plan_complete',
          arguments: { uuid: 'p1', documentation: 'All tests pass and feature works' },
        },
      });
      const json = await response.json();
      expect((service.completePlan as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('p1', 'All tests pass and feature works');
      expect(json.result.structuredContent.followUpPlans).toEqual([
        { id: 'p2', humanId: 'P-0002', title: 'Follow up', status: 'ready', autoImplement: true },
        { id: 'p3', humanId: 'P-0003', title: 'Manual QA', status: 'planning', autoImplement: false },
      ]);
      expect(json.result.structuredContent.autoFollowUpPlans).toBeUndefined();
      expect(json.result.structuredContent.testingInstructions).toBeUndefined();
    });

    it('rejects missing documentation param', async () => {
      const service = makeService();
      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: 'plan_complete',
          arguments: { uuid: 'p1' },
        },
      });
      const json = await response.json();
      expect(json.error.message).toContain('documentation is required');
    });

    it('rejects documentation shorter than 10 characters', async () => {
      const service = makeService();
      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: {
          name: 'plan_complete',
          arguments: { uuid: 'p1', documentation: 'short' },
        },
      });
      const json = await response.json();
      expect(json.error.message).toContain('at least 10 characters');
    });

    it('emits an in-app notification to the calling session on completion', async () => {
      const service = makeService();
      (service.getPlan as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'p1', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'coding' });
      (service.completePlan as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'p1', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'done', completionNotes: 'All tests pass' });
      (service.exportDirectory as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        dirPath: '/proj',
        items: [{ id: 'p1', humanId: 'P-0001', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'done' }],
        dependencies: [],
      });
      (service.getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 's1', name: 'Claude' });

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'plan_complete',
          arguments: { uuid: 'p1', documentation: 'All tests pass and feature works' },
        },
      }, { 'x-helm-session-id': 's1' });

      expect((service.notifyUser as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        's1',
        'Plan completed — Task',
        'All tests pass and feature works',
      );
    });

    it('does not throw when notifyUser fails during plan completion', async () => {
      const service = makeService();
      (service.getPlan as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'p1', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'coding' });
      (service.completePlan as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'p1', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'done', completionNotes: 'All tests pass', sessionId: 's1' });
      (service.exportDirectory as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        dirPath: '/proj',
        items: [{ id: 'p1', humanId: 'P-0001', dirPath: '/proj', title: 'Task', description: 'Desc', status: 'done' }],
        dependencies: [],
      });
      (service.notifyUser as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('notification mode is not llm');
      });

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 54,
        method: 'tools/call',
        params: {
          name: 'plan_complete',
          arguments: { uuid: 'p1', documentation: 'All tests pass and feature works' },
        },
      });
      const json = await response.json();
      expect(json.error).toBeUndefined();
    });
  });

  describe('session_send_text MCP response — helmPreambleForInterSession', () => {
    it('session_send_text MCP response when preambleUsed=true', async () => {
      const service = makeService();
      // Update mock to return two sessions
      (service.listSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 's1', name: 'Claude', cliType: 'claude-code' },
        { id: 's2', name: 'Worker', cliType: 'claude-code' },
      ]);

      const sendTextMock = (service.sendTextToSession as unknown as ReturnType<typeof vi.fn>);
      sendTextMock.mockImplementationOnce(async () => ({
        success: true,
        sessionId: 's1',
        name: 'Claude',
        preambleUsed: true,
      }));

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 80,
        method: 'tools/call',
        params: {
          name: 'session_send_text',
          arguments: { sessionId: 's1', text: 'hello', senderSessionId: 's2', expectsResponse: false },
        },
      });

      expect(response.ok).toBe(true);
      const json = await response.json();
      expect(json).toBeDefined();

      if (json.error) {
        throw new Error(`MCP error: ${json.error.message}`);
      }

      expect(json.result).toBeDefined();
      expect(json.result.structuredContent).toEqual({
        success: true,
        sessionId: 's1',
        name: 'Claude',
        preambleUsed: true,
      });

      // When preambleUsed=true, the response should NOT include the polling-specific text
      const textContent = json.result.content[0].text;
      expect(textContent).not.toContain('cannot reply via HELM_MSG');
      // It should include the standard reminder (getToolReminder for session_send_text)
      expect(textContent).toContain('session_read_terminal');
    });

    it('session_send_text MCP response when preambleUsed=false with expectsResponse=true', async () => {
      const service = makeService();
      // Update mock to return multiple sessions
      (service.listSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 'target-sess', name: 'Recipient', cliType: 'claude-code' },
        { id: 'sender-sess', name: 'Sender', cliType: 'claude-code' },
      ]);

      const sendTextMock = (service.sendTextToSession as unknown as ReturnType<typeof vi.fn>);
      sendTextMock.mockImplementationOnce(async () => ({
        success: true,
        sessionId: 'target-sess',
        name: 'Recipient',
        preambleUsed: false,
      }));

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 81,
        method: 'tools/call',
        params: {
          name: 'session_send_text',
          arguments: {
            sessionId: 'target-sess',
            text: 'what is the status?',
            senderSessionId: 'sender-sess',
            expectsResponse: true,
          },
        },
      });
      const json = await response.json();

      expect(json.result.structuredContent).toEqual({
        success: true,
        sessionId: 'target-sess',
        name: 'Recipient',
        preambleUsed: false,
      });

      // When preambleUsed=false, the response should include the polling hint
      const textContent = json.result.content[0].text;
      expect(textContent).toContain('cannot reply via HELM_MSG');
      expect(textContent).toContain("session_read_terminal with sessionId='target-sess'");
      expect(textContent).toContain("lines=50, mode='stripped'");
    });

    it('session_send_text MCP response when preambleUsed=false includes exact sessionId in polling hint', async () => {
      const service = makeService();
      // Update mock to return multiple sessions
      (service.listSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 'abc-123-xyz', name: 'MySession', cliType: 'claude-code' },
        { id: 'sender1', name: 'Sender', cliType: 'claude-code' },
      ]);

      const sendTextMock = (service.sendTextToSession as unknown as ReturnType<typeof vi.fn>);
      sendTextMock.mockImplementationOnce(async () => ({
        success: true,
        sessionId: 'abc-123-xyz',
        name: 'MySession',
        preambleUsed: false,
      }));

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 82,
        method: 'tools/call',
        params: {
          name: 'session_send_text',
          arguments: {
            sessionId: 'abc-123-xyz',
            text: 'test message',
            senderSessionId: 'sender1',
          },
        },
      });
      const json = await response.json();
      const textContent = json.result.content[0].text;

      // The polling hint must contain the exact sessionId for the read_terminal call
      expect(textContent).toContain("sessionId='abc-123-xyz'");
      expect(textContent).not.toContain('target-sess');
    });

    it('session_send_text text response is properly formatted when preambleUsed=false', async () => {
      const service = makeService();
      // Update mock to return multiple sessions
      (service.listSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 's1', name: 'Claude', cliType: 'claude-code' },
        { id: 's2', name: 'Worker', cliType: 'claude-code' },
      ]);

      const sendTextMock = (service.sendTextToSession as unknown as ReturnType<typeof vi.fn>);
      sendTextMock.mockImplementationOnce(async () => ({
        success: true,
        sessionId: 's1',
        name: 'Claude',
        preambleUsed: false,
      }));

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 83,
        method: 'tools/call',
        params: {
          name: 'session_send_text',
          arguments: {
            sessionId: 's1',
            text: 'message',
            senderSessionId: 's2',
            expectsResponse: false,
          },
        },
      });
      const json = await response.json();
      const textContent = json.result.content[0].text;

      // Should start with the JSON result
      expect(textContent).toMatch(/^\{\s*"success"/);
      // Should include the polling hint after the JSON
      expect(textContent).toContain('cannot reply via HELM_MSG');
    });

    it('session_send_text with preambleUsed=true uses standard reminder text', async () => {
      const service = makeService();
      // Update mock to return multiple sessions
      (service.listSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 's1', name: 'Claude', cliType: 'claude-code' },
        { id: 's2', name: 'Worker', cliType: 'claude-code' },
      ]);

      const sendTextMock = (service.sendTextToSession as unknown as ReturnType<typeof vi.fn>);
      sendTextMock.mockImplementationOnce(async () => ({
        success: true,
        sessionId: 's1',
        name: 'Claude',
        preambleUsed: true,
      }));

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 84,
        method: 'tools/call',
        params: {
          name: 'session_send_text',
          arguments: {
            sessionId: 's1',
            text: 'hello with preamble',
            senderSessionId: 's2',
            expectsResponse: true,
          },
        },
      });
      const json = await response.json();
      const textContent = json.result.content[0].text;

      // The standard reminder for session_send_text mentions session_read_terminal
      expect(textContent).toContain('session_read_terminal');
      // But should NOT mention the no-preamble polling scenario
      expect(textContent).not.toContain('cannot reply via HELM_MSG');
    });

    it('session_send_text distinguishes between preamble=true and preamble=false responses', async () => {
      const service = makeService();
      // Update mock to return multiple sessions
      (service.listSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 's1', name: 'Claude', cliType: 'claude-code' },
        { id: 's2', name: 'Worker', cliType: 'claude-code' },
      ]);

      const sendTextMock = (service.sendTextToSession as unknown as ReturnType<typeof vi.fn>);

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      // Call 1: with preamble
      sendTextMock.mockImplementationOnce(async () => ({
        success: true,
        sessionId: 's1',
        name: 'Claude',
        preambleUsed: true,
      }));

      const response1 = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 85,
        method: 'tools/call',
        params: {
          name: 'session_send_text',
          arguments: { sessionId: 's1', text: 'msg1', senderSessionId: 's2' },
        },
      });
      const json1 = await response1.json();
      const text1 = json1.result.content[0].text;
      const hasPreambleText1 = text1.includes('cannot reply via HELM_MSG');

      // Call 2: without preamble
      sendTextMock.mockImplementationOnce(async () => ({
        success: true,
        sessionId: 's1',
        name: 'Claude',
        preambleUsed: false,
      }));

      const response2 = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 86,
        method: 'tools/call',
        params: {
          name: 'session_send_text',
          arguments: { sessionId: 's1', text: 'msg2', senderSessionId: 's2' },
        },
      });
      const json2 = await response2.json();
      const text2 = json2.result.content[0].text;
      const hasPreambleText2 = text2.includes('cannot reply via HELM_MSG');

      // Response 1 should NOT have the polling hint (preamble was used)
      expect(hasPreambleText1).toBe(false);
      // Response 2 should HAVE the polling hint (preamble was not used)
      expect(hasPreambleText2).toBe(true);
    });
  });

  describe('session_send_input MCP dispatch', () => {
    it('calls sendInputToSession with correct args and returns success', async () => {
      const service = makeService();
      (service.listSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 's1', name: 'Claude', cliType: 'claude-code' },
        { id: 's2', name: 'Worker', cliType: 'claude-code' },
      ]);
      const sendInputMock = (service.sendInputToSession as unknown as ReturnType<typeof vi.fn>);
      sendInputMock.mockImplementationOnce(async () => ({
        success: true,
        sessionId: 's1',
        name: 'Claude',
      }));

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 81,
        method: 'tools/call',
        params: {
          name: 'session_send_input',
          arguments: { sessionId: 's1', sequence: '{Esc}{Tab}{Enter}', senderSessionId: 's2' },
        },
      });

      const json = await response.json();
      expect(json.result.structuredContent).toEqual({
        success: true,
        sessionId: 's1',
        name: 'Claude',
      });
      expect(sendInputMock).toHaveBeenCalledWith(
        's1',
        '{Esc}{Tab}{Enter}',
        expect.objectContaining({ senderSessionId: 's2', senderSessionName: 'Worker' }),
      );
    });

    it('rejects when senderSessionId is unknown', async () => {
      const service = makeService();
      (service.listSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 's1', name: 'Claude', cliType: 'claude-code' },
      ]);

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 82,
        method: 'tools/call',
        params: {
          name: 'session_send_input',
          arguments: { sessionId: 's1', sequence: '{Esc}', senderSessionId: 'unknown-id' },
        },
      });

      const json = await response.json();
      expect(json.error.message).toContain('Unknown sender session');
    });
  });

  describe('session_clear MCP dispatch', () => {
    it('clears the target session and passes context through', async () => {
      const service = makeService();
      (service.listSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 's1', name: 'Claude', cliType: 'claude-code' },
      ]);
      const clearMock = (service.clearSession as unknown as ReturnType<typeof vi.fn>);

      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 83,
        method: 'tools/call',
        params: { name: 'session_clear', arguments: { sessionId: 's1', context: 'feature X half done' } },
      }, { 'x-helm-session-id': 's1' });

      const json = await response.json();
      expect(json.result.structuredContent.ok).toBe(true);
      // Target sessionId is required; the authenticated caller is passed as sender for audit.
      expect(clearMock).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ senderSessionId: 's1', context: 'feature X half done' }),
      );
    });

    it('rejects when the target sessionId is missing', async () => {
      const service = makeService();
      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 84,
        method: 'tools/call',
        params: { name: 'session_clear', arguments: {} },
      }, { 'x-helm-session-id': 's1' });

      const json = await response.json();
      expect(json.error.message).toContain('sessionId is required');
      expect(service.clearSession).not.toHaveBeenCalled();
    });
  });

  describe('telegram_chat caller routing', () => {
    it('routes to the authenticated caller session, ignoring args.name', async () => {
      const service = makeService();
      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 90,
        method: 'tools/call',
        // A misleading name must NOT override the verified caller identity.
        params: { name: 'telegram_chat', arguments: { name: 'some-other-session', message: 'hi' } },
      }, { 'x-helm-session-id': 's1' });

      const json = await response.json();
      expect(json.result.structuredContent).toEqual({ sent: true });
      expect(service.sendTelegramChat).toHaveBeenCalledWith('s1', 'hi', undefined);
    });

    it('rejects name-only calls with no caller identity instead of mis-routing', async () => {
      const service = makeService();
      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      // No x-helm-session-id header → anonymous; name alone is ambiguous.
      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 91,
        method: 'tools/call',
        params: { name: 'telegram_chat', arguments: { name: 'claudecode-opus-low', message: 'hi' } },
      });

      const json = await response.json();
      expect(json.error.message).toContain('could not determine your session');
      expect(json.error.message).toContain('session_info');
      expect(service.sendTelegramChat).not.toHaveBeenCalled();
    });

    it('accepts an explicit sessionId override for global-token callers', async () => {
      const service = makeService();
      const server = new LocalhostMcpServer(service, { token: 'secret-token', port: 0 });
      servers.push(server);
      await server.start();
      const port = server.getAddress()!.port;

      const response = await rpc(port, 'secret-token', {
        jsonrpc: '2.0',
        id: 92,
        method: 'tools/call',
        params: { name: 'telegram_chat', arguments: { sessionId: 's7', message: 'hi' } },
      });

      const json = await response.json();
      expect(json.result.structuredContent).toEqual({ sent: true });
      expect(service.sendTelegramChat).toHaveBeenCalledWith('s7', 'hi', undefined);
    });
  });
});
