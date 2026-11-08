import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';
import { ProfileRuntimeComposition } from '../src/electron/profile-runtime-composition.js';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { LocalhostMcpServer } from '../src/mcp/localhost-mcp-server.js';
import { mintSessionAuthToken } from '../src/mcp/session-auth.js';
import { ProfileMcpRouter } from '../src/mcp/profile-mcp-router.js';
import { createProfileRemoteService, ProfileMcpServiceFactory } from '../src/mcp/profile-mcp-service-factory.js';
import { MobileDeviceStore } from '../src/mobile/mobile-device-store.js';
import { MobileAlertNotifier } from '../src/mobile/mobile-alert-notifier.js';
import { MobileChatBridge } from '../src/mobile/mobile-chat-bridge.js';
import { MobileChatJournal } from '../src/mobile/mobile-chat-journal.js';
import { decodeRecord } from '../src/mobile/mobile-envelope.js';
import { ChatBroker } from '../src/session/chat/chat-broker.js';
import { createProfileChatBrokerOptions } from '../src/session/chat/profile-chat-broker-options.js';
import { PtyManager } from '../src/session/pty-manager.js';
import { RemoteMethod } from '../src/session/remote/remote-protocol.js';
import { FLEET_SESSIONS_METHOD } from '../src/mcp/peer/fleet-sessions.js';
import { getProfileConfigDir } from '../src/utils/app-paths.js';

const roots: string[] = [];
const compositions: ProfileRuntimeComposition[] = [];

class ProfileTestLinks extends EventEmitter {
  readonly peerNotices: Array<{ peer: string; method: string; params: unknown }> = [];
  readonly phoneMessages: Array<{ machineId: string; payload: Buffer }> = [];
  readonly onlineMachines = new Set<string>();

  peerIdFor(peerRef: string): string | undefined {
    return peerRef === 'peer' ? 'peer' : undefined;
  }

  async call(): Promise<unknown> {
    return { snapshot: '', seq: 0, cols: 80, rows: 24, session: { name: 'Remote', cliType: 'test' } };
  }

  notifyPeer(peerId: string, method: string, params: unknown): void {
    this.emit('peer-notification', { peerId, method, params });
  }

  notify(peer: string, method: string, params: unknown): boolean {
    this.peerNotices.push({ peer, method, params });
    return true;
  }

  onlinePeerIds(): string[] {
    return ['peer'];
  }

  isOnline(machineId: string): boolean {
    return this.onlineMachines.has(machineId);
  }

  send(machineId: string, payload: Buffer): boolean {
    this.phoneMessages.push({ machineId, payload });
    return true;
  }
}

function makeComposition() {
  const appData = mkdtempSync(join(tmpdir(), 'helm-profile-mcp-'));
  roots.push(appData);
  const globalConfigDir = join(appData, 'Helm', 'config');
  const p1ConfigDir = getProfileConfigDir('1', appData);
  const p2ConfigDir = getProfileConfigDir('2', appData);
  for (const dir of [globalConfigDir, p1ConfigDir, p2ConfigDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'settings.yaml'), '{}\n');
  const cliTypes = YAML.stringify({ test: { name: 'Test', displayName: 'Test' } });
  writeFileSync(join(p1ConfigDir, 'cli-types.yaml'), cliTypes);
  writeFileSync(join(p2ConfigDir, 'cli-types.yaml'), cliTypes);
  const profiles = new UserProfileStore(globalConfigDir);
  writeFileSync(profiles.filePath, YAML.stringify({ version: 1, profiles: [
    { id: '1', name: 'One', pinHash: null }, { id: '2', name: 'Two', pinHash: null },
  ] }));
  const configLoader = new ConfigLoader({ userProfileId: '1', profileConfigDir: p1ConfigDir, globalConfigDir });
  const ptyManager = new PtyManager();
  ptyManager.has = () => true;
  ptyManager.nudgeResize = async () => undefined;
  const writtenSessionIds: string[] = [];
  ptyManager.deliverText = async sessionId => { writtenSessionIds.push(sessionId); };
  const composition = new ProfileRuntimeComposition({ configLoader, userProfileStore: profiles, ptyManager });
  compositions.push(composition);
  return {
    composition,
    ptyManager,
    writtenSessionIds,
  };
}

function addSession(composition: ProfileRuntimeComposition, profileId: string, id: string) {
  const runtime = composition.getRequiredRuntime(profileId);
  runtime.sessionManager.addSession({ id, name: id, cliType: 'test', processId: 1 });
  return runtime.sessionManager.getSession(id)!;
}

function postMcp(port: number, token: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  });
}

function toolPayload(json: any): any {
  return JSON.parse(json.result.content[0].text.split('\n\n')[0]);
}

function createService(
  runtime: ReturnType<ProfileRuntimeComposition['getRequiredRuntime']>,
  pty: PtyManager,
  chatBroker?: ChatBroker,
) {
  const service = new HelmControlService(
    runtime.planManager, runtime.sessionManager, pty, runtime.configLoader,
    runtime.planAttachmentManager, runtime.contextManager, runtime.scheduledTaskManager,
    runtime.projectStore, runtime.skillManager, runtime.skillAnalyticsManager,
  );
  service.setArtifactManager(runtime.artifactManager, runtime.artifactAttachmentManager);
  service.setMemoryManager(runtime.memoryManager, runtime.memoryAttachmentManager, runtime.artifactTempRegistry);
  service.setDraftManager(runtime.draftManager);
  service.setTodoManager(runtime.todoManager);
  service.setRuntimeGroupManager(runtime.runtimeGroupManager);
  service.setEtaTracker(runtime.etaTracker);
  service.setMessManager(runtime.messManager);
  service.setChatBroker(chatBroker ?? null);
  service.sessionChangeFeed.attach(runtime.sessionManager);
  return service;
}

afterEach(() => {
  for (const composition of compositions.splice(0)) composition.dispose();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('caller-profile MCP routing', () => {
  it('routes API dispatch to the session owner and keeps all profile stores isolated', async () => {
    const { composition, ptyManager, writtenSessionIds } = makeComposition();
    const one = composition.getRequiredRuntime('1');
    const two = composition.getRequiredRuntime('2');
    const sessionOne = addSession(composition, '1', 'session-one');
    const sessionTwo = addSession(composition, '2', 'session-two');
    const p1Plan = one.planManager.create('X:/profile-one', 'One only', 'private');
    const p2Plan = two.planManager.create('X:/profile-two', 'Two only', 'profile two plan');
    const p1Memory = one.memoryManager.createForSession(sessionOne.id, { tldr: 'one memory', content: 'private' });
    two.memoryManager.createForSession(sessionTwo.id, { tldr: 'two memory', content: 'profile two memory' });
    const p1Artifact = one.artifactManager.create(sessionOne.id, 'One artifact', 'markdown', 'private');
    two.artifactManager.create(sessionTwo.id, 'Two artifact', 'markdown', 'profile two artifact');
    const chatBroker = new ChatBroker(createProfileChatBrokerOptions(composition.registry, ptyManager));
    const builds = new Map<string, number>();
    const router = new ProfileMcpRouter(composition, { get: () => undefined } as never);
    const devices = new MobileDeviceStore();
    const device = devices.add({ machineId: 'tablet', name: 'Tablet', pskRef: 'psk', userProfileId: '2' });
    const mobileRouter = new ProfileMcpRouter(composition, devices);
    expect(mobileRouter.runtimeForCaller({ sessionId: `mobile:${device.id}` }).userProfileId).toBe('2');
    const makeSet = (runtime: typeof one) => {
      builds.set(runtime.userProfileId, (builds.get(runtime.userProfileId) ?? 0) + 1);
      return { userProfileId: runtime.userProfileId, service: createService(runtime, ptyManager, chatBroker) };
    };
    const primary = makeSet(one);
    const factory = new ProfileMcpServiceFactory(router, primary, makeSet);
    const server = new LocalhostMcpServer(primary.service, {
      resolveCallerServices: auth => factory.forCaller(auth),
      resolveSessionIdentity: sessionId => {
        const owner = composition.registry.findSessionOwner(sessionId);
        const session = owner?.sessionManager.getSession(sessionId);
        return session ? { id: session.id, name: session.name } : null;
      },
    }, ptyManager);

    await expect(server.dispatchForPeer('session_list', {}, { sessionId: sessionTwo.id }))
      .resolves.toMatchObject([{ id: 'session-two' }]);
    await expect(server.dispatchForPeer('plan_list', { dirPath: 'X:/profile-two' }, { sessionId: sessionTwo.id }))
      .resolves.toMatchObject([{ id: p2Plan.id, title: 'Two only' }]);
    await expect(server.dispatchForPeer('artifact_list', {}, { sessionId: sessionTwo.id }))
      .resolves.toMatchObject([{ id: expect.any(String), title: 'Two artifact' }]);
    await expect(server.dispatchForPeer('memory_search', { query: 'profile two memory' }, { sessionId: sessionTwo.id }))
      .resolves.toMatchObject({ hits: [{ tldr: 'two memory' }] });
    const sourceFile = join(roots[roots.length - 1], 'profile-two-chat-file.txt');
    writeFileSync(sourceFile, 'profile-two attachment bytes', 'utf8');
    await server.dispatchForPeer('chat_send', {
      message: 'See attached file',
      filePath: sourceFile,
    }, { sessionId: sessionTwo.id });
    const profileTwoChatFiles = two.artifactManager.getForSession(sessionTwo.id)
      .find(artifact => artifact.title === 'Chat files');
    expect(profileTwoChatFiles).toBeDefined();
    if (!profileTwoChatFiles) throw new Error('Profile two chat attachment was not registered');
    const profileTwoAttachment = two.artifactAttachmentManager.list(profileTwoChatFiles.id)[0];
    expect(readFileSync(two.artifactAttachmentManager.getPath(profileTwoChatFiles.id, profileTwoAttachment.id), 'utf8'))
      .toBe('profile-two attachment bytes');
    expect(one.artifactManager.getForSession(sessionTwo.id)).toEqual([]);
    chatBroker.routeInbound({ provider: 'test', sessionId: sessionTwo.id, text: 'inbound profile two' });
    await vi.waitFor(() => expect(writtenSessionIds).toContain(sessionTwo.id));
    expect(writtenSessionIds).not.toContain(sessionOne.id);
    await expect(server.dispatchForPeer('session_get', { sessionId: sessionOne.id }, { sessionId: sessionTwo.id }))
      .rejects.toThrow(/Session not found/);
    await expect(server.dispatchForPeer('plan_get', { uuid: p1Plan.id }, { sessionId: sessionTwo.id }))
      .rejects.toThrow(/Plan not found/);
    await expect(server.dispatchForPeer('memory_get', { id: p1Memory.id }, { sessionId: sessionTwo.id }))
      .rejects.toThrow(/Memory not found/);
    await expect(server.dispatchForPeer('artifact_get', { id: p1Artifact.id }, { sessionId: sessionTwo.id }))
      .rejects.toThrow();
    await expect(server.dispatchForPeer('session_close', { sessionId: sessionOne.id }, { sessionId: sessionTwo.id }))
      .rejects.toThrow(/Session not found/);
    await expect(server.dispatchForPeer('session_rename', { sessionId: sessionOne.id, newName: 'tampered' }, { sessionId: sessionTwo.id }))
      .rejects.toThrow(/Session not found/);
    await expect(server.dispatchForPeer('helm_restart', { handoverArtifactId: 'unused' }, { sessionId: sessionTwo.id }))
      .rejects.toThrow(/admin only/i);
    expect(one.sessionManager.getSession(sessionOne.id)?.name).toBe('session-one');
    await expect(server.dispatchForPeer('session_get', { sessionId: sessionOne.id }, { sessionId: sessionOne.id }))
      .resolves.toMatchObject({ id: 'session-one' });
    expect(builds.get('2')).toBe(1);
    factory.dispose();
  });

  it('never falls back to profile one for an unknown session or unbound mobile identity', () => {
    const { composition } = makeComposition();
    const router = new ProfileMcpRouter(composition, { get: () => undefined } as never);
    expect(() => router.runtimeForCaller({ sessionId: 'deleted-api-session' })).toThrow(/owner/i);
    expect(() => router.runtimeForCaller({ sessionId: 'mobile:missing-device' })).toThrow(/device|profile/i);
  });

  it('routes anonymous callers and fleet ownership to a directly assigned admin profile', () => {
    const { composition, ptyManager } = makeComposition();
    const profiles = new UserProfileStore(composition.getRequiredRuntime('1').configLoader.getGlobalConfigDir());
    profiles.adminProfileId = '2';
    const router = new ProfileMcpRouter(composition, new MobileDeviceStore());
    const adminRuntime = composition.getRequiredRuntime('2');
    const adminServices = { userProfileId: '2', service: createService(adminRuntime, ptyManager) };
    const factory = new ProfileMcpServiceFactory(router, adminServices, runtime => ({
      userProfileId: runtime.userProfileId,
      service: createService(runtime, ptyManager),
    }));

    expect(router.runtimeForCaller({}).userProfileId).toBe('2');
    expect(factory.forCaller({}).userProfileId).toBe('2');
    expect(() => factory.forProfile('2').service.restartHelm(true)).not.toThrow();
    expect(() => factory.forProfile('1').service.restartHelm(true)).toThrow(/admin/i);
    factory.dispose();
    composition.dispose();
  });

  it('routes bearer-only MCP calls to the admin profile while identity tools still require a signed session', async () => {
    const { composition, ptyManager } = makeComposition();
    const one = composition.getRequiredRuntime('1');
    const two = composition.getRequiredRuntime('2');
    addSession(composition, '1', 'admin-session');
    addSession(composition, '2', 'private-session');
    const router = new ProfileMcpRouter(composition, new MobileDeviceStore());
    const primary = createService(one, ptyManager);
    const factory = new ProfileMcpServiceFactory(router, { userProfileId: '1', service: primary }, runtime => ({
      userProfileId: runtime.userProfileId,
      service: createService(runtime, ptyManager),
    }));
    const resolveCallerServices = vi.fn((auth: { sessionId?: string; sessionName?: string }) => factory.forCaller(auth));
    const server = new LocalhostMcpServer(primary, {
      token: 'shared-secret',
      port: 0,
      resolveCallerServices,
    }, ptyManager);
    await server.start();

    try {
      const port = server.getAddress()!.port;
      const listed = await postMcp(port, 'shared-secret', { name: 'session_list', arguments: {} });
      const listedJson = await listed.json();
      const listResult = toolPayload(listedJson);
      const sessions = Array.isArray(listResult) ? listResult : listResult.items;
      expect(sessions.map((session: { id: string }) => session.id)).toEqual(['admin-session']);
      expect(router.runtimeForCaller({}).userProfileId).toBe(
        composition.registry.all().find(runtime => new UserProfileStore(runtime.configLoader.getGlobalConfigDir())
          .isAdmin(runtime.userProfileId))?.userProfileId,
      );

      const identityCall = await postMcp(port, 'shared-secret', {
        name: 'session_send_text',
        arguments: { sessionId: 'admin-session', text: 'hello', senderSessionId: 'admin-session' },
      });
      const identityJson = await identityCall.json();
      expect(identityJson.error.message).toContain('signed session token');

      const forgedHeader = await postMcp(port, 'shared-secret', { name: 'session_list', arguments: {} }, {
        'x-helm-session-id': 'private-session',
      });
      expect(forgedHeader.status).toBe(401);

      const callsBeforeUnknown = resolveCallerServices.mock.calls.length;
      const unknown = await postMcp(port, 'shared-secret', { name: 'not_in_catalog', arguments: {} });
      expect((await unknown.json()).error.message).toContain('Unknown tool');
      expect(resolveCallerServices).toHaveBeenCalledTimes(callsBeforeUnknown);

      const toolList = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer shared-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect((await toolList.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain('skill_activate');

      const signedAdmin = mintSessionAuthToken('shared-secret', 'admin-session', 'admin-session');
      const signedMismatch = await postMcp(port, signedAdmin, { name: 'session_list', arguments: {} }, {
        'x-helm-session-id': 'private-session',
      });
      expect(signedMismatch.status).toBe(401);
    } finally {
      await server.close();
      factory.dispose();
    }
  });

  it('keeps profile-two RemoteService viewer-only and does not advertise its sessions', async () => {
    const { composition, ptyManager } = makeComposition();
    const one = composition.getRequiredRuntime('1');
    const two = composition.getRequiredRuntime('2');
    const sessionOne = addSession(composition, '1', 'session-one-remote-owner');
    const sessionTwo = addSession(composition, '2', 'session-two-remote-owner');
    const links = new ProfileTestLinks();
    const primaryRemote = createProfileRemoteService(one, { pty: ptyManager, coalesceMs: 0 });
    const remote = createProfileRemoteService(two, { pty: ptyManager, coalesceMs: 0 });
    primaryRemote.setLinks(links);
    remote.setLinks(links);
    try {
      two.sessionManager.updateSession(sessionTwo.id, { activityLevel: 'active' });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(links.peerNotices.filter(notice => notice.method === FLEET_SESSIONS_METHOD)).toEqual([]);
      expect(() => remote.handleCall('peer', RemoteMethod.attach, { sessionId: sessionTwo.id }))
        .toThrow(/owner|profile 1/i);
      const viewed = await remote.open('peer', 'remote-session');
      expect(viewed).toMatchObject({ remote: { peerId: 'peer', sessionId: 'remote-session' } });
      const output: string[] = [];
      const captureOutput = (sessionId: string, data: string) => {
        if (sessionId === viewed.id) output.push(data);
      };
      ptyManager.on('data', captureOutput);
      links.notifyPeer('peer', RemoteMethod.data, { sessionId: 'remote-session', seq: 1, data: 'viewer output' });
      ptyManager.off('data', captureOutput);
      expect(output).toContain('viewer output');
      one.sessionManager.updateSession(sessionOne.id, { activityLevel: 'active' });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(links.peerNotices.filter(notice => notice.method === FLEET_SESSIONS_METHOD)).toMatchObject([
        { params: { sessions: [{ id: sessionOne.id }] } },
      ]);
    } finally {
      primaryRemote.dispose();
      remote.dispose();
    }
  });

  it('observes profile-two state changes and alerts only the profile-two phone', () => {
    const { composition } = makeComposition();
    const one = composition.getRequiredRuntime('1');
    const two = composition.getRequiredRuntime('2');
    const sessionOne = addSession(composition, '1', 'session-one-alert');
    const sessionTwo = addSession(composition, '2', 'session-two-alert');
    const devices = new MobileDeviceStore();
    devices.add({ name: 'P1 phone', machineId: 'phone-one', pskRef: 'p1', allow: [], userProfileId: '1' });
    devices.add({ name: 'P2 phone', machineId: 'phone-two', pskRef: 'p2', allow: [], userProfileId: '2' });
    const links = new ProfileTestLinks();
    links.onlineMachines.add('phone-one');
    links.onlineMachines.add('phone-two');
    const bridge = new MobileChatBridge({
      links,
      deviceStore: devices,
      gate: () => undefined,
      sessions: {
        getSession: sessionId => composition.registry.findSessionOwner(sessionId)?.sessionManager.getSession(sessionId) ?? null,
        updateSession: () => undefined,
      },
      profileForSession: sessionId => composition.registry.findSessionOwner(sessionId)?.userProfileId,
      journal: new MobileChatJournal(),
    });
    const notifier = new MobileAlertNotifier(bridge);
    const dispose = notifier.observeProfiles(composition.registry.all());
    try {
      one.sessionManager.updateSession(sessionOne.id, { activityLevel: 'active' });
      two.sessionManager.updateSession(sessionTwo.id, { activityLevel: 'active' });
      two.sessionManager.updateSession(sessionTwo.id, { activityLevel: 'inactive' });

      expect(links.phoneMessages).toHaveLength(1);
      expect(links.phoneMessages[0].machineId).toBe('phone-two');
      expect(decodeRecord(links.phoneMessages[0].payload)).toMatchObject({
        sessionId: sessionTwo.id,
        kind: 'completion',
      });
    } finally {
      dispose();
    }
  });
});
