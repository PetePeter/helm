/**
 * MCP fetch recording — G5 usage feedback's capture point (plan P-0786).
 *
 * The dispatcher is the one place that knows an item was actually FETCHED
 * (skill_get / memory_get). Only successful fetches of real items count; a
 * caller Helm cannot identify records nothing. This is the mirror of the
 * suggester's onSuggested: suggestion on one side, fetch on the other, and
 * the usage store correlates them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './helpers/temp-root.js';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { callMcpTool, type McpToolDispatcherDeps } from '../src/mcp/tools/dispatcher.js';
import { MemoryAttachmentManager } from '../src/session/memory-attachment-manager.js';
import { MemoryManager } from '../src/session/memory-manager.js';

function makeDeps(
  service: HelmControlService,
  fetched: Array<[string, 'skill' | 'memory', string]>,
): McpToolDispatcherDeps {
  return {
    service,
    setPlanStateWithValidation: () => undefined,
    completePlanWithValidation: () => undefined,
    onItemFetched: (sessionId, type, id) => fetched.push([sessionId, type, id]),
  };
}

describe('MCP fetch recording', () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeService(): { service: HelmControlService; memoryManager: MemoryManager } {
    tempRoot = makeTempRoot('helm-fetch-recording-');
    const service = new HelmControlService({} as never, {} as never, {} as never, {} as never);
    const memoryManager = new MemoryManager();
    service.setMemoryManager(
      memoryManager,
      new MemoryAttachmentManager(join(tempRoot, 'attachments'), join(tempRoot, 'temp')),
    );
    return { service, memoryManager };
  }

  it('records a successful memory_get with the caller session', async () => {
    const { service } = makeService();
    const fetched: Array<[string, 'skill' | 'memory', string]> = [];
    const deps = makeDeps(service, fetched);
    const memory = await callMcpTool(deps, 'memory_create', { tldr: 'T', content: 'c' }, { sessionId: 's1' }) as { id: string };
    await callMcpTool(deps, 'memory_get', { id: memory.id }, { sessionId: 's1' });
    expect(fetched).toEqual([['s1', 'memory', memory.id]]);
  });

  it('records a successful skill_get by id and by resolved type', async () => {
    const { service } = makeService();
    const fetched: Array<[string, 'skill' | 'memory', string]> = [];
    const deps = makeDeps(service, fetched);
    await callMcpTool(deps, 'skill_get', { id: 'sys-session-send-text' }, { sessionId: 's1' });
    await callMcpTool(deps, 'skill_get', { type: 'session-send-text' }, { sessionId: 's1' });
    expect(fetched).toEqual([
      ['s1', 'skill', 'sys-session-send-text'],
      ['s1', 'skill', 'sys-session-send-text'],
    ]);
  });

  it('does not record a failed or missing fetch', async () => {
    const { service } = makeService();
    const fetched: Array<[string, 'skill' | 'memory', string]> = [];
    const deps = makeDeps(service, fetched);
    await expect(callMcpTool(deps, 'memory_get', { id: 'missing' }, { sessionId: 's1' }))
      .rejects.toThrow('Memory not found: missing');
    await expect(callMcpTool(deps, 'skill_get', { id: 'nope' }, { sessionId: 's1' }))
      .rejects.toThrow('Skill not found: nope');
    expect(fetched).toEqual([]);
  });

  it('a caller Helm cannot identify records nothing', async () => {
    const { service } = makeService();
    const fetched: Array<[string, 'skill' | 'memory', string]> = [];
    const deps = makeDeps(service, fetched);
    const memory = await callMcpTool(deps, 'memory_create', { tldr: 'T', content: 'c' }, { sessionId: 's1' }) as { id: string };
    await expect(callMcpTool(deps, 'memory_get', { id: memory.id }, {}))
      .rejects.toThrow('could not determine your session');
    await callMcpTool(deps, 'skill_get', { id: 'sys-session-send-text' }, {});
    expect(fetched).toEqual([]);
  });
});
