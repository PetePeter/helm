/**
 * Session persistence & crash recovery unit tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveSessions, loadSessions, clearPersistedSessions, saveProjectRecords, loadProjectRecords } from '../src/session/persistence.js';
import { SessionManager } from '../src/session/manager.js';
import type { SessionInfo } from '../src/types/session.js';
import type { ProjectRecord } from '../src/types/project.js';
import { normalizeProjectPath as norm } from '../src/session/project-identity.js';
import * as fs from 'node:fs';
import * as YAML from 'yaml';

// Mock fs so we never touch the real filesystem
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock logger to silence output during tests
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockSession1: SessionInfo = {
  id: 'session-1',
  name: 'Claude Code 1',
  cliType: 'claude-code',
  processId: 1001,
};

const mockSession2: SessionInfo = {
  id: 'session-2',
  name: 'Copilot CLI 1',
  cliType: 'copilot-cli',
  processId: 1002,
};

describe('persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveSessions', () => {
    it('writes sessions as YAML to the sessions file', () => {
      saveSessions([mockSession1, mockSession2]);

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions).toHaveLength(2);
      expect(parsed.sessions[0]).toEqual({
        id: 'session-1',
        name: 'Claude Code 1',
        cliType: 'claude-code',
        processId: 1001,
        locked: false,
      });
    });

    it('writes empty sessions array', () => {
      saveSessions([]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions).toEqual([]);
    });

    it('does not throw when writeFileSync fails', () => {
      (fs.writeFileSync as any).mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => saveSessions([mockSession1])).not.toThrow();
    });

    it('persists cliSessionName when present', () => {
      const sessionWithName: SessionInfo = {
        ...mockSession1,
        cliSessionName: 'hub-session-1',
      };
      saveSessions([sessionWithName]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0].cliSessionName).toBe('hub-session-1');
    });

    it('persists currentPlanId when present', () => {
      const sessionWithPlan: SessionInfo = {
        ...mockSession1,
        currentPlanId: 'plan-123',
      };
      saveSessions([sessionWithPlan]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0].currentPlanId).toBe('plan-123');
    });

    it('persists projectId when present', () => {
      const sessionWithProject: SessionInfo = {
        ...mockSession1,
        projectId: 'project-123',
      };
      saveSessions([sessionWithProject]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0].projectId).toBe('project-123');
    });

    it('persists projectPath when present', () => {
      const sessionWithProjectPath: SessionInfo = {
        ...mockSession1,
        projectPath: 'X:\\coding\\repo-a',
      };
      saveSessions([sessionWithProjectPath]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0].projectPath).toBe('X:\\coding\\repo-a');
    });

    it('omits cliSessionName when not present', () => {
      saveSessions([mockSession1]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0]).not.toHaveProperty('cliSessionName');
    });

    it('persists createdAt and lastActiveAt when present (epoch ms)', () => {
      saveSessions([{ ...mockSession1, createdAt: 1700000000000, lastActiveAt: 1700000123456 }]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0].createdAt).toBe(1700000000000);
      expect(parsed.sessions[0].lastActiveAt).toBe(1700000123456);
    });

    it('persists createdByPeerId so a fleet-created session stays marked across restarts', () => {
      saveSessions([{ ...mockSession1, createdByPeerId: 'desktop-b' }]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0].createdByPeerId).toBe('desktop-b');
    });

    it('omits createdByPeerId for locally created sessions', () => {
      saveSessions([mockSession1]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0]).not.toHaveProperty('createdByPeerId');
    });

    it('persists createdByMobileDeviceId so a phone still owns its session after a restart', () => {
      saveSessions([{ ...mockSession1, createdByMobileDeviceId: 'device-7' }]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0].createdByMobileDeviceId).toBe('device-7');
    });

    it('omits createdByMobileDeviceId for locally created sessions', () => {
      saveSessions([mockSession1]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0]).not.toHaveProperty('createdByMobileDeviceId');
    });

    it('does not persist ephemeral activityLevel', () => {
      saveSessions([{ ...mockSession1, activityLevel: 'active' } as any]);

      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions[0]).not.toHaveProperty('activityLevel');
    });
  });

  describe('loadSessions', () => {
    it('returns empty array when file does not exist', () => {
      (fs.existsSync as any).mockReturnValue(false);

      expect(loadSessions()).toEqual([]);
    });

    it('parses YAML and returns sessions', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(
        YAML.stringify({ sessions: [mockSession1] })
      );

      const result = loadSessions();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('session-1');
    });

    it('returns empty array when file has no sessions key', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(YAML.stringify({ other: 'data' }));

      expect(loadSessions()).toEqual([]);
    });

    it('returns empty array when file is corrupt', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockImplementation(() => {
        throw new Error('bad encoding');
      });

      expect(loadSessions()).toEqual([]);
    });

    it('loads cliSessionName from persisted data', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(
        YAML.stringify({ sessions: [{ ...mockSession1, cliSessionName: 'hub-session-1' }] })
      );

      const result = loadSessions();
      expect(result[0].cliSessionName).toBe('hub-session-1');
    });

    it('loads currentPlanId from persisted data', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(
        YAML.stringify({ sessions: [{ ...mockSession1, currentPlanId: 'plan-123' }] })
      );

      const result = loadSessions();
      expect(result[0].currentPlanId).toBe('plan-123');
    });

    it('loads projectId from persisted data', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(
        YAML.stringify({ sessions: [{ ...mockSession1, projectId: 'project-123' }] })
      );

      const result = loadSessions();
      expect(result[0].projectId).toBe('project-123');
    });

    it('loads projectPath from persisted data', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(
        YAML.stringify({ sessions: [{ ...mockSession1, projectPath: 'X:\\coding\\repo-a' }] })
      );

      const result = loadSessions();
      expect(result[0].projectPath).toBe(norm('X:\\coding\\repo-a'));
    });
  });

  describe('project records', () => {
    const mockProject: ProjectRecord = {
      id: 'project-1',
      key: 'git:x:\\coding\\repo\\.git',
      name: 'repo',
      canonicalPath: 'x:\\coding\\repo',
      alternatePaths: ['x:\\coding\\repo-worktree'],
      rootKind: 'git',
      gitCommonDir: 'x:\\coding\\repo\\.git',
      repoRootPath: 'x:\\coding\\repo',
      createdAt: 1,
      updatedAt: 2,
    };

    it('saves project records as json', () => {
      saveProjectRecords([mockProject]);
      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = JSON.parse(content);
      expect(parsed.projects[0].id).toBe('project-1');
      expect(parsed.projects[0].alternatePaths).toEqual(['x:\\coding\\repo-worktree']);
    });

    it('loads project records from json', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify({ projects: [mockProject] }));
      expect(loadProjectRecords()).toEqual([mockProject]);
    });
  });

  describe('clearPersistedSessions', () => {
    it('writes empty sessions when file exists', () => {
      (fs.existsSync as any).mockReturnValue(true);

      clearPersistedSessions();

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const [, content] = (fs.writeFileSync as any).mock.calls[0];
      const parsed = YAML.parse(content);
      expect(parsed.sessions).toEqual([]);
    });

    it('does nothing when file does not exist', () => {
      (fs.existsSync as any).mockReturnValue(false);

      clearPersistedSessions();

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});

describe('SessionManager persistence integration', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  it('persists after addSession', () => {
    manager.addSession(mockSession1);

    // saveSessions is called, which calls writeFileSync
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('stamps createdAt and lastActiveAt on a new session', () => {
    const before = Date.now();
    manager.addSession({ ...mockSession1 });
    const stored = manager.getSession(mockSession1.id)!;

    // Allow a tiny margin for Date.now() resolution/monotonicity quirks on Windows.
    expect(stored.createdAt!).toBeGreaterThanOrEqual(before - 50);
    expect(stored.createdAt!).toBeLessThanOrEqual(Date.now() + 50);
    // lastActiveAt defaults to createdAt for a fresh session.
    expect(stored.lastActiveAt).toBe(stored.createdAt);
  });

  it('preserves persisted createdAt/lastActiveAt on restore (does not overwrite)', () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(
      YAML.stringify({ sessions: [{ ...mockSession1, createdAt: 111, lastActiveAt: 222 }] })
    );

    manager.restoreSessions();

    const stored = manager.getSession(mockSession1.id)!;
    expect(stored.createdAt).toBe(111);
    expect(stored.lastActiveAt).toBe(222);
  });

  it('persists after removeSession', () => {
    manager.addSession(mockSession1);
    manager.addSession(mockSession2);
    vi.clearAllMocks();

    manager.removeSession(mockSession1.id);

    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('persists after setActiveSession changes active', () => {
    manager.addSession(mockSession1);
    manager.addSession(mockSession2);
    vi.clearAllMocks();

    manager.setActiveSession(mockSession2.id);

    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('persists after clear', () => {
    manager.addSession(mockSession1);
    vi.clearAllMocks();

    manager.clear();

    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('restoreSessions loads and adds sessions from disk', () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(
      YAML.stringify({ sessions: [mockSession1, mockSession2] })
    );

    const restored = manager.restoreSessions();

    expect(restored).toHaveLength(2);
    expect(manager.getSessionCount()).toBe(2);
    expect(manager.getSession(mockSession1.id)).toMatchObject({ id: 'session-1' });
    expect(manager.getSession(mockSession2.id)).toMatchObject({ id: 'session-2' });
  });

  it('restoreSessions skips sessions that already exist', () => {
    manager.addSession(mockSession1);
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(
      YAML.stringify({ sessions: [mockSession1, mockSession2] })
    );

    manager.restoreSessions();

    expect(manager.getSessionCount()).toBe(2);
  });

  it('restoreSessions returns empty array when nothing persisted', () => {
    (fs.existsSync as any).mockReturnValue(false);

    const restored = manager.restoreSessions();

    expect(restored).toEqual([]);
    expect(manager.getSessionCount()).toBe(0);
  });

  it('restoreSessions preserves custom session names', () => {
    const renamedSession: SessionInfo = {
      ...mockSession1,
      name: 'My Custom Name',
    };
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(
      YAML.stringify({ sessions: [renamedSession] })
    );

    manager.restoreSessions();

    const restored = manager.getSession(mockSession1.id);
    expect(restored?.name).toBe('My Custom Name');
  });

  it('assigns projectId during addSession when a project store is provided', () => {
    const projectStore = {
      findByPath: vi.fn(() => ({ id: 'project-1', canonicalPath: 'X:\\coding\\repo-a' })),
      save: vi.fn(),
    } as any;
    const projectManager = new SessionManager(projectStore);

    projectManager.addSession({ ...mockSession1, workingDir: 'X:\\coding\\repo-a' });

    expect(projectManager.getSession(mockSession1.id)?.projectId).toBe('project-1');
    expect(projectManager.getSession(mockSession1.id)?.projectPath).toBe(norm('X:\\coding\\repo-a'));
    expect(projectStore.findByPath).toHaveBeenCalledWith('X:\\coding\\repo-a');
  });

  it('rename + persist + restore round-trips the custom name', () => {
    manager.addSession(mockSession1);
    manager.renameSession(mockSession1.id, 'Renamed Session');

    // Capture what was written to disk
    const lastWrite = (fs.writeFileSync as any).mock.calls.at(-1);
    const savedYaml = YAML.parse(lastWrite[1]);
    expect(savedYaml.sessions[0].name).toBe('Renamed Session');

    // Simulate reload from disk
    const manager2 = new SessionManager();
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(lastWrite[1]);
    manager2.restoreSessions();

    expect(manager2.getSession(mockSession1.id)?.name).toBe('Renamed Session');
  });
});


