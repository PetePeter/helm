import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';
import { HelmMessService, MESS_MAX_TEXT_LENGTH } from '../src/mcp/services/helm-mess-service.js';
import { MessManager } from '../src/session/mess-manager.js';
import { MessPersistence } from '../src/session/mess-persistence.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProjectRecord } from '../src/types/project.js';
import { unusedPlanAttachmentManager } from './helpers/plan-attachment-manager.js';

const project: ProjectRecord = { id: 'mess-project', name: 'Mess Project', canonicalPath: 'C:/mess-project', createdAt: 1, updatedAt: 1 };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const POSTED_AT = new Date(2026, 4, 17, 9, 5).getTime();

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'helm-mess-mcp-'));
  directories.push(directory);
  const projects = {
    getById: (id: string) => id === project.id ? project : undefined,
    findByPath: (path: string) => path === project.canonicalPath ? project : undefined,
    list: () => [project],
    save: () => {},
  };
  const sessions = new SessionManager(projects as any);
  const manager = new MessManager(sessions, projects as any, {
    now: () => POSTED_AT,
    persistenceFactory: projectId => new MessPersistence(projectId, { directory }),
  });
  const service = new HelmControlService({} as any, sessions, {} as any, {} as any, unusedPlanAttachmentManager(), undefined, undefined, projects as any);
  service.setMessManager(manager);
  const deps = { service, setPlanStateWithValidation: () => undefined, completePlanWithValidation: () => undefined };
  return { service, deps, sessions, mess: new HelmMessService(manager, sessions) };
}

function addSession(sessions: SessionManager, id: string, name: string): void {
  sessions.addSession({ id, name, cliType: 'test', processId: 1, workingDir: project.canonicalPath });
}

describe('MCP Mess surface', () => {
  it('returns the exact empty check shape and wires all tools', async () => {
    const { deps, sessions } = setup();
    addSession(sessions, 'receiver', 'memories');

    expect(await callMcpTool(deps, 'mess_check', {}, { sessionId: 'receiver' })).toEqual({ new: 0 });
    expect(['mess_post', 'mess_check', 'mess_history'].every(name => MCP_TOOLS.some(tool => tool.name === name))).toBe(true);
  });

  it('uses authenticated identity, projects labels, and renders a direct message as me', async () => {
    const { deps, sessions } = setup();
    addSession(sessions, 'sender', 'planner');
    addSession(sessions, 'receiver', 'memories');
    await callMcpTool(deps, 'mess_check', {}, { sessionId: 'receiver' });

    await callMcpTool(deps, 'mess_post', { text: 'hello', to: 'memories', fromSessionId: 'sender' }, { sessionId: 'sender' });

    const result = await callMcpTool(deps, 'mess_check', {}, { sessionId: 'receiver' }) as Record<string, unknown>;
    expect(result).toMatchObject({
      new: 1,
      hasMore: false,
      msgs: [{ seq: 1, from: 'planner', to: 'me', text: 'hello' }],
    });
    expect(result).not.toHaveProperty('oldestSeq');
    // The agent and the human beside it must name a message by the same clock,
    // so wire times are local, never UTC.
    expect((result.msgs as Array<{ t: string }>)[0].t).toBe('09:05');
  });

  it('keeps history cursor-neutral, bounded, and reports truncation', async () => {
    const { deps, sessions } = setup();
    addSession(sessions, 'sender', 'planner');
    addSession(sessions, 'receiver', 'memories');
    await callMcpTool(deps, 'mess_check', {}, { sessionId: 'receiver' });
    await callMcpTool(deps, 'mess_post', { text: 'one' }, { sessionId: 'sender' });
    await callMcpTool(deps, 'mess_post', { text: 'two' }, { sessionId: 'sender' });

    expect(await callMcpTool(deps, 'mess_history', { sinceHours: 1, limit: 1 }, { sessionId: 'receiver' })).toMatchObject({
      hasMore: true,
      groups: [{ label: '2026-05-17', msgs: [{ text: 'two', t: '09:05' }] }],
    });
    expect(await callMcpTool(deps, 'mess_check', {}, { sessionId: 'receiver' })).toMatchObject({
      new: 2,
      msgs: [{ text: 'one' }, { text: 'two' }],
    });
  });

  it('rejects anonymous, peer, and oversized callers at the MCP boundary', async () => {
    const { deps, sessions } = setup();
    addSession(sessions, 'sender', 'planner');

    await expect(callMcpTool(deps, 'mess_check', {}, {})).rejects.toThrow('mess_check could not determine your session');
    await expect(callMcpTool(deps, 'mess_check', {}, { sessionId: 'peer:remote' })).rejects.toThrow('local-only');
    await expect(callMcpTool(deps, 'mess_history', { sinceHours: 1 }, { sessionId: 'peer:remote' })).rejects.toThrow('local-only');
    await expect(callMcpTool(deps, 'mess_post', { text: 'x'.repeat(MESS_MAX_TEXT_LENGTH + 1) }, { sessionId: 'sender' })).rejects.toThrow(/character.*limit/);
    await expect(callMcpTool(deps, 'mess_post', { text: '😀'.repeat(1_001) }, { sessionId: 'sender' })).rejects.toThrow(/byte.*limit/);
  });

  it('rejects an invalid history limit and exposes the social-convention guide', async () => {
    const { deps, sessions, service } = setup();
    addSession(sessions, 'sender', 'planner');

    await expect(callMcpTool(deps, 'mess_history', { sinceHours: 1, limit: 101 }, { sessionId: 'sender' })).rejects.toThrow('limit must be an integer');
    const skill = service.getSkill('sys-mess');
    expect(skill?.body).toContain('SOCIAL CONVENTION ONLY');
    expect(skill?.body).toContain('no lock');
  });
});
