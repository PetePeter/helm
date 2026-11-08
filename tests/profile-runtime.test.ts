import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProfileRuntime } from '../src/electron/profile-runtime-factory.js';
import { ProfileRuntimeRegistry } from '../src/session/profile-runtime-registry.js';
import { getProfilePersistencePaths } from '../src/session/persistence-paths.js';
import { loadSessions } from '../src/session/session-persistence.js';
import { ConfigLoader } from '../src/config/loader.js';
import { PtyManager } from '../src/session/pty-manager.js';
import { etaWhereOf } from '../src/session/eta-tracker.js';

const tempDirs: string[] = [];
const runtimes: Array<{ dispose(): void }> = [];

function profileDir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `helm-profile-${name}-`));
  tempDirs.push(root);
  return root;
}

function configLoader(profileId: string, configDir: string, globalConfigDir: string): ConfigLoader {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(join(globalConfigDir, 'settings.yaml'), '{}\n');
  writeFileSync(join(configDir, 'cli-types.yaml'), 'test:\n  name: Test\n  displayName: Test\n');
  return new ConfigLoader({ userProfileId: profileId, profileConfigDir: configDir, globalConfigDir });
}

function snapshotTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry);
      if (statSync(file).isDirectory()) visit(file);
      else files.set(file.slice(root.length), readFileSync(file, 'base64'));
    }
  };
  visit(root);
  return files;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ProfileRuntime', () => {
  it('detaches scheduled-task listeners when the runtime is disposed', () => {
    const config = profileDir('listener-dispose');
    const globalConfig = profileDir('listener-global');
    const loader = configLoader('A', config, globalConfig);
    const runtime = createProfileRuntime({
      userProfileId: 'A', configDir: config, configLoader: loader, ptyManager: new PtyManager(),
    });
    const planListeners = runtime.planManager.listenerCount('plan:completed');
    const projectListeners = (runtime.projectStore as unknown as { changeListeners: Set<unknown> }).changeListeners.size;

    expect(planListeners).toBe(1);
    expect(projectListeners).toBe(1);

    runtime.dispose();

    expect(runtime.planManager.listenerCount('plan:completed')).toBe(planListeners - 1);
    expect((runtime.projectStore as unknown as { changeListeners: Set<unknown> }).changeListeners.size)
      .toBe(projectListeners - 1);
  });

  it('isolates real project and session stores and resolves a session owner', () => {
    const configA = profileDir('a');
    const configB = profileDir('b');
    const globalConfigDir = profileDir('global');
    const loaderA = configLoader('A', configA, globalConfigDir);
    const runtimeA = createProfileRuntime({ userProfileId: 'A', configDir: configA, configLoader: loaderA, ptyManager: new PtyManager() });
    const runtimeB = createProfileRuntime({
      userProfileId: 'B', configDir: configB, configLoader: loaderA.createProfileView('B', configB), ptyManager: new PtyManager(),
    });
    const registry = new ProfileRuntimeRegistry([runtimeA, runtimeB]);

    runtimeA.projectStore.createProject('X:\\coding\\profile-a', 'Profile A');
    runtimeA.sessionManager.addSession({
      id: 'session-a', name: 'A', cliType: 'test', processId: 10, workingDir: 'X:\\coding\\profile-a',
    });

    expect(runtimeB.projectStore.list()).toEqual([]);
    expect(runtimeB.sessionManager.getAllSessions()).toEqual([]);
    expect(registry.findSessionOwner('session-a')).toBe(runtimeA);
    expect(registry.findSessionOwner('missing')).toBeUndefined();

    const sessionFile = getProfilePersistencePaths(configA).sessionsFile;
    expect(readFileSync(sessionFile, 'utf8')).toContain('userProfileId: A');
    expect(loadSessions(sessionFile, 'A')[0]?.userProfileId).toBe('A');
  });

  it('keeps every persisted manager isolated behind its profile paths', () => {
    const configA = profileDir('full-a');
    const configB = profileDir('full-b');
    const globalConfigDir = profileDir('full-global');
    const loaderA = configLoader('A', configA, globalConfigDir);
    const ptyManager = new PtyManager();
    const runtimeA = createProfileRuntime({ userProfileId: 'A', configDir: configA, configLoader: loaderA, ptyManager });
    const runtimeB = createProfileRuntime({
      userProfileId: 'B', configDir: configB, configLoader: loaderA.createProfileView('B', configB), ptyManager,
    });
    runtimes.push(runtimeA, runtimeB);

    const projectB = runtimeB.projectStore.createProject('X:\\coding\\profile-b', 'Profile B');
    runtimeB.projectStore.save();
    runtimeB.sessionManager.addSession({
      id: 'session-b', name: 'B', cliType: 'test', processId: 20, workingDir: projectB.canonicalPath,
    });
    const planB = runtimeB.planManager.create(projectB.canonicalPath, 'B plan', '');
    runtimeB.messManager.check('session-b');
    runtimeB.skillManager.list();
    const bBefore = snapshotTree(configB);

    const projectA = runtimeA.projectStore.createProject('X:\\coding\\profile-a-full', 'Profile A');
    runtimeA.projectStore.save();
    const sessionA = {
      id: 'session-a-full', name: 'A', cliType: 'test', processId: 10, workingDir: projectA.canonicalPath,
    };
    runtimeA.sessionManager.addSession(sessionA);
    const planA = runtimeA.planManager.create(projectA.canonicalPath, 'A plan', 'isolated');
    const contextA = runtimeA.contextManager.create(projectA.id, { title: 'A context', content: 'private' });
    runtimeA.contextManager.bind(contextA.id, 'plan', planA.id);
    runtimeA.scheduledTaskManager.createTask({
      title: 'A task', planIds: [planA.id], initialPrompt: 'run', cliType: 'test',
      scheduledTime: new Date(Date.now() + 120_000), dirPath: projectA.canonicalPath,
    });
    runtimeA.scheduledTaskHistoryManager.append({
      taskId: 'task-a', title: 'A history', initialPrompt: 'run', cliType: 'test',
      dirPath: projectA.canonicalPath, planIds: [planA.id], ranAt: Date.now(), outcome: 'done',
    });
    runtimeA.messManager.post(sessionA.id, 'private message');
    const memoryA = runtimeA.memoryManager.createForSession(sessionA.id, { tldr: 'A memory', content: 'private' });
    runtimeA.memoryAttachmentManager.add(memoryA.id, { filename: 'private.txt', content: Buffer.from('private') });
    const artifactA = runtimeA.artifactManager.create(sessionA.id, 'A artifact', 'markdown', 'private');
    runtimeA.artifactAttachmentManager.add(artifactA.id, { filename: 'private.txt', content: Buffer.from('private') });
    runtimeA.planAttachmentManager.add(planA.id, { filename: 'private.txt', content: Buffer.from('private') });
    expect(runtimeA.draftManager.append(sessionA.id, 'private draft', 'ai').ok).toBe(true);
    runtimeA.todoManager.add(sessionA.id, 'private todo');
    runtimeA.timeTracker.recordPrompt(sessionA.id, 'user');
    runtimeA.timeTracker.flush();
    const etaWhere = etaWhereOf(sessionA);
    const eta = runtimeA.etaTracker.set(undefined, { minutes: 10 }, etaWhere);
    runtimeA.etaTracker.close(eta, etaWhere, 'cleared');
    const groupA = runtimeA.runtimeGroupManager.create('A group');
    runtimeA.runtimeGroupManager.addSession(groupA.id, sessionA.id);
    runtimeA.recycleBinManager.append({
      sessionId: 'closed-a', name: 'A', cliType: 'test', workingDir: projectA.canonicalPath,
      cliSessionName: 'thread-a', closedAt: Date.now(),
    });
    runtimeA.skillManager.create({ name: 'A skill', type: 'a-skill', allProjects: true, body: 'private' });

    const rangeStart = Date.now() - 86_400_000;
    const rangeEnd = Date.now() + 86_400_000;
    expect(runtimeB.projectStore.list()).toHaveLength(1);
    expect(runtimeB.sessionManager.getAllSessions().map(session => session.id)).toEqual(['session-b']);
    expect(runtimeB.planManager.getForDirectory(projectB.canonicalPath)).toEqual([planB]);
    expect(runtimeB.planManager.getForDirectory(projectA.canonicalPath)).toEqual([]);
    expect(runtimeB.contextManager.listForProject(projectA.id)).toEqual([]);
    expect(runtimeB.scheduledTaskManager.listTasks()).toEqual([]);
    expect(runtimeB.scheduledTaskHistoryManager.list()).toEqual([]);
    expect(runtimeB.messManager.check('session-b').new).toBe(0);
    expect(runtimeB.memoryManager.listProjectRecords(projectA.id)).toEqual([]);
    expect(runtimeB.memoryManager.listProjectRecords(projectB.id)).toEqual([]);
    expect(runtimeB.memoryAttachmentManager.list(memoryA.id)).toEqual([]);
    expect(runtimeB.artifactManager.getForSession(sessionA.id)).toEqual([]);
    expect(runtimeB.artifactManager.getForSession('session-b')).toEqual([]);
    expect(runtimeB.artifactAttachmentManager.list(artifactA.id)).toEqual([]);
    expect(runtimeB.planAttachmentManager.list(planB.id)).toEqual([]);
    expect(runtimeB.draftManager.get('session-b').text).toBe('');
    expect(runtimeB.todoManager.list('session-b')).toEqual([]);
    expect(runtimeB.timeTracker.query(rangeStart, rangeEnd)).toEqual([]);
    expect(runtimeB.etaTracker.query(rangeStart, rangeEnd)).toEqual([]);
    expect(runtimeB.runtimeGroupManager.list()).toEqual([]);
    expect(runtimeB.recycleBinManager.list()).toEqual([]);
    expect(runtimeB.skillManager.list().some(skill => skill.name === 'A skill')).toBe(false);
    expect(snapshotTree(configB)).toEqual(bBefore);

    for (const profilePath of Object.values(runtimeA.paths)) {
      expect(profilePath.startsWith(configA)).toBe(true);
    }
  });

  it('hydrates legacy ownership as profile 1 and excludes explicitly foreign rows', () => {
    const sessionFile = join(profileDir('legacy'), 'sessions.yaml');
    mkdirSync(join(sessionFile, '..'), { recursive: true });
    writeFileSync(sessionFile, [
      'sessions:',
      '  - id: legacy',
      '    name: Legacy',
      '    cliType: test',
      '    processId: 1',
      '  - id: foreign',
      '    name: Foreign',
      '    cliType: test',
      '    processId: 2',
      '    userProfileId: B',
    ].join('\n'));

    expect(loadSessions(sessionFile, '1').map(session => [session.id, session.userProfileId]))
      .toEqual([['legacy', '1']]);
  });

  it('uses separate global config instances only when they intentionally share the same loader state', () => {
    const configA = profileDir('shared-a');
    const configB = profileDir('shared-b');
    const globalConfigDir = profileDir('shared-global');
    const loaderA = configLoader('A', configA, globalConfigDir);
    const loaderB = loaderA.createProfileView('B', configB);
    const runtimeA = createProfileRuntime({ userProfileId: 'A', configDir: configA, configLoader: loaderA, ptyManager: new PtyManager() });
    const runtimeB = createProfileRuntime({ userProfileId: 'B', configDir: configB, configLoader: loaderB, ptyManager: new PtyManager() });

    expect(runtimeA.configLoader.getGlobalConfigDir()).toBe(runtimeB.configLoader.getGlobalConfigDir());
    expect(runtimeA.paths.sessionsFile).not.toBe(runtimeB.paths.sessionsFile);
    expect(runtimeA.paths.skillsFile).not.toBe(runtimeB.paths.skillsFile);
  });
});
