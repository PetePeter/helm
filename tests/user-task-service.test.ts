import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { UserTaskManager } = await import('../src/session/user-task-manager.js');
const { createUserTaskStore } = await import('../src/session/user-task-persistence.js');
const { HelmUserTaskService } = await import('../src/mcp/services/helm-user-task-service.js');

describe('HelmUserTaskService', () => {
  let dir: string;
  let manager: InstanceType<typeof UserTaskManager>;
  let service: InstanceType<typeof HelmUserTaskService>;
  const sessions = new Map([['s1', { id: 's1', name: 'helm-core', cliType: 'claude-code', workingDir: 'x:/repo' }]]);
  const artifact = {
    id: 'a1', sessionId: 's1', title: 'Report', kind: 'markdown', createdAt: 1, updatedAt: 1,
    versions: [{ version: 1, content: 'old', createdAt: 1 }, { version: 2, content: '# new', createdAt: 2 }],
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm-user-task-svc-'));
    manager = new UserTaskManager(createUserTaskStore(dir));
    service = new HelmUserTaskService({
      manager,
      getSession: id => sessions.get(id),
      findProjectIdByPath: path => (path === 'x:/repo' ? 'proj-1' : undefined),
      projectExists: id => id === 'proj-1',
      getArtifact: id => (id === 'a1' ? artifact as never : null),
      getPlan: id => (id === 'p1' ? { id: 'p1', humanId: 'P-0001', title: 'Ship it', description: 'Do things', status: 'ready', dirPath: 'x:/repo' } as never : null),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records an AI caller as a session snapshot with its project, which survives the session closing', () => {
    const row = service.add({ sessionId: 's1' }, { title: 'Approve colours' });
    expect(row).toMatchObject({ author: 'helm-core', projectId: 'proj-1' });
    sessions.delete('s1');
    expect(manager.get(row.id).author).toEqual({ kind: 'ai', name: 'helm-core', cliType: 'claude-code', dir: 'x:/repo', sessionId: 's1' });
    sessions.set('s1', { id: 's1', name: 'helm-core', cliType: 'claude-code', workingDir: 'x:/repo' });
  });

  it('treats a phone caller as the user, with no project', () => {
    const row = service.add({ sessionId: 'mobile:dev-1' }, { title: 'Buy cable' });
    expect(manager.get(row.id)).toMatchObject({ author: { kind: 'user' } });
    expect(row.projectId).toBeUndefined();
  });

  it('snapshots the latest artifact version and a plan with its live id', () => {
    const row = service.add({ sessionId: 's1' }, { title: 'Review', attach: [{ artifactId: 'a1' }, { planId: 'p1' }] });
    const task = manager.get(row.id);
    expect(task.attachments.map(a => [a.kind, a.title, a.planId])).toEqual([
      ['artifact', 'Report', undefined], ['plan', 'P-0001 Ship it', 'p1'],
    ]);
    expect(service.get(row.id, task.attachments[0].id)).toMatchObject({ encoding: 'utf8', content: '# new' });
    expect(String((service.get(row.id, task.attachments[1].id) as { content: string }).content)).toContain('Do things');
  });

  it("refuses another session's artifact and an unknown project", () => {
    sessions.set('s2', { id: 's2', name: 'other', cliType: 'x', workingDir: 'y:/' });
    expect(() => service.add({ sessionId: 's2' }, { title: 'x', attach: [{ artifactId: 'a1' }] })).toThrow(/Artifact not found/);
    expect(() => service.add({ sessionId: 's1' }, { title: 'x', projectId: 'nope' })).toThrow(/Project not found/);
  });

  it('copies a file attachment and returns binary content as base64', () => {
    const file = join(dir, 'shot.png');
    writeFileSync(file, Buffer.from([1, 2, 3]));
    const row = service.add({ sessionId: 's1' }, { title: 'Look', attach: [{ filePath: file }] });
    const att = manager.get(row.id).attachments[0];
    expect(att).toMatchObject({ kind: 'file', title: 'shot.png', contentType: 'image/png' });
    expect(service.get(row.id, att.id)).toMatchObject({ encoding: 'base64', content: 'AQID' });
  });

  it('lists open tasks by default and filters by project ("" = General)', () => {
    const a = service.add({ sessionId: 's1' }, { title: 'A' });
    service.add({ sessionId: 'mobile:d' }, { title: 'B' });
    service.done(a.id);
    expect(service.list().map(r => r.title)).toEqual(['B']);
    expect(service.list({ includeDone: true, projectId: 'proj-1' }).map(r => r.title)).toEqual(['A']);
    expect(service.list({ projectId: '' }).map(r => r.title)).toEqual(['B']);
  });
});
