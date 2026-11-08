import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';
import { ProfileRuntimeComposition } from '../src/electron/profile-runtime-composition.js';
import { registerProfileSessionCleanup } from '../src/electron/profile-session-cleanup.js';
import { ApiSessionHost } from '../src/session/api/api-session-host.js';
import { formatManifestoContext } from '../src/session/artifact-context.js';
import { appendSessionTodoContext } from '../src/session/todo-context.js';
import { ChatBroker } from '../src/session/chat/chat-broker.js';
import type { ChatOutboundMessage } from '../src/session/chat/chat-bridge.js';
import { ComfyUiSessionHost } from '../src/session/comfyui/comfyui-session-host.js';
import { cloneDefaultComfyUiConfigForKind } from '../src/session/comfyui/comfyui-config.js';
import { HandoverDelivery } from '../src/session/handover-delivery.js';
import { HookReceiver } from '../src/session/hooks/hook-receiver.js';
import { PtyManager } from '../src/session/pty-manager.js';
import { StateDetector } from '../src/session/state-detector.js';
import { getProfileConfigDir } from '../src/utils/app-paths.js';

const roots: string[] = [];

function makeRoot(): string {
  const value = mkdtempSync(join(tmpdir(), 'helm-profile-ownership-'));
  roots.push(value);
  return value;
}

function write(configDir: string, relativePath: string, contents: string): void {
  const fullPath = join(configDir, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, contents);
}

function makeComposition(options: { p1CliTypes?: unknown; p2CliTypes?: unknown } = {}) {
  const appData = makeRoot();
  const globalConfigDir = join(appData, 'Helm', 'config');
  const p1ConfigDir = getProfileConfigDir('1', appData);
  const p2ConfigDir = getProfileConfigDir('2', appData);
  write(globalConfigDir, 'settings.yaml', '{}\n');
  write(p1ConfigDir, 'cli-types.yaml', YAML.stringify(options.p1CliTypes ?? {
    claude: { name: 'Claude', displayName: 'Claude', provider: 'claude', noPromptCache: true },
    test: { name: 'Test', displayName: 'Test' },
  }));
  write(p2ConfigDir, 'cli-types.yaml', YAML.stringify(options.p2CliTypes ?? {
    claude: { name: 'Claude', displayName: 'Claude', provider: 'claude', cacheWarnMinutes: 1, cacheExpireMinutes: 60 },
    test: { name: 'Test', displayName: 'Test' },
  }));
  const profiles = new UserProfileStore(globalConfigDir);
  writeFileSync(profiles.filePath, YAML.stringify({ version: 1, profiles: [
    { id: '1', name: 'One', pinHash: null },
    { id: '2', name: 'Two', pinHash: null },
  ] }));
  const configLoader = new ConfigLoader({
    userProfileId: '1', profileConfigDir: p1ConfigDir, globalConfigDir,
  });
  const ptyManager = new PtyManager();
  ptyManager.has = () => true;
  ptyManager.nudgeResize = async () => undefined;
  ptyManager.deliverText = async () => undefined;
  ptyManager.write = () => true;
  const composition = new ProfileRuntimeComposition({ configLoader, userProfileStore: profiles, ptyManager });
  return { appData, p1ConfigDir, p2ConfigDir, composition, ptyManager };
}

function addSession(composition: ProfileRuntimeComposition, profileId: string, id: string, overrides: Record<string, unknown> = {}) {
  const runtime = composition.getRequiredRuntime(profileId);
  runtime.sessionManager.addSession({
    id,
    name: id,
    cliType: 'test',
    processId: 1,
    ...overrides,
  });
  return runtime.sessionManager.getSession(id)!;
}

function registerProfileServices(composition: ProfileRuntimeComposition, ptyManager: PtyManager, chatBroker = new ChatBroker()) {
  const runtimeOne = composition.getRequiredRuntime('1');
  const handover = new HandoverDelivery(ptyManager, runtimeOne.sessionManager, async () => undefined, () => undefined);
  composition.registerProfileServices({
    stateDetector: new StateDetector(),
    notificationManager: {
      flashAttention: () => undefined,
      notifyLlmDirected: () => 'none',
    } as never,
    hookReceiver: new HookReceiver(),
    profileOneHandover: handover,
    chatBroker,
    apiContextSize: () => ({ available: false }),
    onTurnEnded: () => undefined,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('profile-owned process services', () => {
  it('routes an API session mission, reply, and canonical history to its creating profile', async () => {
    const { composition, ptyManager, p1ConfigDir, p2ConfigDir } = makeComposition();
    const outbound: ChatOutboundMessage[] = [];
    const chatBroker = new ChatBroker();
    chatBroker.register({
      provider: 'test',
      isAvailable: () => true,
      sendToSession: async message => { outbound.push(message); return { sent: true }; },
    });
    registerProfileServices(composition, ptyManager, chatBroker);
    addSession(composition, '1', 'api-one');
    const profileTwo = addSession(composition, '2', 'api-two');
    composition.getRequiredRuntime('2').sessionManager.setMission(profileTwo.id, 'profile-two mission', 'user');
    const runtimeTwo = composition.getRequiredRuntime('2');
    runtimeTwo.todoManager.add(profileTwo.id, 'profile-two todo');
    runtimeTwo.artifactManager.create(profileTwo.id, 'Profile two rules', 'markdown', 'profile-two manifesto', 'manual', undefined, 'manifesto');
    const requests: Array<{ sessionId: string; messages: Array<{ role: string; content?: string | null }> }> = [];
    const host = new ApiSessionHost({
      dispatchTool: async () => ({}),
      mcpTools: () => [],
      listSkills: (sessionId) => composition.requireSessionOwner(sessionId).skillManager.list(),
      getMission: sessionId => composition.requireSessionOwner(sessionId).sessionManager.getSession(sessionId)?.mission?.text,
      getManifestoContext: sessionId => {
        const owner = composition.requireSessionOwner(sessionId);
        return appendSessionTodoContext(
          formatManifestoContext(owner.artifactManager.getManifestosForSession(sessionId)),
          owner.todoManager.list(sessionId),
          owner.configLoader.getHookInjectionOverrides(),
        );
      },
      createMemory: () => ({ id: 'unused' }),
      linkMemory: () => undefined,
      recordToolRequest: () => undefined,
      postChat: (sessionId, message, usage) => composition.sendChatForSession(sessionId, message, usage),
      emitHook: () => undefined,
      promptContext: async sessionId => composition.requireSessionOwner(sessionId).sessionManager.getSession(sessionId)?.mission?.text ?? null,
      historyDir: join(p1ConfigDir, 'api-history'),
      historyDirForProfile: id => composition.getRequiredRuntime(id).paths.apiSessionsDir,
      createClient: () => ({
        complete: async messages => {
          requests.push({ sessionId: profileTwo.id, messages: structuredClone(messages) });
          return { message: { content: 'profile-two reply' } };
        },
      }),
    });

    try {
      const apiProcess = host.create({
        sessionId: profileTwo.id,
        userProfileId: '2',
        sessionName: profileTwo.name,
        cliSessionName: 'api-session-two',
        api: { baseUrl: 'http://api.test/v1', model: 'test', allowedTools: [], handshake: false },
      });
      apiProcess.write('/clear\r');
      apiProcess.write('hello\r');
      await vi.waitFor(() => expect(outbound).toHaveLength(1));

      const runtimeOne = composition.getRequiredRuntime('1');
      const runtimeTwo = composition.getRequiredRuntime('2');
      const prompt = requests[0].messages.map(message => message.content).join('\n');
      expect(prompt).toContain('profile-two mission');
      expect(prompt).toContain('profile-two manifesto');
      expect(prompt).toContain('profile-two todo');
      expect(outbound).toEqual([expect.objectContaining({ sessionId: 'api-two', text: 'profile-two reply' })]);
      expect(existsSync(join(runtimeTwo.paths.apiSessionsDir, 'api-session-two.json'))).toBe(true);
      expect(existsSync(join(runtimeOne.paths.apiSessionsDir, 'api-session-two.json'))).toBe(false);
      expect(runtimeOne.sessionManager.getSession('api-two')).toBeNull();
    } finally {
      composition.dispose();
    }
  });

  it('offers the creating profile\'s skills to an API session before the session is registered', async () => {
    const { composition, p1ConfigDir } = makeComposition();
    const oneSkill = composition.getRequiredRuntime('1').skillManager.create({ name: 'Profile One Skill', allProjects: true });
    const twoSkill = composition.getRequiredRuntime('2').skillManager.create({ name: 'Profile Two Skill', allProjects: true });
    const systemPrompts: string[] = [];
    const host = new ApiSessionHost({
      dispatchTool: async () => ({}),
      mcpTools: () => [{ name: 'skill_get', title: 'Skill Get', description: 'Read a skill', inputSchema: { type: 'object' } }],
      listSkills: (sessionId, cwd, userProfileId) => composition.listSkillsForSession(userProfileId, sessionId, cwd),
      getMission: () => undefined,
      createMemory: () => ({ id: 'unused' }),
      linkMemory: () => undefined,
      recordToolRequest: () => undefined,
      postChat: async () => undefined,
      emitHook: () => undefined,
      historyDir: join(p1ConfigDir, 'api-history'),
      historyDirForProfile: id => composition.getRequiredRuntime(id).paths.apiSessionsDir,
      createClient: () => ({
        complete: async messages => {
          systemPrompts.push(String(messages.find(message => message.role === 'system')?.content ?? ''));
          return { message: { content: 'ready' } };
        },
      }),
    });
    let one: ReturnType<ApiSessionHost['create']> | undefined;
    let two: ReturnType<ApiSessionHost['create']> | undefined;

    try {
      one = host.create({
        sessionId: 'first-api-one',
        userProfileId: '1',
        sessionName: 'First API One',
        cliSessionName: 'first-api-one',
        cwd: 'X:\\coding\\profile-one',
        api: { baseUrl: 'http://api.test/v1', model: 'test', allowedTools: ['skill_get'], handshake: false },
      });
      two = host.create({
        sessionId: 'first-api-two',
        userProfileId: '2',
        sessionName: 'First API Two',
        cliSessionName: 'first-api-two',
        cwd: 'X:\\coding\\profile-two',
        api: { baseUrl: 'http://api.test/v1', model: 'test', allowedTools: ['skill_get'], handshake: false },
      });
      expect(composition.registry.findSessionOwner('first-api-one')).toBeUndefined();
      expect(composition.registry.findSessionOwner('first-api-two')).toBeUndefined();

      one.write('start\r');
      two.write('start\r');
      await vi.waitFor(() => expect(systemPrompts).toHaveLength(2));

      expect(systemPrompts[0]).toContain(`${oneSkill.id}: ${oneSkill.name}`);
      expect(systemPrompts[0]).not.toContain(twoSkill.id);
      expect(systemPrompts[1]).toContain(`${twoSkill.id}: ${twoSkill.name}`);
      expect(systemPrompts[1]).not.toContain(oneSkill.id);
    } finally {
      one?.kill();
      two?.kill();
      composition.dispose();
    }
  });

  it('stores imported and generated profile-two ComfyUI images in profile two and closes them there', async () => {
    const { composition, p1ConfigDir, p2ConfigDir } = makeComposition();
    const inputPath = join(makeRoot(), 'reference.png');
    writeFileSync(inputPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const endpoint = 'http://comfy.test:8188';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/system_stats' || url.pathname === '/free') return new Response('{}');
      if (url.pathname === '/prompt') return new Response(JSON.stringify({ prompt_id: 'profile-two-prompt' }));
      if (url.pathname === '/history/profile-two-prompt') return new Response(JSON.stringify({ 'profile-two-prompt': {
        status: { completed: true }, outputs: { '7': { images: [{ filename: 'generated.png', type: 'output' }] } },
      } }));
      if (url.pathname === '/view') return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      throw new Error(`Unexpected ComfyUI request: ${url.pathname}`);
    }));
    const host = new ComfyUiSessionHost({
      tempDir: makeRoot(),
      storesForProfile: profileId => {
        const runtime = composition.getRequiredRuntime(profileId);
        return { artifacts: runtime.artifactManager, attachments: runtime.artifactAttachmentManager };
      },
      postChat: async () => undefined,
      recordPrompt: () => undefined,
      notifyRequester: async () => undefined,
    });
    host.create('comfy-two', { ...cloneDefaultComfyUiConfigForKind('image'), endpoint: 'http://127.0.0.1:1' }, '2');
    host.create('comfy-two-generated', { ...cloneDefaultComfyUiConfigForKind('image'), endpoint }, '2');

    try {
      host.submit('comfy-two', '', undefined, undefined, undefined, inputPath);
      const one = composition.getRequiredRuntime('1');
      const two = composition.getRequiredRuntime('2');
      const chatFiles = two.artifactManager.getForSession('comfy-two')[0];
      expect(chatFiles?.title).toBe('Chat files');
      expect(two.artifactAttachmentManager.list(chatFiles!.id)).toHaveLength(1);
      expect(one.artifactManager.getForSession('comfy-two')).toEqual([]);
      expect(one.artifactAttachmentManager.list(chatFiles!.id)).toEqual([]);
      expect(two.paths.artifactAttachmentsDir).toContain(p2ConfigDir);
      expect(one.paths.artifactAttachmentsDir).toContain(p1ConfigDir);
      host.closeSession('comfy-two');
      expect(two.artifactAttachmentManager.list(chatFiles!.id)).toEqual([]);
      expect(two.artifactManager.count('comfy-two')).toBe(1);

      host.submit('comfy-two-generated', 'make a lake');
      await vi.waitFor(() => {
        const generated = two.artifactManager.getForSession('comfy-two-generated').find(item => item.title === 'Chat files');
        expect(generated && two.artifactAttachmentManager.list(generated.id)).toHaveLength(1);
      }, { timeout: 10_000 });
      const generated = two.artifactManager.getForSession('comfy-two-generated')[0];
      expect(generated?.title).toBe('Chat files');
      expect(one.artifactManager.getForSession('comfy-two-generated')).toEqual([]);
      expect(one.artifactAttachmentManager.list(generated!.id)).toEqual([]);
      host.closeSession('comfy-two-generated');
      expect(two.artifactAttachmentManager.list(generated!.id)).toEqual([]);
    } finally {
      host.closeSession('comfy-two');
      host.closeSession('comfy-two-generated');
      composition.dispose();
    }
  }, 15_000);

  it('accepts Claude statusline usage for profile two and persists it only in profile two', () => {
    const { composition, ptyManager } = makeComposition();
    registerProfileServices(composition, ptyManager);
    addSession(composition, '1', 'claude-one', { cliType: 'claude', cliThreadId: 'thread-one' });
    addSession(composition, '2', 'claude-two', { cliType: 'claude', cliThreadId: 'thread-two' });

    try {
      expect(composition.includeStatuslineUsage('claude-two', 'thread-two', { contextTokens: 1234, contextWindow: 8000 })).toBe(true);
      expect(composition.getRequiredRuntime('2').sessionManager.getSession('claude-two')?.contextUsage)
        .toMatchObject({ tokens: 1234, window: 8000, source: 'statusline' });
      expect(composition.getRequiredRuntime('2').sessionManager.getSession('claude-two')?.contextHistory).toHaveLength(1);
      expect(composition.getRequiredRuntime('1').sessionManager.getSession('claude-one')?.contextUsage).toBeUndefined();
      expect(composition.includeStatuslineUsage('unknown-session', 'thread-two', { contextTokens: 9 })).toBe(false);
    } finally {
      composition.dispose();
    }
  });

  it('freezes and warms profile-two sessions using profile-two CLI policy', async () => {
    const { composition, ptyManager } = makeComposition();
    const now = Date.now();
    addSession(composition, '1', 'cache-one', { cliType: 'claude', lastPromptAt: now - 2 * 60 * 60_000 });
    addSession(composition, '2', 'freeze-two', {
      cliType: 'claude', lastPromptAt: now - 2 * 60 * 60_000,
    });
    addSession(composition, '2', 'warm-two', {
      cliType: 'claude', lastPromptAt: now - 2 * 60_000, keepWarmUntil: now + 60_000,
    });
    registerProfileServices(composition, ptyManager);

    try {
      composition.autoFreezers.get('1')!.tick();
      composition.autoFreezers.get('2')!.tick();
      await composition.keepWarmers.get('1')!.tick();
      await composition.keepWarmers.get('2')!.tick();

      expect(composition.getRequiredRuntime('2').sessionManager.getSession('freeze-two')?.frozen).toBe(true);
      expect(composition.getRequiredRuntime('2').sessionManager.getSession('warm-two')?.lastPromptAt).toBeGreaterThan(now - 2 * 60_000);
      expect(composition.getRequiredRuntime('1').sessionManager.getSession('cache-one')?.frozen).toBeUndefined();
      expect(composition.getRequiredRuntime('1').sessionManager.getSession('cache-one')?.lastPromptAt).toBe(now - 2 * 60 * 60_000);
    } finally {
      composition.dispose();
    }
  });

  it('runs removal cleanup against the owning profile stores and preserves only recoverable state', () => {
    const { composition } = makeComposition();
    const mobilePrunes: string[] = [];
    const sideEffects = {
      forgetRuntimeSessionState: () => undefined,
      closeComfyUiSession: () => undefined,
      pruneProfileOneJournal: sessionId => mobilePrunes.push(sessionId),
    };
    registerProfileSessionCleanup(composition, sideEffects);

    try {
      const profileOne = addSession(composition, '1', 'one-ephemeral');
      const recoverable = addSession(composition, '2', 'two-recoverable', {
        cliType: 'test', workingDir: 'X:\\profile-two-project', cliSessionName: 'resume-two',
      });
      const ephemeral = addSession(composition, '2', 'two-ephemeral');
      const one = composition.getRequiredRuntime('1');
      const two = composition.getRequiredRuntime('2');
      const project = two.projectStore.resolveForPath(recoverable.workingDir!);
      two.sessionManager.updateSession(recoverable.id, { projectId: project.id });

      const oneMemory = one.memoryManager.createForSession(profileOne.id, { tldr: 'one', content: 'one state', sessionBound: true });
      const recoverableMemory = two.memoryManager.createForSession(recoverable.id, { tldr: 'resume', content: 'keep', sessionBound: true });
      const ephemeralMemory = two.memoryManager.createForSession(ephemeral.id, { tldr: 'temporary', content: 'drop', sessionBound: true });
      one.artifactManager.create(profileOne.id, 'one artifact', 'markdown', 'keep', 'manual');
      two.artifactManager.create(recoverable.id, 'recoverable artifact', 'markdown', 'keep', 'manual');
      two.artifactManager.create(ephemeral.id, 'ephemeral artifact', 'markdown', 'drop', 'manual');
      one.draftManager.append(profileOne.id, 'one draft', 'user');
      two.draftManager.append(recoverable.id, 'resume draft', 'user');
      two.draftManager.append(ephemeral.id, 'temporary draft', 'user');
      one.todoManager.add(profileOne.id, 'one todo');
      two.todoManager.add(recoverable.id, 'resume todo');
      two.todoManager.add(ephemeral.id, 'temporary todo');

      two.sessionManager.removeSession(recoverable.id);
      two.sessionManager.removeSession(ephemeral.id);
      one.sessionManager.removeSession(profileOne.id);

      expect(two.recycleBinManager.list().map(entry => entry.sessionId)).toContain(recoverable.id);
      expect(two.recycleBinManager.list().some(entry => entry.sessionId === ephemeral.id)).toBe(false);
      expect(two.artifactManager.count(recoverable.id)).toBe(1);
      expect(two.draftManager.get(recoverable.id).text).toBe('resume draft');
      expect(two.todoManager.list(recoverable.id)).toHaveLength(1);
      expect(two.memoryManager.getRecord(recoverableMemory.id)).not.toBeNull();
      expect(two.artifactManager.count(ephemeral.id)).toBe(0);
      expect(two.draftManager.get(ephemeral.id).text).toBe('');
      expect(two.todoManager.list(ephemeral.id)).toEqual([]);
      expect(two.memoryManager.getRecord(ephemeralMemory.id)).toBeNull();
      expect(one.artifactManager.count(profileOne.id)).toBe(0);
      expect(one.memoryManager.getRecord(oneMemory.id)).toBeNull();
      expect(mobilePrunes).toEqual([profileOne.id]);
    } finally {
      composition.dispose();
    }
  });
});
