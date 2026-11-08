import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnConfiguredSession } from '../src/session/configured-session-spawn.js';
import { assertCwdInProfileProjects } from '../src/session/profile-spawn-cwd.js';
import { HeadlessCliRunner } from '../src/session/headless-cli-runner.js';
import { SessionManager } from '../src/session/manager.js';
import { OperatorSessionManager } from '../src/session/operator-session-manager.js';
import { normalizeProjectPath } from '../src/session/project-identity.js';
import { ProjectStore } from '../src/session/project-store.js';
import { BUILTIN_SHELL_CLI_TYPE } from '../src/types/session.js';

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'helm-profile-cwd-'));
  return root;
}

function profile(userProfileId: string, ...projectPaths: string[]) {
  const projectStore = new ProjectStore();
  const [canonicalPath, ...alternatePaths] = projectPaths;
  const project = projectStore.resolveForPath(canonicalPath);
  for (const alternatePath of alternatePaths) projectStore.addDirectory(project.id, alternatePath);
  return { userProfileId, projectStore };
}

describe('assertCwdInProfileProjects', () => {
  it('accepts descendants of canonical and alternate project folders', () => {
    const base = tempRoot();
    const canonical = join(base, 'canonical');
    const alternate = join(base, 'alternate');
    mkdirSync(join(canonical, 'nested'), { recursive: true });
    mkdirSync(join(alternate, 'nested'), { recursive: true });
    const runtime = profile('child-1', canonical, alternate);

    expect(() => assertCwdInProfileProjects(runtime, join(canonical, 'nested'))).not.toThrow();
    expect(() => assertCwdInProfileProjects(runtime, join(alternate, 'nested'))).not.toThrow();
  });

  it('rejects a sibling path that only shares the project prefix', () => {
    const base = tempRoot();
    const project = join(base, 'project');
    const sibling = join(base, 'project-copy');
    mkdirSync(project);
    mkdirSync(sibling);

    expect(() => assertCwdInProfileProjects(profile('1', project), sibling))
      .toThrow(`"${sibling}"`);
    expect(() => assertCwdInProfileProjects(profile('1', project), sibling))
      .toThrow(/outside the profile's project folders/);
  });

  it.skipIf(process.platform !== 'win32')('matches Windows paths without case sensitivity', () => {
    const base = tempRoot();
    const project = join(base, 'Project');
    const child = join(project, 'Child');
    mkdirSync(child, { recursive: true });

    expect(() => assertCwdInProfileProjects(profile('1', project), `${project.toUpperCase()}\\CHILD`)).not.toThrow();
  });

  it('rejects a symlink inside a project when it resolves outside', () => {
    const base = tempRoot();
    const project = join(base, 'project');
    const outside = join(base, 'outside');
    mkdirSync(project);
    mkdirSync(outside);
    const link = join(project, 'linked-out');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => assertCwdInProfileProjects(profile('1', project), link)).toThrow(/outside the profile's project folders/);
  });

  it('does not let one profile use a path registered only to another profile', () => {
    const base = tempRoot();
    const profileOneProject = join(base, 'profile-one');
    const profileTwoProject = join(base, 'profile-two');
    mkdirSync(profileOneProject);
    mkdirSync(profileTwoProject);
    const profileOne = profile('1', profileOneProject);
    const profileTwo = profile('2', profileTwoProject);

    expect(() => assertCwdInProfileProjects(profileTwo, join(profileOneProject, 'child')))
      .toThrow(/outside the profile's project folders/);
    expect(() => assertCwdInProfileProjects(profileOne, profileOneProject)).not.toThrow();
  });

  it('rejects a normal session spawn before starting a PTY', () => {
    const base = tempRoot();
    const project = join(base, 'profile-two-project');
    const outside = join(base, 'profile-one-project');
    mkdirSync(project);
    mkdirSync(outside);
    const runtime = profile('2', project);
    const sessionManager = new SessionManager({
      userProfileId: runtime.userProfileId,
      sessionsFile: join(base, 'sessions.json'),
      projectStore: runtime.projectStore,
    });
    const ptyManager = { spawn: vi.fn(() => ({ pid: 1234 })), write: vi.fn() };

    expect(() => spawnConfiguredSession({
      ptyManager: ptyManager as any,
      sessionManager,
      command: 'cli',
      cwd: outside,
    })).toThrow(new Error(`Cannot spawn in cwd "${outside}": it is outside the profile's project folders.`));
    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });

  it('defaults a cwd-less shell spawn to the first project by canonical path', () => {
    const base = tempRoot();
    const zProject = join(base, 'z-project');
    const aProject = join(base, 'a-project');
    mkdirSync(zProject);
    mkdirSync(aProject);
    const projectStore = new ProjectStore();
    projectStore.resolveForPath(zProject);
    projectStore.resolveForPath(aProject);
    const sessionManager = new SessionManager({
      userProfileId: '1',
      sessionsFile: join(base, 'sessions.json'),
      projectStore,
    });
    const ptyManager = { spawn: vi.fn(() => ({ pid: 1234 })), write: vi.fn() };

    const result = spawnConfiguredSession({
      ptyManager: ptyManager as any,
      sessionManager,
      cliType: BUILTIN_SHELL_CLI_TYPE,
    });

    expect(ptyManager.spawn).toHaveBeenCalledWith({ sessionId: result.sessionId, cwd: normalizeProjectPath(aProject) });
    expect(sessionManager.getSession(result.sessionId)?.workingDir).toBe(normalizeProjectPath(aProject));
  });

  it('explains that a project must be added before a cwd-less spawn', () => {
    const base = tempRoot();
    const projectStore = new ProjectStore();
    const sessionManager = new SessionManager({
      userProfileId: '1',
      sessionsFile: join(base, 'sessions.json'),
      projectStore,
    });
    const ptyManager = { spawn: vi.fn(() => ({ pid: 1234 })), write: vi.fn() };

    expect(() => spawnConfiguredSession({
      ptyManager: ptyManager as any,
      sessionManager,
      cliType: BUILTIN_SHELL_CLI_TYPE,
    })).toThrow(/add a project first/i);
    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });

  it('rejects an operator spawn when its home is outside that profile project folders', () => {
    const base = tempRoot();
    const project = join(base, 'profile-two-project');
    const outside = join(base, 'operator-home');
    mkdirSync(project);
    mkdirSync(outside);
    const runtime = profile('2', project);
    const sessionManager = new SessionManager({
      userProfileId: runtime.userProfileId,
      sessionsFile: join(base, 'sessions.json'),
      projectStore: runtime.projectStore,
    });
    const ptyManager = { spawn: vi.fn(() => ({ pid: 1234 })), write: vi.fn() };
    const operator = new OperatorSessionManager({
      sessionManager,
      getConfig: () => ({ enabled: true, cliType: 'cli', compactEveryMinutes: 0, rules: '' }),
      spawn: params => {
        const spawned = spawnConfiguredSession({
          ptyManager: ptyManager as any,
          sessionManager,
          command: 'cli',
          cliType: params.cliType,
          cwd: params.cwd,
          sessionName: params.sessionName,
          contextText: params.contextText,
          role: params.role,
          locked: params.locked,
        });
        return { sessionId: spawned.sessionId };
      },
      clear: async () => {},
      isHandoverPending: () => false,
      homeDir: () => outside,
    });

    expect(() => operator.ensure()).toThrow(
      new Error(`Cannot spawn in cwd "${outside}": it is outside the profile's project folders.`),
    );
    expect(ptyManager.spawn).not.toHaveBeenCalled();
    operator.dispose();
  });

  it('fails closed when the owning profile or its ProjectStore is missing', () => {
    const cwd = join(tempRoot(), 'outside');

    expect(() => assertCwdInProfileProjects({ userProfileId: '', projectStore: new ProjectStore() }, cwd))
      .toThrow(new Error(`Cannot spawn in cwd "${cwd}": it is outside the profile's project folders.`));
    expect(() => assertCwdInProfileProjects({ userProfileId: '1' } as any, cwd))
      .toThrow(new Error(`Cannot spawn in cwd "${cwd}": it is outside the profile's project folders.`));
  });

  it('blocks a headless spawn when its cwd is outside the caller profile', async () => {
    const base = tempRoot();
    const project = join(base, 'project');
    const outside = join(base, 'outside');
    mkdirSync(project);
    mkdirSync(outside);
    const runtime = profile('2', project);
    const pty = { spawn: () => { throw new Error('PTY should not spawn'); }, kill: () => {} };
    const runner = new HeadlessCliRunner({
      pty: pty as any,
      profileRuntime: runtime,
      getWorkDir: (id: string) => join(outside, id),
      timeoutMs: 10,
    } as any);

    await expect(runner.run({ id: 'headless-cli', kind: 'cli', headlessCommand: 'cli < "{promptFile}" > "{outputFile}"' }, { prompt: 'p' }))
      .rejects.toThrow(/outside the profile's project folders/);
  });
});
