/**
 * Tests for session resume logic in pty:spawn handler.
 * Verifies resume command resolution, fallback chain, and initialPrompt skipping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { normalizeProjectPath } from '../src/session/project-identity.js';

const handlers = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockScheduleInitialPrompt = vi.fn(() => null);
vi.mock('../src/session/initial-prompt.js', () => ({
  scheduleInitialPrompt: (...args: any[]) => mockScheduleInitialPrompt(...args),
}));

const mockDeliverPromptSequenceToSession = vi.fn();
vi.mock('../src/session/sequence-delivery.js', () => ({
  deliverPromptSequenceToSession: (...args: any[]) => mockDeliverPromptSequenceToSession(...args),
}));

import { setupPtyHandlers } from '../src/electron/ipc/pty-handlers.js';
import type { SessionManager } from '../src/session/manager.js';
import type { ConfigLoader, CliTypeConfig } from '../src/config/loader.js';
import { parseSessionAuthToken } from '../src/mcp/session-auth.js';

class MockPtyManager extends EventEmitter {
  has = vi.fn().mockReturnValue(true);
  write = vi.fn();
  spawn = vi.fn().mockReturnValue({ pid: 1234 });
  kill = vi.fn();
  killAll = vi.fn();
  resize = vi.fn();
  getPid = vi.fn();
  getSessionIds = vi.fn(() => []);
  setActivityMarker = vi.fn();
  on = vi.fn((event: string, listener: Function) => {
    super.on(event, listener);
    return this;
  });
}

class MockStateDetector extends EventEmitter {
  processOutput = vi.fn();
  dispose = vi.fn();
  removeSession = vi.fn();
  markRestored = vi.fn();
  on = vi.fn((event: string, listener: Function) => {
    super.on(event, listener);
    return this;
  });
}

class MockPipelineQueue {
  enqueue = vi.fn();
  dequeue = vi.fn();
  getAll = vi.fn().mockReturnValue([]);
  getPosition = vi.fn();
  triggerHandoff = vi.fn();
}

describe('pty:spawn resume logic', () => {
  let ptyManager: MockPtyManager;
  let sessionManager: Record<string, any>;
  let configLoader: Record<string, any>;
  let sessions: Map<string, any>;
  const originalEnv = {
    AZURE_API_BASE: process.env.AZURE_API_BASE,
    AZURE_API_KEY: process.env.AZURE_API_KEY,
    AZURE_API_VERSION: process.env.AZURE_API_VERSION,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    process.env.AZURE_API_BASE = originalEnv.AZURE_API_BASE;
    process.env.AZURE_API_KEY = originalEnv.AZURE_API_KEY;
    process.env.AZURE_API_VERSION = originalEnv.AZURE_API_VERSION;

    ptyManager = new MockPtyManager();
    sessions = new Map();
    sessionManager = {
      addSession: vi.fn((info: any) => sessions.set(info.id, info)),
      getSession: vi.fn((id: string) => sessions.get(id) || null),
      hasSession: vi.fn((id: string) => sessions.has(id)),
      updateSession: vi.fn((id: string, updates: any) => Object.assign(sessions.get(id) ?? {}, updates)),
      removeSession: vi.fn(),
      on: vi.fn(),
    };
    configLoader = {
      getCliTypeEntry: vi.fn(),
      resolveCliType: vi.fn((ref: string) => {
        const config = configLoader.getCliTypeEntry(ref);
        return config ? { id: ref, config } : null;
      }),
      getMcpConfig: vi.fn(() => ({ enabled: false, port: 47373, authToken: '' })),
      reloadActiveProfileIfChanged: vi.fn(),
    };

    setupPtyHandlers(
      ptyManager as any,
      new MockStateDetector() as any,
      sessionManager as any,
      new MockPipelineQueue() as any,
      () => null,
      configLoader as any,
    );
  });

  it('uses resumeCommand as rawCommand when resumeSessionName is provided', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      resumeCommand: 'claude --resume "{cliSessionName}"',
      renameCommand: '/rename {cliSessionName}',
      initialPromptDelay: 100,
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code', undefined, 'hub-sid-1');

    // Should spawn with rawCommand — no escaping, no split on whitespace
    expect(ptyManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid-1',
      command: undefined,
      args: undefined,
      rawCommand: 'claude --resume "hub-sid-1"',
      cwd: normalizeProjectPath('/work'),
      env: expect.objectContaining({
        HELM_SESSION_ID: 'sid-1',
        HELM_SESSION_NAME: 'Claude Code',
      }),
    }));
  });

  it('falls back to continueCommand as rawCommand when no resumeCommand', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      continueCommand: 'claude --continue',
      initialPromptDelay: 100,
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code', undefined, 'hub-sid-1');

    // continueCommand also uses rawCommand — it's a CLI parameter
    expect(ptyManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid-1',
      command: undefined,
      args: undefined,
      rawCommand: 'claude --continue',
      cwd: normalizeProjectPath('/work'),
      env: expect.objectContaining({
        HELM_SESSION_ID: 'sid-1',
        HELM_SESSION_NAME: 'Claude Code',
      }),
    }));
  });

  it('falls back to base command when no resumeCommand and no continueCommand', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Generic',
      command: 'bash',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'bash', ['-l'], '/work', 'generic', undefined, 'hub-sid-1');

    // Should use original command and args (no rawCommand)
    expect(ptyManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid-1',
      command: 'bash',
      args: ['-l'],
      rawCommand: undefined,
      cwd: normalizeProjectPath('/work'),
      env: expect.objectContaining({
        HELM_SESSION_ID: 'sid-1',
        HELM_SESSION_NAME: 'Generic',
      }),
    }));
  });

  it('skips initialPrompt on resume', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      resumeCommand: 'claude --resume "{cliSessionName}"',
      renameCommand: '/rename {cliSessionName}',
      initialPrompt: [{ label: 'Init', sequence: '/init{Enter}' }],
      initialPromptDelay: 2000,
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code', undefined, 'hub-sid-1');

    // scheduleInitialPrompt should be called WITHOUT initialPrompt items
    expect(mockScheduleInitialPrompt).toHaveBeenCalledWith(
      'sid-1',
      expect.objectContaining({
        renameCommand: '/rename hub-sid-1',
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
    // The config passed should NOT have initialPrompt
    const config = mockScheduleInitialPrompt.mock.calls[0][1];
    expect(config.initialPrompt).toBeUndefined();
  });

  it('skips contextText on resume', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      resumeCommand: 'claude --resume "{cliSessionName}"',
      initialPromptDelay: 100,
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code', 'some context text', 'hub-sid-1');

    // Context prompt should not be delivered during resume
    expect(ptyManager.write).not.toHaveBeenCalledWith('sid-1', 'some context text');
    expect(mockDeliverPromptSequenceToSession).not.toHaveBeenCalled();
  });

  it('delivers fresh-spawn contextText through prompt-sequence delivery', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      submitSuffix: '\\n',
      initialPromptDelay: 100,
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code', '  context{Send}  ');

    const onComplete = mockScheduleInitialPrompt.mock.calls[0][4] as (() => void) | undefined;
    expect(onComplete).toBeTypeOf('function');
    onComplete?.();

    expect(mockDeliverPromptSequenceToSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid-1',
      text: '  context{Send}  ',
      ptyManager,
      sessionManager,
      configLoader,
    }));
  });

  it('sends renameCommand on resume (via scheduleInitialPrompt)', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      resumeCommand: 'claude --resume "{cliSessionName}"',
      renameCommand: '/rename {cliSessionName}',
      initialPromptDelay: 2000,
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code', undefined, 'hub-sid-1');

    expect(mockScheduleInitialPrompt).toHaveBeenCalledWith(
      'sid-1',
      expect.objectContaining({
        renameCommand: '/rename hub-sid-1',
        initialPromptDelay: 2000,
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('sets cliSessionName as UUID on session for fresh spawn', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code');

    const session = sessions.get('sid-1');
    // Should be a valid UUID v4 (not hub-sid-1)
    expect(session.cliSessionName).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('preserves resumeSessionName as cliSessionName on resume', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      resumeCommand: 'claude --resume "{cliSessionName}"',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code', undefined, 'hub-original-session');

    const session = sessions.get('sid-1');
    expect(session.cliSessionName).toBe('hub-original-session');
  });

  it('uses spawnCommand as rawCommand for fresh spawn when configured', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      spawnCommand: 'claude --session-id {cliSessionName}',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code');

    const session = sessions.get('sid-1');
    const uuid = session.cliSessionName;
    // Should be a valid UUID
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // Should spawn with rawCommand using the UUID
    expect(ptyManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid-1',
      command: undefined,
      args: undefined,
      rawCommand: `claude --session-id ${uuid}`,
      cwd: normalizeProjectPath('/work'),
      env: expect.objectContaining({
        HELM_SESSION_ID: 'sid-1',
        HELM_SESSION_NAME: 'Claude Code',
      }),
    }));
  });

  it('passes configured tool environment variables to PTY spawn', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Ollama Copilot',
      command: 'copilot',
      env: [
        { name: 'COPILOT_PROVIDER_TYPE', value: 'openai' },
        { name: 'COPILOT_PROVIDER_BASE_URL', value: 'http://192.168.56.1:1234' },
        { name: 'COPILOT_MODEL', value: 'qwen/qwen3.6-35b-a3b' },
      ],
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'copilot', [], '/work', 'copilot-ollama');

    expect(ptyManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          COPILOT_PROVIDER_TYPE: 'openai',
          COPILOT_PROVIDER_BASE_URL: 'http://192.168.56.1:1234',
          COPILOT_MODEL: 'qwen/qwen3.6-35b-a3b',
          HELM_MCP_TOKEN: expect.any(String),
          HELM_MCP_URL: 'http://127.0.0.1:47373/mcp',
          HELM_HOOK_URL: 'http://127.0.0.1:47373/hooks',
          HELM_SESSION_ID: 'sid-1',
          HELM_SESSION_NAME: 'Ollama Copilot',
        }),
      }),
    );
  });

  it('resolves environment variable references before PTY spawn', async () => {
    process.env.AZURE_API_BASE = 'https://example.azure.com/';
    process.env.AZURE_API_KEY = 'secret-key';
    process.env.AZURE_API_VERSION = '2024-12-01-preview';
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Azure Copilot',
      command: 'copilot',
      env: [
        { name: 'COPILOT_PROVIDER_TYPE', value: 'azure' },
        { name: 'COPILOT_PROVIDER_BASE_URL', value: '%AZURE_API_BASE%' },
        { name: 'COPILOT_PROVIDER_API_KEY', value: '${AZURE_API_KEY}' },
        { name: 'COPILOT_PROVIDER_AZURE_API_VERSION', value: '%AZURE_API_VERSION%' },
      ],
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'copilot', [], '/work', 'azure-copilot');

    expect(ptyManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          COPILOT_PROVIDER_TYPE: 'azure',
          COPILOT_PROVIDER_BASE_URL: 'https://example.azure.com/',
          COPILOT_PROVIDER_API_KEY: 'secret-key',
          COPILOT_PROVIDER_AZURE_API_VERSION: '2024-12-01-preview',
          HELM_MCP_TOKEN: expect.any(String),
          HELM_MCP_URL: 'http://127.0.0.1:47373/mcp',
          HELM_SESSION_ID: 'sid-1',
          HELM_SESSION_NAME: 'Azure Copilot',
        }),
      }),
    );
  });

  it('injects Helm-managed environment variables even without manual env config', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
    } as CliTypeConfig);
    configLoader.getMcpConfig.mockReturnValue({
      enabled: true,
      port: 47373,
      authToken: 'helm-token',
    });

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code');

    expect(ptyManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          HELM_MCP_TOKEN: expect.any(String),
          HELM_MCP_URL: 'http://127.0.0.1:47373/mcp',
          HELM_SESSION_ID: 'sid-1',
          HELM_SESSION_NAME: 'Claude Code',
        }),
      }),
    );
    const env = (ptyManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
    expect(parseSessionAuthToken('helm-token', env.HELM_MCP_TOKEN)).toEqual({
      sessionId: 'sid-1',
      sessionName: 'Claude Code',
    });
  });

  it('falls back to command+args when no spawnCommand on fresh spawn', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Generic',
      command: 'bash',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'bash', ['-l'], '/work', 'generic');

    expect(ptyManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid-1',
      command: 'bash',
      args: ['-l'],
      rawCommand: undefined,
      cwd: normalizeProjectPath('/work'),
      env: expect.objectContaining({
        HELM_SESSION_ID: 'sid-1',
        HELM_SESSION_NAME: 'Generic',
      }),
    }));
  });

  it('prefers resumeCommand over spawnCommand on resume', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      spawnCommand: 'claude --session-id {cliSessionName}',
      resumeCommand: 'claude --resume={cliSessionName}',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code', undefined, 'abc-123');

    expect(ptyManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid-1',
      command: undefined,
      args: undefined,
      rawCommand: 'claude --resume=abc-123',
      cwd: normalizeProjectPath('/work'),
      env: expect.objectContaining({
        HELM_SESSION_ID: 'sid-1',
        HELM_SESSION_NAME: 'Claude Code',
      }),
    }));
  });

  it('warns when spawnCommand has no {cliSessionName} placeholder', async () => {
    const { logger } = await import('../src/utils/logger.js');
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      spawnCommand: 'claude --no-placeholder',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('spawnCommand has no {cliSessionName}/{cliThreadId} placeholder'),
    );
    // Should still use spawnCommand as rawCommand (even without substitution)
    expect(ptyManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ rawCommand: 'claude --no-placeholder' }),
    );
  });

  it('warns when resumeCommand has no {cliSessionName} placeholder', async () => {
    const { logger } = await import('../src/utils/logger.js');
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      resumeCommand: 'claude --resume-latest',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code', undefined, 'abc-uuid');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('resumeCommand has no {cliSessionName}/{cliThreadId} placeholder'),
    );
  });

  it('falls back to command+args when configLoader is undefined', async () => {
    // Setup without configLoader
    handlers.clear();
    setupPtyHandlers(
      ptyManager as any,
      new MockStateDetector() as any,
      sessionManager as any,
      new MockPipelineQueue() as any,
      () => null,
      undefined as any,
    );

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', ['--flag'], '/work', 'claude-code');

    // Without configLoader, should use command+args directly
    expect(ptyManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid-1',
      command: 'claude',
      args: ['--flag'],
      rawCommand: undefined,
      cwd: normalizeProjectPath('/work'),
      env: expect.objectContaining({
        HELM_SESSION_ID: 'sid-1',
        HELM_SESSION_NAME: 'claude-code',
      }),
    }));
  });

  it('includes cliSessionName in addSession call atomically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T17:20:00Z'));
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'sid-1', 'claude', [], '/work', 'claude-code');

    // cliSessionName should be part of the addSession payload (persisted atomically)
    expect(sessionManager.addSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sid-1',
        cliSessionName: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
        lastOutputAt: Date.now(),
      }),
    );
    vi.useRealTimers();
  });

  it('sets HELM_SESSION_ID to the provided sessionId on resume', async () => {
    configLoader.getCliTypeEntry.mockReturnValue({
      name: 'Claude Code',
      command: 'claude',
      resumeCommand: 'claude --resume "{cliSessionName}"',
    } as CliTypeConfig);

    const handler = handlers.get('pty:spawn')!;
    await handler({}, 'original-session-123', 'claude', [], '/work', 'claude-code', undefined, 'hub-session-abc');

    const env = (ptyManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
    expect(env.HELM_SESSION_ID).toBe('original-session-123');
  });
});
