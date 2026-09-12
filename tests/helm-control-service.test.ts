import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelmControlService, parseSubmitSuffix } from '../src/mcp/helm-control-service.js';
import { getAvailableTools } from '../src/mcp/guides/session-info-guide.js';
import { parseSessionAuthToken } from '../src/mcp/session-auth.js';
import { SkillManager } from '../src/session/skill-manager.js';
import { SkillAnalyticsManager } from '../src/session/skill-analytics-manager.js';
import { logger } from '../src/utils/logger.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

process.env.HELM_INTERSESSION_VERIFY_DELAY_MS = '0';

function makeService(schedulerManager?: { createTask: ReturnType<typeof vi.fn> }) {
  const ptyManager = {
    has: vi.fn(() => true),
    deliverText: vi.fn(() => Promise.resolve()),
    nudgeResize: vi.fn(() => Promise.resolve()),
    write: vi.fn(),
    spawn: vi.fn(() => ({ pid: 1234 })),
    kill: vi.fn(),
    getTerminalTail: vi.fn(() => ({
      raw: ['\x1b[31mraw\x1b[0m'],
      stripped: ['raw'],
      lastOutputAt: 1234,
    })),
  };
  const sessionManager = {
    getSession: vi.fn((id: string) => ({ id, name: 'Claude', cliType: 'claude-code' })),
    getAllSessions: vi.fn(() => [{ id: 's1', name: 'Claude', cliType: 'claude-code' }]),
    addSession: vi.fn(),
    updateSession: vi.fn(),
    removeSession: vi.fn(),
  };
  const planManager = {
    getForDirectory: vi.fn(() => []),
    getItem: vi.fn(),
    getSequence: vi.fn(() => null),
    getProjectIdForDirectory: vi.fn((dirPath: string) => dirPath === '/work' ? 'project-1' : null),
    getDirectoryForProject: vi.fn((projectId: string) => projectId === 'project-1' ? '/work' : null),
    exportAll: vi.fn(() => ({})),
    resolveItemRef: vi.fn((ref: string) => {
      const item = planManager.getItem(ref);
      return item ? { status: 'found' as const, item } : { status: 'missing' as const };
    }),
    setState: vi.fn(),
    claimPlan: vi.fn(),
  };
  const configLoader = {
    getWorkingDirectories: vi.fn(() => [{ name: 'Helm', path: '/work' }]),
    getCliTypeEntry: vi.fn(() => ({})),
    getCliTypeLabel: vi.fn((ref: string) => ref),
    resolveCliType: vi.fn((ref: string) => {
      const config = configLoader.getCliTypeEntry();
      return config ? { id: ref, config } : null;
    }),
    getAllCliTypes: vi.fn(() => []),
    getCliTypeConfig: vi.fn(() => ({})),
    getMcpConfig: vi.fn(() => ({ enabled: true, port: 47373, authToken: 'helm-token' })),
    getTelegramConfig: vi.fn(() => ({
      enabled: true,
      botToken: 'configured',
      chatId: 123,
      allowedUserIds: [456],
      instanceName: 'Home',
      safeModeDefault: true,
      notifyOnComplete: true,
      notifyOnIdle: true,
      notifyOnError: true,
      notifyOnCrash: true,
    })),
  };

  const service = new HelmControlService(
    planManager as unknown as import('../src/session/plan-manager.js').PlanManager,
    sessionManager as unknown as import('../src/session/manager.js').SessionManager,
    ptyManager as unknown as import('../src/session/pty-manager.js').PtyManager,
    configLoader as unknown as import('../src/config/loader.js').ConfigLoader,
    undefined,
    undefined,
    schedulerManager as unknown as import('../src/session/scheduled-task-manager.js').ScheduledTaskManager | undefined,
  );

  return { service, ptyManager, sessionManager, configLoader, planManager, schedulerManager };
}

describe('HelmControlService.sendTextToSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers text atomically with submitSuffix for auto-execution', async () => {
    const { service, ptyManager } = makeService();
    await service.sendTextToSession('s1', 'hello', { senderSessionId: 'sid', senderSessionName: 'Sender' });
    expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('hello'));
    expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
  });

  it('wraps text in HELM_MSG envelope with sender info and metadata', async () => {
    const { service, ptyManager } = makeService();
    await service.sendTextToSession('s1', 'hello', {
      senderSessionId: 'sender1',
      senderSessionName: 'Sender',
      expectsResponse: true,
    });

    const callArg = (ptyManager.deliverText as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(callArg).toMatch(/^\[HELM_MSG: expectsResponse=true\. To reply, call MCP tool mcp__helm__session_send_text with: sessionId="sender1"/);
    expect(callArg).toContain('senderSessionId=<your env $HELM_SESSION_ID>');

    const envelopeMatch = callArg.match(/^\[HELM_MSG[^\]]*\](\{[^\n}]*\})/);
    expect(envelopeMatch).toBeTruthy();

    const envelope = JSON.parse(envelopeMatch![1]);
    expect(envelope).toMatchObject({
      type: 'inter_llm_message',
      fromSessionId: 'sender1',
      fromSessionName: 'Sender',
      expectsResponse: true,
    });
    expect(envelope.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('defaults expectsResponse to false in envelope', async () => {
    const { service, ptyManager } = makeService();
    await service.sendTextToSession('s1', 'hello', {
      senderSessionId: 'sender1',
      senderSessionName: 'Sender',
    });

    const callArg = (ptyManager.deliverText as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(callArg).toMatch(/^\[HELM_MSG\]\{/);
    const envelopeMatch = callArg.match(/^\[HELM_MSG\](\{[^\n}]*\})/);
    const envelope = JSON.parse(envelopeMatch![1]);
    expect(envelope.expectsResponse).toBe(false);
  });

  it('throws when sender info is missing', async () => {
    const { service } = makeService();
    await expect(service.sendTextToSession('s1', 'hello')).rejects.toThrow('senderSessionId and senderSessionName are required');
  });

  it('throws when only senderSessionId is provided without senderSessionName', async () => {
    const { service } = makeService();
    await expect(service.sendTextToSession('s1', 'hello', { senderSessionId: 'sid' })).rejects.toThrow('senderSessionId and senderSessionName are required');
  });

  it('throws when session is not found', async () => {
    const { service, sessionManager } = makeService();
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    await expect(service.sendTextToSession('missing', 'hello')).rejects.toThrow('Session not found: missing');
  });

  it('throws when PTY is not running', async () => {
    const { service, ptyManager } = makeService();
    (ptyManager.has as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await expect(service.sendTextToSession('s1', 'hello')).rejects.toThrow('Session PTY is not running: s1');
  });

  it('throws when sender and receiver are the same session', async () => {
    const { service } = makeService();
    await expect(
      service.sendTextToSession('s1', 'hello', { senderSessionId: 's1', senderSessionName: 'Same' }),
    ).rejects.toThrow('Cannot send a message from a session to itself — sender and receiver must be different sessions');
  });

  it('prefers exact session name matches over ID lookup results', async () => {
    const { service, ptyManager, sessionManager } = makeService();
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'codex-1', name: 'codex', cliType: 'codex' },
      { id: 'potato-4', name: 'potato', cliType: 'claude-code' },
    ]);
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockImplementation((ref: string) => {
      if (ref === 'potato') return { id: 'codex-1', name: 'codex', cliType: 'codex' };
      if (ref === 'potato-4') return { id: 'potato-4', name: 'potato', cliType: 'claude-code' };
      return null;
    });

    const result = await service.sendTextToSession('potato', 'hello potato', {
      senderSessionId: 'sender',
      senderSessionName: 'Sender',
    });

    expect(result.ok).toBe(true);
    expect(ptyManager.deliverText).toHaveBeenCalledWith('potato-4', expect.stringContaining('hello potato'));
  });

  it('resolves exact session IDs when no name matches', async () => {
    const { service, ptyManager, sessionManager } = makeService();
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'potato-4', name: 'potato', cliType: 'claude-code' },
    ]);
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockImplementation((ref: string) => (
      ref === 'codex-1' ? { id: 'codex-1', name: 'codex', cliType: 'codex' } : null
    ));

    const result = await service.sendTextToSession('codex-1', 'hello codex', {
      senderSessionId: 'sender',
      senderSessionName: 'Sender',
    });

    expect(result.ok).toBe(true);
    expect(ptyManager.deliverText).toHaveBeenCalledWith('codex-1', expect.stringContaining('hello codex'));
  });

  it('rejects ambiguous session names before falling back to IDs', async () => {
    const { service, sessionManager } = makeService();
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 'first', name: 'potato', cliType: 'claude-code' },
      { id: 'second', name: 'potato', cliType: 'codex' },
    ]);
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'third', name: 'other', cliType: 'codex' });

    await expect(
      service.sendTextToSession('potato', 'hello', { senderSessionId: 'sender', senderSessionName: 'Sender' }),
    ).rejects.toThrow('Multiple sessions found with name: potato. Use sessionId instead.');
  });
});

describe('HelmControlService.setAiagentState', () => {
  it('updates durable aiagentState through the session manager', () => {
    const { service, sessionManager } = makeService();

    const result = service.setAiagentState('s1', 'completed');

    expect(result).toEqual({ ok: true });
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', { aiagentState: 'completed' });
  });
});

describe('HelmControlService plan sequences', () => {
  it('returns sequence membership and shared memory for a plan', () => {
    const { service, planManager } = makeService();
    const plan = {
      id: 'plan-1',
      humanId: 'P-0001',
      dirPath: '/work',
      title: 'Plan',
      description: 'Body',
      status: 'ready',
      sequenceId: 'seq-1',
      projectId: 'project-1',
      createdAt: 1,
      updatedAt: 1,
    };
    const sequence = {
      id: 'seq-1',
      dirPath: '/work',
      title: 'Sequence',
      missionStatement: 'Mission',
      sharedMemory: 'Shared notes',
      order: 0,
      createdAt: 1,
      updatedAt: 2,
    };
    (planManager.getItem as ReturnType<typeof vi.fn>).mockReturnValue(plan);
    (planManager.getForDirectory as ReturnType<typeof vi.fn>).mockReturnValue([plan]);
    (planManager as any).getSequencesForDirectory = vi.fn(() => [sequence]);

    expect(service.listPlanSequences({ planRef: 'P-0001' })).toEqual([
      expect.objectContaining({
        id: 'seq-1',
        sharedMemory: 'Shared notes',
        memberPlanIds: ['plan-1'],
        memberHumanIds: ['P-0001'],
        selectedForPlan: true,
      }),
    ]);
  });

});

describe('HelmControlService effective plan context', () => {
  it('lists deduped effective context refs for a plan with source metadata', () => {
    const { service, planManager } = makeService();
    const plan = {
      id: 'plan-1',
      humanId: 'P-0001',
      dirPath: '/work',
      title: 'Plan',
      description: 'Body',
      status: 'ready',
      sequenceId: 'seq-1',
      projectId: 'project-1',
      createdAt: 1,
      updatedAt: 1,
    };
    (planManager.getItem as ReturnType<typeof vi.fn>).mockReturnValue(plan);
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    (planManager as any).getSequence = vi.fn((id: string) => id === 'seq-1'
      ? { id: 'seq-1', projectId: 'project-1', dirPath: '/work', title: 'Sequence', missionStatement: '', sharedMemory: '', order: 0, createdAt: 1, updatedAt: 1 }
      : null);
    (planManager.getForDirectory as ReturnType<typeof vi.fn>).mockReturnValue([plan]);
    (planManager.exportAll as ReturnType<typeof vi.fn>).mockReturnValue({
      '/work': {
        dirPath: '/work',
        items: [plan],
        dependencies: [],
        sequences: [{ id: 'seq-1', projectId: 'project-1', dirPath: '/work', title: 'Sequence', missionStatement: '', sharedMemory: '', order: 0, createdAt: 1, updatedAt: 1 }],
      },
    });
    const contextManager = (service as any).contextManager;
    contextManager.create('project-1', { title: 'Plan only', type: 'Coding' });
    contextManager.create('project-1', { title: 'Sequence only', type: 'Testing' });
    contextManager.create('project-1', { title: 'Shared', type: 'Review' });
    const contexts = contextManager.listForProject('project-1');
    const planOnly = contexts.find((ctx: any) => ctx.title === 'Plan only');
    const seqOnly = contexts.find((ctx: any) => ctx.title === 'Sequence only');
    const shared = contexts.find((ctx: any) => ctx.title === 'Shared');
    contextManager.bind(planOnly.id, 'plan', 'plan-1');
    contextManager.bind(seqOnly.id, 'sequence', 'seq-1');
    contextManager.bind(shared.id, 'plan', 'plan-1');
    contextManager.bind(shared.id, 'sequence', 'seq-1');

    const result = service.listPlanContexts('P-0001');

    expect(result).toEqual([
      expect.objectContaining({ id: planOnly.id, type: 'Coding', source: 'plan' }),
      expect.objectContaining({ id: shared.id, type: 'Review', source: 'both' }),
      expect.objectContaining({ id: seqOnly.id, type: 'Testing', source: 'sequence' }),
    ]);
  });
});

describe('HelmControlService directory validation', () => {
  it('createPlan rejects unconfigured dirPath', () => {
    const { service } = makeService();
    expect(() => service.createPlan('/unconfigured', 'Title', 'Desc')).toThrow('not configured in Helm');
  });

  it('createPlan accepts configured dirPath', () => {
    const { service, planManager } = makeService();
    (planManager as any).createWithType = vi.fn(() => ({ id: 'p1', dirPath: '/work', title: 'Title', status: 'ready' }));
    expect(() => service.createPlan('/work', 'Title', 'Desc')).not.toThrow();
    expect((planManager as any).createWithType).toHaveBeenCalledWith('/work', 'Title', 'Desc', undefined, undefined);
  });

  it('createPlanSequence rejects unconfigured dirPath', () => {
    const { service } = makeService();
    expect(() => service.createPlanSequence({ dirPath: '/unconfigured', title: 'Seq' })).toThrow('not configured in Helm');
  });

  it('createPlanSequence accepts configured dirPath', () => {
    const { service, planManager } = makeService();
    (planManager as any).createSequence = vi.fn(() => ({ id: 's1', dirPath: '/work', title: 'Seq', missionStatement: '', sharedMemory: '', order: 0 }));
    expect(() => service.createPlanSequence({ dirPath: '/work', title: 'Seq' })).not.toThrow();
    expect((planManager as any).createSequence).toHaveBeenCalledWith('/work', 'Seq', '', '');
  });
});

describe('HelmControlService.spawnCli', () => {
  it('injects Helm-managed environment variables into spawned CLI sessions', () => {
    const { service, ptyManager, configLoader } = makeService();
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'Claude Code',
      spawnCommand: 'claude',
      env: [{ name: 'EXTRA_FLAG', value: 'enabled' }],
    });

    service.spawnCli('claude-code', '/work', 'Claude');

    expect(ptyManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          EXTRA_FLAG: 'enabled',
          HELM_MCP_TOKEN: expect.any(String),
          HELM_SESSION_ID: expect.any(String),
          HELM_SESSION_NAME: 'Claude',
        }),
      }),
    );
    const env = (ptyManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
    expect(parseSessionAuthToken('helm-token', env.HELM_MCP_TOKEN)).toEqual({
      sessionId: env.HELM_SESSION_ID,
      sessionName: 'Claude',
    });
  });

  // MCP clients put HELM_SESSION_NAME straight into a request header, and an em
  // dash in the name made `claude mcp add` reject the entire Helm server.
  it('exports a header-safe HELM_SESSION_NAME', () => {
    const { service, ptyManager, configLoader } = makeService();
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'Claude Code',
      spawnCommand: 'claude',
    });

    service.spawnCli('claude-code', '/work', 'Windows verify — artifacts');

    const env = (ptyManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
    expect(env.HELM_SESSION_NAME).toBe('Windows verify - artifacts');
  });

  describe('initialPrompt scheduling', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('sends configured initialPrompt sequences to PTY after delay', async () => {
      const { service, ptyManager, configLoader } = makeService();
      (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
        name: 'Claude Code',
        spawnCommand: 'claude',
        initialPrompt: [{ label: 'hello', sequence: 'Hello world{Enter}' }],
        initialPromptDelay: 1000,
      });

      service.spawnCli('claude-code', '/work', 'Claude');
      expect(ptyManager.write).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();

      expect(ptyManager.deliverText).toHaveBeenCalledWith(
        expect.any(String),
        'Hello world',
      );
      expect(ptyManager.deliverText).toHaveBeenCalledWith(expect.any(String), '', { submitSuffix: '\r' });
    });

    it('delivers initialPrompt sequence after delay', async () => {
      const { service, ptyManager, configLoader } = makeService();
      (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
        name: 'Claude Code',
        spawnCommand: 'claude',
        initialPrompt: [{ label: 'init', sequence: 'init{Enter}' }],
        initialPromptDelay: 500,
      });

      service.spawnCli('claude-code', '/work', 'Claude');
      vi.advanceTimersByTime(500);
      await vi.runAllTimersAsync();

      expect(ptyManager.deliverText).toHaveBeenCalledWith(
        expect.any(String),
        'init',
      );
      expect(ptyManager.deliverText).toHaveBeenCalledWith(expect.any(String), '', { submitSuffix: '\r' });
    });
  });

  it('sets the explicit working plan for a session and reassigns a startable plan', () => {
    const { service, sessionManager } = makeService();
    const planManager = (service as any).planManager;
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: '/work',
    });
    (planManager.getItem as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'plan-1',
      dirPath: '/work',
      title: 'Auth refactor',
      description: 'Desc',
      status: 'ready',
    });
    (planManager.setState as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'plan-1',
      dirPath: '/work',
      title: 'Auth refactor',
      description: 'Desc',
      status: 'coding',
      sessionId: 's1',
    });

    const result = service.claimSessionPlan('s1', 'plan-1');

    expect(planManager.setState).toHaveBeenCalledWith('plan-1', 'coding');
    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', { currentPlanId: 'plan-1' });
    expect(result).toEqual({ ok: true });
  });

  // normalizeProjectPath lowercases paths only on win32, so case-insensitive
  // directory matching is genuinely Windows-only behavior — gate it there and
  // assert the case-sensitive Unix equivalent separately below.
  it.runIf(process.platform === 'win32')('matches Windows session and plan directories case-insensitively when setting the working plan', () => {
    const { service, sessionManager } = makeService();
    const planManager = (service as any).planManager;
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: 'X:\\coding\\gamepad-cli-hub',
    });
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'found',
      item: {
        id: 'plan-1',
        dirPath: 'x:\\coding\\gamepad-cli-hub',
        title: 'Lowercase drive',
        description: 'Desc',
        status: 'ready',
      },
    });
    (planManager.setState as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'plan-1',
      dirPath: 'x:\\coding\\gamepad-cli-hub',
      title: 'Lowercase drive',
      description: 'Desc',
      status: 'coding',
      sessionId: 's1',
    });

    const result = service.claimSessionPlan('s1', 'plan-1');

    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', { currentPlanId: 'plan-1' });
    expect(result).toEqual({ ok: true });
  });

  // Unix counterpart of the win32-gated test above: paths are case-sensitive on
  // Unix, so an exact-case match succeeds while a case-variant directory is rejected.
  it.runIf(process.platform !== 'win32')('matches Unix session and plan directories case-sensitively when setting the working plan', () => {
    const { service, sessionManager } = makeService();
    const planManager = (service as any).planManager;
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: '/coding/gamepad-cli-hub',
    });
    const plan = {
      id: 'plan-1',
      dirPath: '/coding/gamepad-cli-hub',
      title: 'Exact case',
      description: 'Desc',
      status: 'ready',
    };
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    (planManager.setState as ReturnType<typeof vi.fn>).mockReturnValue({ ...plan, status: 'coding', sessionId: 's1' });

    const result = service.claimSessionPlan('s1', 'plan-1');

    expect(sessionManager.updateSession).toHaveBeenCalledWith('s1', { currentPlanId: 'plan-1' });
    expect(result).toEqual({ ok: true });

    // A case-variant plan directory must NOT match on case-sensitive Unix paths.
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'found',
      item: { ...plan, dirPath: '/Coding/Gamepad-CLI-Hub' },
    });
    expect(() => service.claimSessionPlan('s1', 'plan-1')).toThrow('does not belong to session directory');
  });

  it('accepts P-id plan references when setting the explicit working plan', () => {
    const { service, sessionManager } = makeService();
    const planManager = (service as any).planManager;
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: '/work',
    });
    const plan = {
      id: 'plan-1',
      humanId: 'P-0042',
      dirPath: '/work',
      title: 'Auth refactor',
      description: 'Desc',
      status: 'ready',
    };
    (planManager.getItem as ReturnType<typeof vi.fn>).mockImplementation((ref: string) => ref === 'plan-1' ? plan : null);
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockImplementation((ref: string) => (
      ref === 'P-0042' ? { status: 'found', item: plan } : { status: 'missing' }
    ));
    (planManager.setState as ReturnType<typeof vi.fn>).mockReturnValue({ ...plan, status: 'coding', sessionId: 's1' });

    const result = service.claimSessionPlan('s1', 'P-0042');

    expect(planManager.setState).toHaveBeenCalledWith('plan-1', 'coding');
    expect(result).toEqual({ ok: true });
  });

  it('reports ambiguous P-id references clearly', () => {
    const { service, sessionManager } = makeService();
    const planManager = (service as any).planManager;
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: '/work',
    });
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'ambiguous',
      matches: [
        { id: 'a', humanId: 'P-0042', dirPath: '/work' },
        { id: 'b', humanId: 'P-0042', dirPath: '/other' },
      ],
    });

    expect(() => service.claimSessionPlan('s1', 'P-0042')).toThrow('Plan reference is ambiguous: P-0042');
  });
});

describe('HelmControlService optional domain services', () => {
  it('throws a clear error when scheduler tools are used without a scheduler manager', () => {
    const { service } = makeService();

    expect(() => service.listScheduledTasks()).toThrow('Scheduler is not available');
    expect(() => service.getScheduledTask('task-1')).toThrow('Scheduler is not available');
  });

  it('throws a clear error when project tools are used without a project store', () => {
    const { service } = makeService();

    expect(() => service.listProjects()).toThrow('Project service is not available');
    expect(() => service.listProjectDirs('project-1')).toThrow('Project service is not available');
    expect(() => service.addProjectDir('project-1', '/other')).toThrow('Project service is not available');
    expect(() => service.removeProjectDir('project-1', '/other')).toThrow('Project service is not available');
  });
});

describe('HelmControlService.getSessionInfo', () => {
  it('returns session identity, workflow, and structured durable memory guidance', () => {
    const { service } = makeService();

    const info = service.getSessionInfo({ sessionId: 's1', sessionName: 'Claude' });

    expect(Object.keys(info).sort()).toEqual(['artifact_viewer', 'durable_memory', 'helm_workflow', 'knowledge_model', 'your_session_id', 'your_working_dir']);
    expect(info.helm_workflow).toContain('startup');
    expect(info.artifact_viewer).toContain('artifact_create');
    expect(info.durable_memory.tools).toContain('memory_search');
    expect(info.durable_memory.recycle_bin).toContain('same original session id');
    expect(info).not.toHaveProperty('mandatory_rules');
    expect(info).not.toHaveProperty('mcp_url');
    expect(info).not.toHaveProperty('mcp_token');
    expect(info).not.toHaveProperty('telegramCapabilities');
    expect(info).not.toHaveProperty('available_projects');
    expect(info).not.toHaveProperty('skills');
  });

  it('sys-startup skill is reachable and contains workflow rules', () => {
    const { service } = makeService();

    const startup = service.resolveSkill('startup');
    expect(startup).not.toBeNull();
    expect(startup!.body).toContain('session_plan_claim');
    expect(startup!.body).toContain('notify_user');
    expect(startup!.body).toContain('plan_get');
    expect(startup!.body).toContain('skill_submit_feedback');
  });

  it('exposes guide content via system skills', () => {
    const { service } = makeService();

    const planGuide = service.resolveSkill('agent-plan');
    expect(planGuide).toBeDefined();
    expect(planGuide!.body).toContain('Problem Statement');
    expect(planGuide!.body).toContain('Follow-up work');
    expect(planGuide!.body).toContain('plan_nextplan_link');
    expect(planGuide!.body).toContain('tests');

    const sendTextGuide = service.resolveSkill('session-send-text');
    expect(sendTextGuide).toBeDefined();
    expect(sendTextGuide!.body).toContain('submits it automatically');
    expect(sendTextGuide!.body).toContain('session_read_terminal');
  });

  it('exposes notification guide content via system skills', () => {
    const { service } = makeService();

    const notificationGuide = service.resolveSkill('notification');
    expect(notificationGuide).toBeDefined();
    expect(notificationGuide!.body).toContain('notify_user');
    expect(notificationGuide!.body).toContain('Routine progress');
    expect(notificationGuide!.body).toContain('toast');
    expect(notificationGuide!.body).toContain('bubble');
    expect(notificationGuide!.body).toContain('telegram');
    expect(notificationGuide!.body).toContain('none');
  });

  function makeSkillService(
    skillManager: SkillManager,
    projectIdForWork: string | undefined = 'project-1',
    skillAnalyticsManager?: SkillAnalyticsManager,
  ) {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: '/work',
    });
    const projectStore = {
      findByPath: vi.fn((path: string) =>
        path === '/work' && projectIdForWork
          ? { id: projectIdForWork, name: 'Project', canonicalPath: '/work' }
          : undefined),
      list: vi.fn(() => []),
    };
    return new HelmControlService(
      planManager as unknown as import('../src/session/plan-manager.js').PlanManager,
      sessionManager as unknown as import('../src/session/manager.js').SessionManager,
      ptyManager as unknown as import('../src/session/pty-manager.js').PtyManager,
      configLoader as unknown as import('../src/config/loader.js').ConfigLoader,
      undefined,
      undefined,
      undefined,
      projectStore as any,
      skillManager,
      skillAnalyticsManager,
    );
  }

  it('lists project-scoped and allProjects skills, excludes other-project skills, with type precedence', () => {
    const skillDir = mkdtempSync(join(tmpdir(), 'helm-skills-service-'));
    try {
      const skillManager = new SkillManager(join(skillDir, 'skills.yaml'));
      // Same type 'guide' on global + project-1 scoped → project-scoped overrides global for project-1.
      skillManager.create({ name: 'Global Guide', type: 'guide', allProjects: true, body: 'Global' });
      const scoped = skillManager.create({
        name: 'Project Guide',
        type: 'guide',
        allProjects: false,
        projectIds: ['project-1'],
        body: 'Scoped',
      });
      // Distinct type, allProjects → always applicable.
      const allProj = skillManager.create({
        name: 'Everywhere',
        type: 'everywhere',
        allProjects: true,
        body: 'Anywhere',
      });
      // Scoped to a different project → excluded for project-1.
      skillManager.create({
        name: 'Other Project',
        type: 'other',
        allProjects: false,
        projectIds: ['project-2'],
      });

      const service = makeSkillService(skillManager, 'project-1');
      const listed = service.listSkills({}, { sessionId: 's1', sessionName: 'Claude' });
      const names = listed.map((s) => s.name);

      expect(listed.map((s) => s.id)).toContain(scoped.id);
      expect(names).toContain('Everywhere');
      // Type precedence: project-scoped 'guide' overrides the global 'guide'.
      expect(names).not.toContain('Global Guide');
      // Other-project-only skill excluded.
      expect(names).not.toContain('Other Project');
      expect(listed.map((s) => s.id)).toContain(allProj.id);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it('returns an allProjects skill regardless of which project the session resolves to', () => {
    const skillDir = mkdtempSync(join(tmpdir(), 'helm-skills-allproj-'));
    try {
      const skillManager = new SkillManager(join(skillDir, 'skills.yaml'));
      const allProj = skillManager.create({ name: 'Everywhere', type: 'everywhere', allProjects: true, body: 'X' });

      for (const projectId of ['project-1', 'project-99', undefined]) {
        const service = makeSkillService(skillManager, projectId);
        const listed = service.listSkills({}, { sessionId: 's1', sessionName: 'Claude' });
        expect(listed.map((s) => s.id)).toContain(allProj.id);
      }
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it('returns each entry with exactly { id, name, triggerCondition } and no other fields', () => {
    const skillDir = mkdtempSync(join(tmpdir(), 'helm-skills-shape-'));
    try {
      const skillManager = new SkillManager(join(skillDir, 'skills.yaml'));
      const scoped = skillManager.create({
        name: 'Project Guide',
        description: 'Apply when reviewing project-1 code',
        type: 'guide',
        allProjects: false,
        projectIds: ['project-1'],
        body: 'Scoped body',
      });

      const service = makeSkillService(skillManager, 'project-1');
      const listed = service.listSkills({}, { sessionId: 's1', sessionName: 'Claude' });
      const entry = listed.find((s) => s.id === scoped.id)!;

      expect(Object.keys(entry).sort()).toEqual(['id', 'name', 'triggerCondition']);
      expect(entry.triggerCondition).toBe('Apply when reviewing project-1 code');
      for (const dropped of [
        'description', 'allProjects', 'projectIds', 'aiAmendable',
        'type', 'source', 'useCount', 'avgRating', 'reviewCount', 'body',
      ]) {
        expect(entry).not.toHaveProperty(dropped);
      }
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it('getSkill returns the full skill including body (detail lives in get, not list)', () => {
    const skillDir = mkdtempSync(join(tmpdir(), 'helm-skills-get-'));
    try {
      const skillManager = new SkillManager(join(skillDir, 'skills.yaml'));
      const created = skillManager.create({
        name: 'Project Guide',
        description: 'Apply when reviewing',
        type: 'guide',
        allProjects: false,
        projectIds: ['project-1'],
        body: 'Full body content here',
      });

      const service = makeSkillService(skillManager, 'project-1');
      const full = service.getSkill(created.id)!;

      expect(full.id).toBe(created.id);
      expect(full.body).toContain('Full body content here');
      expect(full.description).toBe('Apply when reviewing');
      expect(full.type).toBe('guide');
      expect(full.projectIds).toEqual(['project-1']);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it('appends a footer demanding an honest rating to user skills, but not to system skills', () => {
    const skillDir = mkdtempSync(join(tmpdir(), 'helm-skills-footer-'));
    try {
      const skillManager = new SkillManager(join(skillDir, 'skills.yaml'));
      const created = skillManager.create({ name: 'Guide', type: 'guide', allProjects: true, body: 'Do the thing' });
      const service = makeSkillService(skillManager);

      const footer = service.getSkill(created.id)!.body;
      expect(footer).toContain('skill_submit_feedback');
      // The footer must actively license a bad rating — polite inflation makes ratings useless.
      expect(footer).toContain('1 star');
      expect(footer).toContain('Do not be polite');
      expect(footer).toContain('improvement');

      // System skills are not user-owned, so they carry no rating prompt.
      expect(service.resolveSkill('startup')!.body).not.toContain('Do not be polite');
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it('reports review stats and clears reviews while preserving the use count', () => {
    const skillDir = mkdtempSync(join(tmpdir(), 'helm-skills-stats-'));
    try {
      const skillManager = new SkillManager(join(skillDir, 'skills.yaml'));
      const created = skillManager.create({ name: 'Guide', type: 'guide', allProjects: true, body: 'Do the thing' });
      const analytics = new SkillAnalyticsManager(join(skillDir, 'analytics.json'));
      const service = makeSkillService(skillManager, 'project-1', analytics);

      service.submitSkillFeedback(created.id, 1, 'Useless', 'Delete step 3', { sessionId: 's1' });
      service.submitSkillFeedback(created.id, 4, 'Mostly fine', undefined, { sessionId: 's1' });
      service.getSkill(created.id);

      const stats = service.getSkillStats(created.id);
      expect(stats).toMatchObject({ useCount: 1, avgRating: 2.5, reviewCount: 2 });
      expect(stats.reviews.map((r) => r.stars)).toEqual([1, 4]);
      expect(stats.reviews[0]!.improvement).toBe('Delete step 3');
      expect(stats.reviews[0]!.cliName).toBe('Claude');

      const cleared = service.clearSkillReviews(created.id);
      expect(cleared).toMatchObject({ useCount: 1, avgRating: 0, reviewCount: 0 });
      expect(cleared.reviews).toEqual([]);
      expect(service.getSkillStats(created.id).reviewCount).toBe(0);
    } finally {
      rmSync(skillDir, { recursive: true, force: true });
    }
  });
});

describe('HelmControlService.getPlan', () => {
  it('returns hasAttachments without inlining sequence data', () => {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    const plan = { id: 'plan-1', humanId: 'P-0001', dirPath: '/work', title: 'Task', description: 'Desc', status: 'ready', sequenceId: 'seq-1' };
    (planManager.getItem as ReturnType<typeof vi.fn>).mockReturnValue(plan);
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    const attachmentManager = {
      list: vi.fn(() => [{ id: 'a1', planId: 'plan-1', filename: 'note.txt', sizeBytes: 1, relativePath: 'plan-1/a1.txt', createdAt: 1, updatedAt: 1 }]),
      add: vi.fn(),
      delete: vi.fn(),
      getToTempFile: vi.fn(),
      deletePlanAttachments: vi.fn(),
    };
    const service = new HelmControlService(
      planManager as unknown as import('../src/session/plan-manager.js').PlanManager,
      sessionManager as unknown as import('../src/session/manager.js').SessionManager,
      ptyManager as unknown as import('../src/session/pty-manager.js').PtyManager,
      configLoader as unknown as import('../src/config/loader.js').ConfigLoader,
      attachmentManager as any,
    );

    const result = service.getPlan('P-0001') as any;

    expect(result.hasAttachments).toBe(true);
    expect(result.sequenceId).toBe('seq-1');
    expect(result.sequence).toBeUndefined();
    expect(result.sequenceMemoryGuide).toBeUndefined();
  });

  it('returns hasAttachments false when no attachments exist', () => {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    const plan = { id: 'plan-1', humanId: 'P-0001', dirPath: '/work', title: 'Task', description: 'Desc', status: 'ready' };
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    const attachmentManager = {
      list: vi.fn(() => []),
      add: vi.fn(),
      delete: vi.fn(),
      getToTempFile: vi.fn(),
      deletePlanAttachments: vi.fn(),
    };
    const service = new HelmControlService(
      planManager as unknown as import('../src/session/plan-manager.js').PlanManager,
      sessionManager as unknown as import('../src/session/manager.js').SessionManager,
      ptyManager as unknown as import('../src/session/pty-manager.js').PtyManager,
      configLoader as unknown as import('../src/config/loader.js').ConfigLoader,
      attachmentManager as any,
    );

    const result = service.getPlan('P-0001') as any;

    expect(result.hasAttachments).toBe(false);
  });

  it('returns hasAttachments true after adding an attachment', () => {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    const plan = { id: 'plan-1', humanId: 'P-0001', dirPath: '/work', title: 'Task', description: 'Desc', status: 'ready' };
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    const attachments = [{ id: 'a1', planId: 'plan-1', filename: 'note.txt', sizeBytes: 5, relativePath: 'plan-1/a1.txt', createdAt: 1, updatedAt: 1 }];
    const attachmentManager = {
      list: vi.fn(() => attachments),
      add: vi.fn(),
      delete: vi.fn(),
      getToTempFile: vi.fn(),
      deletePlanAttachments: vi.fn(),
    };
    const service = new HelmControlService(
      planManager as unknown as import('../src/session/plan-manager.js').PlanManager,
      sessionManager as unknown as import('../src/session/manager.js').SessionManager,
      ptyManager as unknown as import('../src/session/pty-manager.js').PtyManager,
      configLoader as unknown as import('../src/config/loader.js').ConfigLoader,
      attachmentManager as any,
    );

    const result = service.getPlan('P-0001') as any;

    expect(result.hasAttachments).toBe(true);
    expect(attachmentManager.list).toHaveBeenCalledWith('plan-1');
  });

  it('does not include sequence key even when plan has sequenceId', () => {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    const plan = { id: 'plan-1', humanId: 'P-0001', dirPath: '/work', title: 'Task', description: 'Desc', status: 'ready', sequenceId: 'seq-1' };
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    const attachmentManager = {
      list: vi.fn(() => []),
      add: vi.fn(),
      delete: vi.fn(),
      getToTempFile: vi.fn(),
      deletePlanAttachments: vi.fn(),
    };
    const service = new HelmControlService(
      planManager as unknown as import('../src/session/plan-manager.js').PlanManager,
      sessionManager as unknown as import('../src/session/manager.js').SessionManager,
      ptyManager as unknown as import('../src/session/pty-manager.js').PtyManager,
      configLoader as unknown as import('../src/config/loader.js').ConfigLoader,
      attachmentManager as any,
    );

    const result = service.getPlan('P-0001') as any;

    expect(Object.prototype.hasOwnProperty.call(result, 'sequenceId')).toBe(true);
    expect(result.sequenceId).toBe('seq-1');
    expect(Object.prototype.hasOwnProperty.call(result, 'sequence')).toBe(false);
  });

  it('includes lightweight context metadata when the plan has bound or inherited contexts', () => {
    const { service, planManager } = makeService();
    const plan = {
      id: 'plan-1',
      humanId: 'P-0001',
      dirPath: '/work',
      title: 'Task',
      description: 'Desc',
      status: 'ready',
      sequenceId: 'seq-1',
      projectId: 'project-1',
      createdAt: 1,
      updatedAt: 1,
    };
    (planManager.getItem as ReturnType<typeof vi.fn>).mockReturnValue(plan);
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    (planManager as any).getSequence = vi.fn((id: string) => id === 'seq-1'
      ? { id: 'seq-1', projectId: 'project-1', dirPath: '/work', title: 'Sequence', missionStatement: '', sharedMemory: '', order: 0, createdAt: 1, updatedAt: 1 }
      : null);
    (planManager.getForDirectory as ReturnType<typeof vi.fn>).mockReturnValue([plan]);
    (planManager.exportAll as ReturnType<typeof vi.fn>).mockReturnValue({
      '/work': {
        dirPath: '/work',
        items: [plan],
        dependencies: [],
        sequences: [{ id: 'seq-1', projectId: 'project-1', dirPath: '/work', title: 'Sequence', missionStatement: '', sharedMemory: '', order: 0, createdAt: 1, updatedAt: 1 }],
      },
    });

    const contextManager = (service as any).contextManager;
    const seqContext = contextManager.create('project-1', { title: 'Testing Strategy', type: 'Testing', permission: 'readonly' });
    const planContext = contextManager.create('project-1', { title: 'Scratchpad', type: 'Coding', permission: 'writable' });
    contextManager.bind(seqContext.id, 'sequence', 'seq-1');
    contextManager.bind(planContext.id, 'plan', 'plan-1');

    const result = service.getPlan('P-0001') as any;

    expect(result.sequenceContextMetadata).toEqual([
      { id: planContext.id, title: 'Scratchpad', type: 'Coding', permission: 'writable' },
      { id: seqContext.id, title: 'Testing Strategy', type: 'Testing', permission: 'readonly' },
    ]);
  });
});

describe('HelmControlService.readSessionTerminal', () => {
  it('returns terminal tail metadata and clamps line count', () => {
    const { service, ptyManager, sessionManager } = makeService();
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: '/work',
    });

    const result = service.readSessionTerminal('s1', 120, 'both');

    expect(ptyManager.getTerminalTail).toHaveBeenCalledWith('s1', 120, 'both', false);
    expect(result).toEqual({
      sessionId: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      cliTypeName: 'claude-code',
      workingDir: '/work',
      returnedLines: 1,
      ptyRunning: true,
      lastOutputAt: 1234,
      raw: ['\x1b[31mraw\x1b[0m'],
      stripped: ['raw'],
    });
  });

  it('rejects invalid line counts', () => {
    const { service } = makeService();
    expect(() => service.readSessionTerminal('s1', 0, 'raw')).toThrow('lines must be a positive integer');
  });
});

describe('HelmControlService plan attachments', () => {
  it('reads file from filePath and passes basename + content to attachment manager', () => {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    const plan = { id: 'plan-1', humanId: 'P-0001', dirPath: '/work', title: 'Task', description: 'Desc', status: 'ready' };
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    const attachmentManager = {
      list: vi.fn(() => []),
      add: vi.fn((_planId: string, input: { filename: string; content: Buffer; contentType?: string }) => ({
        id: 'a1',
        planId: 'plan-1',
        filename: input.filename,
        sizeBytes: input.content.byteLength,
        relativePath: 'plan-1/a1.txt',
        createdAt: 1,
        updatedAt: 1,
      })),
      delete: vi.fn(() => true),
      getToTempFile: vi.fn(),
      deletePlanAttachments: vi.fn(),
    };
    const service = new HelmControlService(
      planManager as unknown as import('../src/session/plan-manager.js').PlanManager,
      sessionManager as unknown as import('../src/session/manager.js').SessionManager,
      ptyManager as unknown as import('../src/session/pty-manager.js').PtyManager,
      configLoader as unknown as import('../src/config/loader.js').ConfigLoader,
      attachmentManager as any,
    );

    const tempDir = mkdtempSync(join(tmpdir(), 'helm-att-'));
    const tmpFile = join(tempDir, 'note.txt');
    writeFileSync(tmpFile, 'hello world');
    try {
      const attachment = service.addPlanAttachment('P-0001', {
        filePath: tmpFile,
        contentType: 'text/plain',
      });

      expect(attachmentManager.add).toHaveBeenCalledWith('plan-1', {
        filename: 'note.txt',
        content: Buffer.from('hello world'),
        contentType: 'text/plain',
      });
      expect(attachment.id).toBe('a1');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects text input with clear error', () => {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    const plan = { id: 'plan-1', humanId: 'P-0001', dirPath: '/work', title: 'Task', description: 'Desc', status: 'ready' };
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    const attachmentManager = {
      list: vi.fn(() => []), add: vi.fn(), delete: vi.fn(() => true),
      getToTempFile: vi.fn(), deletePlanAttachments: vi.fn(),
    };
    const service = new HelmControlService(
      planManager as any, sessionManager as any, ptyManager as any, configLoader as any, attachmentManager as any,
    );

    expect(() => service.addPlanAttachment('P-0001', {
      filePath: '/some/file.txt',
      text: 'hello',
    } as any)).toThrow('text is no longer accepted');
  });

  it('rejects contentBase64 input with clear error', () => {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    const plan = { id: 'plan-1', humanId: 'P-0001', dirPath: '/work', title: 'Task', description: 'Desc', status: 'ready' };
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    const attachmentManager = {
      list: vi.fn(() => []), add: vi.fn(), delete: vi.fn(() => true),
      getToTempFile: vi.fn(), deletePlanAttachments: vi.fn(),
    };
    const service = new HelmControlService(
      planManager as any, sessionManager as any, ptyManager as any, configLoader as any, attachmentManager as any,
    );

    expect(() => service.addPlanAttachment('P-0001', {
      filePath: '/some/file.txt',
      contentBase64: Buffer.from('hello').toString('base64'),
    } as any)).toThrow('contentBase64 is no longer accepted');
  });

  it('rejects relative filePath', () => {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    const plan = { id: 'plan-1', humanId: 'P-0001', dirPath: '/work', title: 'Task', description: 'Desc', status: 'ready' };
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    const attachmentManager = {
      list: vi.fn(() => []), add: vi.fn(), delete: vi.fn(() => true),
      getToTempFile: vi.fn(), deletePlanAttachments: vi.fn(),
    };
    const service = new HelmControlService(
      planManager as any, sessionManager as any, ptyManager as any, configLoader as any, attachmentManager as any,
    );

    expect(() => service.addPlanAttachment('P-0001', {
      filePath: 'relative/file.txt',
    })).toThrow('absolute path');
  });

  it('rejects nonexistent filePath', () => {
    const { planManager, sessionManager, ptyManager, configLoader } = makeService();
    const plan = { id: 'plan-1', humanId: 'P-0001', dirPath: '/work', title: 'Task', description: 'Desc', status: 'ready' };
    (planManager.resolveItemRef as ReturnType<typeof vi.fn>).mockReturnValue({ status: 'found', item: plan });
    const attachmentManager = {
      list: vi.fn(() => []), add: vi.fn(), delete: vi.fn(() => true),
      getToTempFile: vi.fn(), deletePlanAttachments: vi.fn(),
    };
    const service = new HelmControlService(
      planManager as any, sessionManager as any, ptyManager as any, configLoader as any, attachmentManager as any,
    );

    expect(() => service.addPlanAttachment('P-0001', {
      filePath: '/nonexistent/path/file.txt',
    })).toThrow();
  });
});

describe('HelmControlService telegram channels', () => {
  it('reports Telegram availability without exposing secrets', () => {
    const { service } = makeService();
    service.setTelegramBridge({
      isRunning: vi.fn(() => true),
      listChannels: vi.fn(() => [{ id: 'tc1', sessionId: 's1', sessionName: 'Claude', status: 'open', createdAt: 1, updatedAt: 1 }]),
      createChannel: vi.fn(),
      closeChannel: vi.fn(),
      sendToUser: vi.fn(),
    });

    const status = service.getTelegramStatus();

    expect(status).toMatchObject({
      enabled: true,
      configured: true,
      running: true,
      available: true,
      openChannels: 1,
    });
    expect(JSON.stringify(status)).not.toContain('botToken');
  });

  it('sends mobile-friendly messages through the bridge via sendTelegramChat', async () => {
    const { service, sessionManager } = makeService();
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: '/work',
    });
    const bridge = {
      isRunning: vi.fn(() => true),
      listChannels: vi.fn(() => []),
      closeChannel: vi.fn(),
      sendToUser: vi.fn(async () => ({ sent: true })),
    };
    service.setTelegramBridge(bridge);

    const result = await service.sendTelegramChat('s1', 'Need a quick decision?');

    expect(bridge.sendToUser).toHaveBeenCalledWith({ sessionId: 's1', text: 'Need a quick decision?' });
    expect(result.sent).toBe(true);
  });

  it('routes telegram by session ID only, never by name', async () => {
    const { service, sessionManager } = makeService();
    // getSession resolves the UUID only; a session name does not resolve to a session.
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockImplementation((ref: string) =>
      ref === 's1' ? { id: 's1', name: 'dup-name', cliType: 'claude-code', workingDir: '/work' } : undefined,
    );
    const bridge = {
      isRunning: vi.fn(() => true),
      listChannels: vi.fn(() => []),
      closeChannel: vi.fn(),
      sendToUser: vi.fn(async () => ({ sent: true })),
    };
    service.setTelegramBridge(bridge);

    const byId = await service.sendTelegramChat('s1', 'by id');
    expect(byId.sent).toBe(true);
    expect(bridge.sendToUser).toHaveBeenCalledWith({ sessionId: 's1', text: 'by id' });

    // Passing a name must NOT route anywhere — it is rejected, never resolved.
    const byName = await service.sendTelegramChat('dup-name', 'by name');
    expect(byName.sent).toBe(false);
    expect(byName.reason).toContain('not found by ID');
  });

  it('rejects wide messages in sendTelegramChat', async () => {
    const { service } = makeService();

    service.setTelegramBridge({
      isRunning: vi.fn(() => true),
      listChannels: vi.fn(() => []),
      closeChannel: vi.fn(),
      sendToUser: vi.fn(),
    });

    await expect(service.sendTelegramChat('s1', 'x'.repeat(141))).rejects.toThrow('140 characters');
  });

  it('rejects non-existent files in sendTelegramChat before bridge delivery', async () => {
    const { service, sessionManager } = makeService();
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: '/work',
    });
    const bridge = {
      isRunning: vi.fn(() => true),
      listChannels: vi.fn(() => []),
      closeChannel: vi.fn(),
      sendToUser: vi.fn(async () => ({ sent: true })),
    };
    service.setTelegramBridge(bridge);

    const result = await service.sendTelegramChat('s1', 'see attached', '/nonexistent/file.txt');

    expect(result.sent).toBe(false);
    expect(result.reason).toContain('File not found');
    expect(bridge.sendToUser).not.toHaveBeenCalled();
  });

  it('getAvailableTools lists exactly 4 telegram tools and no removed tools', () => {
    const tools = getAvailableTools() as Array<{ name: string }>;
    const tgTools = tools.filter((t: { name: string }) => t.name.startsWith('telegram_'));

    expect(tgTools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['telegram_status', 'telegram_chat', 'telegram_send_voice', 'telegram_channel_close']),
    );
    expect(tgTools).toHaveLength(4);

    // Removed tools must NOT be present
    const removedToolNames = ['telegram_send', 'telegram_set_output_mode', 'telegram_channel_create', 'telegram_channel_list'];
    const allToolNames = tools.map((t: { name: string }) => t.name);
    for (const removed of removedToolNames) {
      expect(allToolNames).not.toContain(removed);
    }
  });
});

describe('HelmControlService LLM notifications', () => {
  it('routes notifyUser through NotificationManager using session refs', () => {
    const { service, sessionManager } = makeService();
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
      workingDir: '/work',
    });
    const notificationManager = {
      notifyLlmDirected: vi.fn(() => 'bubble'),
      getAppVisibilityDetails: vi.fn(() => ({ visibility: 'visible-focused', screenLocked: false, activeSessionId: 's2' })),
    };
    service.setNotificationManager(notificationManager as any);

    expect(service.notifyUser('s1', 'Need input', 'Please choose one')).toEqual({ delivered: 'bubble' });
    expect(notificationManager.notifyLlmDirected).toHaveBeenCalledWith('s1', 'Need input', 'Please choose one');
    expect(service.getAppVisibility()).toEqual({ visibility: 'visible-focused', screenLocked: false, activeSessionId: 's2' });
  });
});

describe('HelmControlService.closeSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the session from SessionManager when given a valid sessionId', () => {
    const { service, ptyManager, sessionManager } = makeService();
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
    });

    const result = service.closeSession('s1');

    expect(ptyManager.kill).toHaveBeenCalledWith('s1');
    expect(sessionManager.removeSession).toHaveBeenCalledWith('s1');
    expect(result).toEqual({ ok: true });
  });

  it('accepts both sessionId and session name', () => {
    const { service, ptyManager, sessionManager } = makeService();
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', name: 'Claude', cliType: 'claude-code' },
    ]);

    const result = service.closeSession('Claude');

    expect(ptyManager.kill).toHaveBeenCalledWith('s1');
    expect(sessionManager.removeSession).toHaveBeenCalledWith('s1');
    expect(result).toEqual({ ok: true });
  });

  it('throws when session not found', () => {
    const { service, sessionManager } = makeService();
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);

    expect(() => service.closeSession('nonexistent')).toThrow('Session not found: nonexistent');
  });

  it('continues if ptyManager.kill() throws an error', () => {
    const { service, ptyManager, sessionManager } = makeService();
    const killError = new Error('PTY kill failed');
    (ptyManager.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw killError;
    });
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 's1',
      name: 'Claude',
      cliType: 'claude-code',
    });

    const result = service.closeSession('s1');

    expect(sessionManager.removeSession).toHaveBeenCalledWith('s1');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to kill PTY for session s1:'),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('HelmControlService.restartHelm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves sessions by default so they resume after relaunch', () => {
    const { service, ptyManager, sessionManager } = makeService();
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', name: 'One', cliType: 'claude-code' },
      { id: 's2', name: 'Two', cliType: 'codex' },
    ]);
    const listener = vi.fn();
    service.on('restart-requested', listener);

    expect(service.restartHelm()).toEqual({ sessionsClosed: 0, resume: true });
    expect(ptyManager.kill).not.toHaveBeenCalled();
    expect(sessionManager.removeSession).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('closes all sessions, emits restart-requested, and returns the closed count when resume is false', () => {
    const { service, ptyManager, sessionManager } = makeService();
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', name: 'One', cliType: 'claude-code' },
      { id: 's2', name: 'Two', cliType: 'codex' },
      { id: 's3', name: 'Three', cliType: 'copilot' },
    ]);
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockImplementation((id: string) => ({
      id,
      name: id,
      cliType: 'claude-code',
    }));
    const listener = vi.fn();
    service.on('restart-requested', listener);

    expect(service.restartHelm(false)).toEqual({ sessionsClosed: 3, resume: false });
    expect(ptyManager.kill).toHaveBeenCalledWith('s1');
    expect(ptyManager.kill).toHaveBeenCalledWith('s2');
    expect(ptyManager.kill).toHaveBeenCalledWith('s3');
    expect(sessionManager.removeSession).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('emits restart-requested when there are no sessions', () => {
    const { service, sessionManager } = makeService();
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const listener = vi.fn();
    service.on('restart-requested', listener);

    expect(service.restartHelm(false)).toEqual({ sessionsClosed: 0, resume: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('continues closing sessions when one close fails', () => {
    const { service, ptyManager, sessionManager } = makeService();
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's1', name: 'One', cliType: 'claude-code' },
      { id: 'missing', name: 'Missing', cliType: 'codex' },
      { id: 's3', name: 'Three', cliType: 'copilot' },
    ]);
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (
      id === 'missing' ? null : { id, name: id, cliType: 'claude-code' }
    ));
    const listener = vi.fn();
    service.on('restart-requested', listener);

    expect(service.restartHelm(false)).toEqual({ sessionsClosed: 2, resume: false });
    expect(ptyManager.kill).toHaveBeenCalledWith('s1');
    expect(ptyManager.kill).toHaveBeenCalledWith('s3');
    expect(sessionManager.removeSession).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to close session missing during restart'));
  });

  it('emits restart-requested exactly once per call', () => {
    const { service, sessionManager } = makeService();
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const listener = vi.fn();
    service.on('restart-requested', listener);

    service.restartHelm();
    service.restartHelm();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('creates a one-shot direct self-resume task before emitting restart-requested when a resumePrompt is given', () => {
    const schedulerManager = { createTask: vi.fn((_params: unknown) => ({ id: 'task-1' })) };
    const { service, sessionManager } = makeService(schedulerManager);
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'caller-1',
      name: 'Caller',
      cliType: 'claude-code',
      workingDir: '/work',
    });
    const listener = vi.fn();
    service.on('restart-requested', listener);

    const before = Date.now();
    const result = service.restartHelm(true, { callerSessionId: 'caller-1', resumePrompt: 'Continue the deploy.' });

    expect(result).toEqual({ sessionsClosed: 0, resume: true, resumeTaskId: 'task-1' });
    expect(schedulerManager.createTask).toHaveBeenCalledTimes(1);
    const params = schedulerManager.createTask.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({
      title: 'Restart self-resume',
      initialPrompt: 'Continue the deploy.',
      cliType: '',
      dirPath: '/work',
      mode: 'direct',
      targetSessionId: 'caller-1',
    });
    const fireAt = new Date(params.scheduledTime as string).getTime();
    expect(fireAt).toBeGreaterThanOrEqual(before + 90_000);
    expect(fireAt).toBeLessThanOrEqual(Date.now() + 150_000);
    // The task must exist before the restart cuts the process down.
    expect(schedulerManager.createTask.mock.invocationCallOrder[0]).toBeLessThan(listener.mock.invocationCallOrder[0]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects a resumePrompt when resume is false — the caller session is closed and cannot be re-prompted', () => {
    const schedulerManager = { createTask: vi.fn() };
    const { service } = makeService(schedulerManager);
    const listener = vi.fn();
    service.on('restart-requested', listener);

    expect(() => service.restartHelm(false, { callerSessionId: 'caller-1', resumePrompt: 'Continue.' }))
      .toThrow('resumePrompt requires resume:true');
    expect(schedulerManager.createTask).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects a resumePrompt without a caller session identity', () => {
    const schedulerManager = { createTask: vi.fn() };
    const { service } = makeService(schedulerManager);
    const listener = vi.fn();
    service.on('restart-requested', listener);

    expect(() => service.restartHelm(true, { resumePrompt: 'Continue.' }))
      .toThrow('callerSessionId is required');
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects a resumePrompt when the caller session cannot be found, before restarting', () => {
    const schedulerManager = { createTask: vi.fn() };
    const { service, sessionManager } = makeService(schedulerManager);
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const listener = vi.fn();
    service.on('restart-requested', listener);

    expect(() => service.restartHelm(true, { callerSessionId: 'ghost', resumePrompt: 'Continue.' }))
      .toThrow('Session not found: ghost');
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects a resumePrompt when the scheduler is unavailable, before restarting', () => {
    const { service, sessionManager } = makeService();
    (sessionManager.getAllSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'caller-1', name: 'Caller', cliType: 'claude-code', workingDir: '/work',
    });
    const listener = vi.fn();
    service.on('restart-requested', listener);

    expect(() => service.restartHelm(true, { callerSessionId: 'caller-1', resumePrompt: 'Continue.' }))
      .toThrow('Scheduler is not available');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('HelmControlService.sendTextToSession — helmPreambleForInterSession toggle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sendTextToSession with preamble enabled (default)', async () => {
    const { service, ptyManager, configLoader } = makeService();
    // Recipient tool config absent helmPreambleForInterSession field — defaults to true
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'Claude Code',
      spawnCommand: 'claude',
      // helmPreambleForInterSession is undefined, should default to true
    });

    const result = await service.sendTextToSession('s1', 'hello', {
      senderSessionId: 'sender1',
      senderSessionName: 'Sender',
    });

    expect(result.preambleUsed).toBe(true);
    const deliverCall = (ptyManager.deliverText as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = deliverCall[1] as string;
    expect(message).toMatch(/^\[HELM_MSG\]/);
    expect(message).toContain('"type":"inter_llm_message"');
    expect(message).toContain('hello');
  });

  it('sendTextToSession with preamble enabled (explicit true)', async () => {
    const { service, ptyManager, configLoader } = makeService();
    // Recipient tool config has helmPreambleForInterSession: true
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'Claude Code',
      spawnCommand: 'claude',
      helmPreambleForInterSession: true,
    });

    const result = await service.sendTextToSession('s1', 'hello', {
      senderSessionId: 'sender1',
      senderSessionName: 'Sender',
    });

    expect(result.preambleUsed).toBe(true);
    const deliverCall = (ptyManager.deliverText as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = deliverCall[1] as string;
    expect(message).toMatch(/^\[HELM_MSG\]/);
    expect(message).toContain('"type":"inter_llm_message"');
    expect(message).toContain('hello');
  });

  it('sendTextToSession with preamble disabled', async () => {
    const { service, ptyManager, configLoader } = makeService();
    // Recipient tool config has helmPreambleForInterSession: false
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'Claude Code',
      spawnCommand: 'claude',
      helmPreambleForInterSession: false,
    });

    const result = await service.sendTextToSession('s1', 'hello from sender', {
      senderSessionId: 'sender1',
      senderSessionName: 'Sender',
    });

    expect(result.preambleUsed).toBe(false);
    expect(configLoader.getCliTypeEntry).toHaveBeenCalledWith('claude-code');
    const deliverCall = (ptyManager.deliverText as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = deliverCall[1] as string;
    // Submit suffix is now sent via ptyManager.deliverText with submitSuffix option
    expect(message).toBe('hello from sender');
    expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
    expect(message).not.toMatch(/^\[HELM_MSG\]/);
    expect(message).not.toContain('inter_llm_message');
  });

  it('sendTextToSession preamble=false respects text content exactly', async () => {
    const { service, ptyManager, configLoader } = makeService();
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      helmPreambleForInterSession: false,
    });

    const multilineText = 'Line 1\nLine 2\nSpecial chars: $, %, &, @';
    const result = await service.sendTextToSession('s1', multilineText, {
      senderSessionId: 'sender1',
      senderSessionName: 'Sender',
    });

    expect(result.preambleUsed).toBe(false);
    const deliverCall = (ptyManager.deliverText as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = deliverCall[1] as string;
    // Submit suffix is now sent via ptyManager.deliverText with submitSuffix option
    expect(message).toBe(multilineText);
    expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
  });

  it('sendTextToSession preamble=true includes sender info in envelope', async () => {
    const { service, ptyManager, configLoader } = makeService();
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      helmPreambleForInterSession: true,
    });

    await service.sendTextToSession('s1', 'test', {
      senderSessionId: 'agent-1',
      senderSessionName: 'Research Agent',
      expectsResponse: true,
    });

    const deliverCall = (ptyManager.deliverText as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = deliverCall[1] as string;
    const envelopeMatch = message.match(/^\[HELM_MSG[^\]]*\](\{[^\n}]*\})/);
    expect(envelopeMatch).toBeTruthy();
    const envelope = JSON.parse(envelopeMatch![1]);
    expect(envelope.fromSessionId).toBe('agent-1');
    expect(envelope.fromSessionName).toBe('Research Agent');
    expect(envelope.expectsResponse).toBe(true);
  });

  it('sendTextToSession returns correct preambleUsed value in both cases', async () => {
    const { service, configLoader } = makeService();

    // Test with preamble disabled
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      helmPreambleForInterSession: false,
    });
    const noPreambleResult = await service.sendTextToSession('s1', 'msg', {
      senderSessionId: 'sender1',
      senderSessionName: 'Sender',
    });
    expect(noPreambleResult).toMatchObject({
      ok: true,
      preambleUsed: false,
    });

    // Test with preamble enabled
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      helmPreambleForInterSession: true,
    });
    const preambleResult = await service.sendTextToSession('s1', 'msg', {
      senderSessionId: 'sender1',
      senderSessionName: 'Sender',
    });
    expect(preambleResult).toMatchObject({
      ok: true,
      preambleUsed: true,
    });
  });

  it('sendTextToSession with preamble=false does not include expectsResponse in text', async () => {
    const { service, ptyManager, configLoader } = makeService();
    (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      helmPreambleForInterSession: false,
    });

    await service.sendTextToSession('s1', 'check status', {
      senderSessionId: 'sender1',
      senderSessionName: 'Sender',
      expectsResponse: true,
    });

    const deliverCall = (ptyManager.deliverText as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = deliverCall[1] as string;
    // Without preamble, plain text — submit goes through ptyManager.deliverText
    expect(message).toBe('check status');
    expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
    expect(message).not.toContain('expectsResponse');
  });
});

// =============================================================================
// parseSubmitSuffix — escape sequence parsing for submit behavior
// =============================================================================

describe('parseSubmitSuffix', () => {
  describe('escape sequence parsing', () => {
    it('converts escape notation \\r to CR character', () => {
      expect(parseSubmitSuffix('\\r')).toBe('\r');
    });

    it('converts escape notation \\n to LF character', () => {
      expect(parseSubmitSuffix('\\n')).toBe('\n');
    });

    it('converts escape notation \\t to TAB character', () => {
      expect(parseSubmitSuffix('\\t')).toBe('\t');
    });

    it('converts escape notation \\r\\n to CRLF sequence', () => {
      expect(parseSubmitSuffix('\\r\\n')).toBe('\r\n');
    });

    it('handles mixed sequences like \\r\\n\\r (passthrough)', () => {
      // Only exact matches for \\r, \\n, \\t, \\r\\n are parsed.
      // \\r\\n\\r is not an exact match, so it passes through as-is.
      expect(parseSubmitSuffix('\\r\\n\\r')).toBe('\\r\\n\\r');
    });
  });

  describe('default behavior', () => {
    it('returns CR character when suffix is undefined', () => {
      expect(parseSubmitSuffix()).toBe('\r');
    });

    it('returns CR character when suffix is empty string', () => {
      expect(parseSubmitSuffix('')).toBe('\r');
    });

    it('returns CR character when suffix is null (falsy)', () => {
      expect(parseSubmitSuffix(null as unknown as string)).toBe('\r');
    });

    it('passes through whitespace-only string (not empty/falsy)', () => {
      // parseSubmitSuffix checks 'if (!suffix)', which is falsy check.
      // Whitespace-only string '   ' is truthy, so it passes through.
      expect(parseSubmitSuffix('   ')).toBe('   ');
    });
  });

  describe('edge cases', () => {
    it('passes through unrecognized strings as-is', () => {
      expect(parseSubmitSuffix('foo')).toBe('foo');
    });

    it('passes through arbitrary text without parsing', () => {
      expect(parseSubmitSuffix('hello world')).toBe('hello world');
    });

    it('preserves backslash in non-recognized sequences', () => {
      expect(parseSubmitSuffix('\\x')).toBe('\\x');
    });

    it('does not parse sequences inside larger strings', () => {
      // Only exact matches are parsed, e.g. just '\\r', not 'prefix\\rsuffix'
      expect(parseSubmitSuffix('prefix\\r')).toBe('prefix\\r');
    });

    it('differentiates between \\r and \\r\\n', () => {
      const cr = parseSubmitSuffix('\\r');
      const crlf = parseSubmitSuffix('\\r\\n');
      expect(cr).not.toBe(crlf);
      expect(cr).toBe('\r');
      expect(crlf).toBe('\r\n');
    });

    it('is case-sensitive (does not parse \\R as CR)', () => {
      expect(parseSubmitSuffix('\\R')).toBe('\\R');
    });

    it('handles actual control characters in input', () => {
      // If someone passes an actual CR character, it should pass through
      expect(parseSubmitSuffix('\r')).toBe('\r');
    });

    it('handles actual LF character in input', () => {
      expect(parseSubmitSuffix('\n')).toBe('\n');
    });

    it('handles actual TAB character in input', () => {
      expect(parseSubmitSuffix('\t')).toBe('\t');
    });

    it('handles actual CRLF sequence in input', () => {
      expect(parseSubmitSuffix('\r\n')).toBe('\r\n');
    });
  });

  describe('idempotency and stability', () => {
    it('returns consistent results for the same input', () => {
      const input = '\\r';
      expect(parseSubmitSuffix(input)).toBe(parseSubmitSuffix(input));
    });

    it('parsing twice does not change the result', () => {
      // First parse: '\\r' → '\r'
      const firstParse = parseSubmitSuffix('\\r');
      // Second parse: '\r' → '\r' (passthrough, not a recognized escape sequence)
      const secondParse = parseSubmitSuffix(firstParse);
      expect(secondParse).toBe('\r');
    });
  });

  describe('integration with sendTextToSession', () => {
    it('parseSubmitSuffix is used by sendTextToSession to determine submit behavior', async () => {
      const { service, ptyManager, configLoader } = makeService();
      (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
        submitSuffix: '\\n',
      });

      await service.sendTextToSession('s1', 'command', {
        senderSessionId: 'sender1',
        senderSessionName: 'Sender',
      });

      // Should have called ptyManager.deliverText with LF (\n) as the submit suffix, not CR (\r)
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('command'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\n' });
    });

    it('sendTextToSession defaults to CR when no submitSuffix is configured', async () => {
      const { service, ptyManager, configLoader } = makeService();
      (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({});

      await service.sendTextToSession('s1', 'command', {
        senderSessionId: 'sender1',
        senderSessionName: 'Sender',
      });

      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', expect.stringContaining('command'));
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\r' });
    });

    it('sendTextToSession with preamble=false also uses parseSubmitSuffix', async () => {
      const { service, ptyManager, configLoader } = makeService();
      (configLoader.getCliTypeEntry as ReturnType<typeof vi.fn>).mockReturnValue({
        helmPreambleForInterSession: false,
        submitSuffix: '\\r\\n',
      });

      await service.sendTextToSession('s1', 'command', {
        senderSessionId: 'sender1',
        senderSessionName: 'Sender',
      });

      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', 'command');
      expect(ptyManager.deliverText).toHaveBeenCalledWith('s1', '', { submitSuffix: '\r\n' });
    });
  });
});

describe('HelmControlService artifact session ownership', () => {
  it('blocks a session from reading, updating, revealing, or deleting another session\'s artifact', async () => {
    const { ArtifactManager } = await import('../src/session/artifact-manager.js');
    const { service } = makeService();
    const artifacts = new ArtifactManager();
    service.setArtifactManager(artifacts);

    // Session A owns an artifact; session B must not touch it by id.
    const owned = service.createArtifact('sessA', 'Report', 'markdown', 'v1 body');

    // Owner still works.
    expect(service.getArtifact('sessA', owned.id).id).toBe(owned.id);
    expect(service.updateArtifact('sessA', owned.id, 'v2 body').versions).toHaveLength(2);

    // Cross-session access is denied with an existence-preserving "not found".
    expect(() => service.getArtifact('sessB', owned.id)).toThrow('Artifact not found');
    expect(() => service.updateArtifact('sessB', owned.id, 'hijack')).toThrow('Artifact not found');
    expect(() => service.showArtifact('sessB', owned.id)).toThrow('Artifact not found');
    expect(() => service.deleteArtifact('sessB', owned.id)).toThrow('Artifact not found');

    // The artifact was never mutated by the rejected calls.
    expect(service.getArtifact('sessA', owned.id).versions).toHaveLength(2);
  });
});
