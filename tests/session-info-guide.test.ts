import { describe, it, expect } from 'vitest';
import { getSessionInfo } from '../src/mcp/guides/session-info-guide';

class FakeSessionManager {
  getSession(_id: string) {
    return { workingDir: '/home/user/project' };
  }
}

describe('getSessionInfo', () => {
  const authContext = { sessionId: 'test-session-123' };
  const mgr = new FakeSessionManager() as any;

  describe('response shape', () => {
    it('has identity, workflow, artifact, and durable memory guidance', () => {
      const info = getSessionInfo(mgr, authContext);
      expect(Object.keys(info).sort()).toEqual(['artifact_viewer', 'chat', 'durable_memory', 'helm_workflow', 'knowledge_model', 'your_mission', 'your_session_id', 'your_working_dir']);
      expect(info.durable_memory.ownership).toContain('authenticated Helm session');
      expect(info.knowledge_model.memory).toContain('project');
    });

    it('artifact_viewer advertises the artifact tools', () => {
      const info = getSessionInfo(mgr, authContext);
      expect(info.artifact_viewer).toContain('artifact_create');
    });

    it('your_session_id reflects authContext', () => {
      const info = getSessionInfo(mgr, authContext);
      expect(info.your_session_id).toBe('test-session-123');
    });

    it('your_working_dir reflects session workingDir', () => {
      const info = getSessionInfo(mgr, authContext);
      expect(info.your_working_dir).toBe('/home/user/project');
    });

    it('your_mission is null without a mission and mirrors it when set', () => {
      expect(getSessionInfo(mgr, authContext).your_mission).toBeNull();
      const mission = { text: 'ship it', setBy: 'ai' as const, setAt: 5 };
      const withMission = { getSession: () => ({ workingDir: '/p', mission }) } as any;
      expect(getSessionInfo(withMission, authContext).your_mission).toEqual(mission);
    });

    it('helm_workflow points to startup skill', () => {
      const info = getSessionInfo(mgr, authContext);
      expect(info.helm_workflow).toContain('startup');
    });

    it('does not include mandatory_rules', () => {
      expect(getSessionInfo(mgr, authContext)).not.toHaveProperty('mandatory_rules');
    });

    it('does not include mcp_url or mcp_token', () => {
      const info = getSessionInfo(mgr, authContext);
      expect(info).not.toHaveProperty('mcp_url');
      expect(info).not.toHaveProperty('mcp_token');
    });

    it('does not include telegramCapabilities', () => {
      expect(getSessionInfo(mgr, authContext)).not.toHaveProperty('telegramCapabilities');
    });

    it('does not include skills or available_projects', () => {
      const info = getSessionInfo(mgr, authContext);
      expect(info).not.toHaveProperty('skills');
      expect(info).not.toHaveProperty('available_projects');
    });
  });

  describe('defaults', () => {
    it('your_session_id is empty string when no authContext', () => {
      expect(getSessionInfo(mgr).your_session_id).toBe('');
    });

    it('your_working_dir is empty string when session not found', () => {
      const emptyMgr = { getSession: () => null } as any;
      expect(getSessionInfo(emptyMgr, authContext).your_working_dir).toBe('');
    });
  });
});
