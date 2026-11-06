import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './helpers/temp-root.js';
import { HelmControlService } from '../src/mcp/helm-control-service.js';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';
import { MemoryAttachmentManager } from '../src/session/memory-attachment-manager.js';
import { MemoryManager } from '../src/session/memory-manager.js';
import { ArtifactTempRegistry } from '../src/session/artifact-temp-registry.js';

function makeService(
  manager: MemoryManager,
  attachments: MemoryAttachmentManager,
  tempRegistry?: ArtifactTempRegistry,
): HelmControlService {
  const service = new HelmControlService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  service.setMemoryManager(manager, attachments, tempRegistry);
  return service;
}

function makeDispatcher(service: HelmControlService) {
  return {
    service,
    setPlanStateWithValidation: () => undefined,
    completePlanWithValidation: () => undefined,
  };
}

describe('MCP memory surface', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    root = makeTempRoot('helm-memory-mcp-');
    const attachments = new MemoryAttachmentManager(join(root, 'attachments'), join(root, 'temp'));
    const tempRegistry = new ArtifactTempRegistry();
    const ids = ['a', 'b', 'c'];
    const manager = new MemoryManager({
      attachmentManager: attachments,
      idFactory: () => ids.shift()!,
      resolveSessionProject: (sessionId) => ({ ideaProject: 'p-idea', ideaReader: 'p-idea', otherProject: 'p-other' }[sessionId] ?? null),
    });
    const service = makeService(manager, attachments, tempRegistry);
    return { manager, attachments, service, tempRegistry, deps: makeDispatcher(service) };
  }

  it('enforces authenticated ownership and forwards graphDepth through the dispatcher', async () => {
    const { service, deps } = setup();
    const first = await callMcpTool(deps, 'memory_create', { tldr: 'first', content: 'one' }, { sessionId: 's1' }) as { id: string };
    const second = await callMcpTool(deps, 'memory_create', { tldr: 'second', content: 'two' }, { sessionId: 's1' }) as { id: string };
    await callMcpTool(deps, 'memory_link', { fromId: first.id, toId: second.id }, { sessionId: 's1' });

    const traversal = await callMcpTool(
      deps,
      'memory_get',
      { id: first.id, graphDepth: 1 },
      { sessionId: 's1' },
    ) as { graphDepth: number; entries: Array<{ id: string }> };
    expect(traversal.graphDepth).toBe(1);
    expect(traversal.entries.map((entry) => entry.id)).toEqual([first.id, second.id]);

    await expect(callMcpTool(deps, 'memory_get', { id: first.id }, { sessionId: 's2' }))
      .rejects.toThrow(`Memory not found: ${first.id}`);
    await expect(callMcpTool(deps, 'memory_list', {}, {}))
      .rejects.toThrow('memory_list could not determine your session');
    expect(service.listMemorySummaries('s2')).toEqual([]);
  });

  it('supports regex search and pure export without attachment bytes or storage paths', async () => {
    const { deps } = setup();
    const memory = await callMcpTool(
      deps,
      'memory_create',
      { tldr: 'Alpha', content: 'secret body' },
      { sessionId: 's1' },
    ) as { id: string };
    const search = await callMcpTool(
      deps,
      'memory_search',
      { query: '^Al', regex: true },
      { sessionId: 's1' },
    ) as { regex: boolean; hits: Array<{ id: string }> };
    expect(search.regex).toBe(true);
    expect(search.hits.map((hit) => hit.id)).toEqual([memory.id]);

    const exported = await callMcpTool(
      deps,
      'memory_export',
      { format: 'json', rootId: memory.id, graphDepth: 1 },
      { sessionId: 's1' },
    ) as { format: string; content: string };
    expect(exported.format).toBe('json');
    expect(JSON.parse(exported.content).rootId).toBe(memory.id);
    expect(exported.content).not.toContain('secret.bin');
    expect(exported.content).not.toContain('memory-attachments');
  });

  it('memory_search answers the five best hits as id + tldr and counts the rest', async () => {
    root = makeTempRoot('helm-memory-mcp-');
    const attachments = new MemoryAttachmentManager(join(root, 'attachments'), join(root, 'temp'));
    let sequence = 0;
    const manager = new MemoryManager({ attachmentManager: attachments, idFactory: () => `m${++sequence}` });
    const deps = makeDispatcher(makeService(manager, attachments));
    for (let index = 0; index < 7; index += 1) {
      await callMcpTool(deps, 'memory_create', { tldr: `vite note ${index}`, content: 'a long body nobody asked for' }, { sessionId: 's1' });
    }

    const search = await callMcpTool(deps, 'memory_search', { query: 'vite' }, { sessionId: 's1' }) as {
      matched: number; hits: Array<{ id: string; tldr: string }>;
    };

    expect(search.matched).toBe(7);
    expect(search.hits).toHaveLength(5);
    expect(search.hits[0]).toMatchObject({ id: expect.any(String), tldr: expect.stringContaining('vite note') });
    expect(JSON.stringify(search)).not.toContain('nobody asked for');
  });

  it('memory_get returns the memory in full and its neighbours as id + tldr', async () => {
    const { deps } = setup();
    const main = await callMcpTool(deps, 'memory_create', { tldr: 'root', content: 'root body' }, { sessionId: 's1' }) as { id: string };
    const linked = await callMcpTool(deps, 'memory_create', { tldr: 'neighbour', content: 'neighbour body' }, { sessionId: 's1' }) as { id: string };
    await callMcpTool(deps, 'memory_link', { fromId: main.id, toId: linked.id, type: 'supports' }, { sessionId: 's1' });

    const traversal = await callMcpTool(deps, 'memory_get', { id: main.id }, { sessionId: 's1' }) as {
      entries: Array<{ id: string; record?: Record<string, unknown>; via?: { type?: string } }>;
    };

    expect(traversal.entries[0].record).toMatchObject({ id: main.id, content: 'root body' });
    expect(traversal.entries[1].record).toEqual({ id: linked.id, tldr: 'neighbour' });
    expect(traversal.entries[1].via?.type).toBe('supports');
  });

  it('memory_get keeps deeper neighbours compact and loop markers intact', async () => {
    const { deps } = setup();
    for (const tldr of ['root', 'near', 'far']) {
      await callMcpTool(deps, 'memory_create', { tldr, content: `${tldr} body` }, { sessionId: 's1' });
    }
    for (const [fromId, toId] of [['a', 'b'], ['b', 'c'], ['c', 'a']]) {
      await callMcpTool(deps, 'memory_link', { fromId, toId }, { sessionId: 's1' });
    }

    const traversal = await callMcpTool(deps, 'memory_get', { id: 'a', graphDepth: 2 }, { sessionId: 's1' }) as {
      entries: Array<{ id: string; status: string; breadcrumbs: string[]; record?: Record<string, unknown> }>;
    };

    expect(traversal.entries.map((entry) => [entry.id, entry.status, entry.record])).toEqual([
      ['a', 'record', expect.objectContaining({ content: 'root body' })],
      ['b', 'record', { id: 'b', tldr: 'near' }],
      ['c', 'record', { id: 'c', tldr: 'far' }],
      ['a', 'cycle', undefined],
    ]);
    expect(traversal.entries[3].breadcrumbs).toEqual(['a', 'b', 'c', 'a']);
  });

  it('adds attachments from an absolute source path and only exposes a safe temp copy on get', async () => {
    const { deps, tempRegistry } = setup();
    const memory = await callMcpTool(
      deps,
      'memory_create',
      { tldr: 'with file', content: 'body' },
      { sessionId: 's1' },
    ) as { id: string };
    const sourcePath = join(root!, 'source.bin');
    writeFileSync(sourcePath, Buffer.from('attachment bytes'));

    const attachment = await callMcpTool(
      deps,
      'memory_attachment_add',
      { memoryId: memory.id, filePath: sourcePath, filename: 'secret.bin', contentType: 'application/octet-stream' },
      { sessionId: 's1' },
    ) as { id: string; filename: string; sizeBytes: number };
    expect(attachment).toMatchObject({ filename: 'secret.bin', sizeBytes: 16 });
    expect(attachment).not.toHaveProperty('tempPath');

    const temp = await callMcpTool(
      deps,
      'memory_attachment_get',
      { memoryId: memory.id, attachmentId: attachment.id },
      { sessionId: 's1' },
    ) as { tempPath: string; attachment: { id: string } };
    expect(tempRegistry.pathsFor('s1')).toContain(temp.tempPath);
    expect(temp.attachment.id).toBe(attachment.id);
    expect(readFileSync(temp.tempPath, 'utf8')).toBe('attachment bytes');
    rmSync(temp.tempPath, { force: true });
  });

  it('rejects an unknown memory_list sort field at the boundary', async () => {
    const { deps } = setup();

    await expect(callMcpTool(deps, 'memory_list', { sortBy: 'whenever' }, { sessionId: 's1' }))
      .rejects.toThrow(/sortBy must be one of/);
    await expect(callMcpTool(deps, 'memory_list', { order: 'sideways' }, { sessionId: 's1' }))
      .rejects.toThrow(/order must be one of/);
  });

  it('ranks memory_list by the requested field', async () => {
    const { deps } = setup();
    const first = await callMcpTool(deps, 'memory_create', { tldr: 'first', content: 'one' }, { sessionId: 's1' }) as { id: string };
    await callMcpTool(deps, 'memory_create', { tldr: 'second', content: 'two' }, { sessionId: 's1' });

    // Reading `first` makes it the most recently accessed.
    await callMcpTool(deps, 'memory_get', { id: first.id }, { sessionId: 's1' });
    const ranked = await callMcpTool(
      deps,
      'memory_list',
      { sortBy: 'accessed', order: 'desc' },
      { sessionId: 's1' },
    ) as Array<{ id: string }>;

    expect(ranked[0].id).toBe(first.id);
  });

  it('lists summaries only: the body comes from memory_get', async () => {
    const { deps } = setup();
    await callMcpTool(deps, 'memory_create', { tldr: 'short', content: 'a long body '.repeat(50) }, { sessionId: 's1' });
    const [item] = await callMcpTool(deps, 'memory_list', {}, { sessionId: 's1' }) as Array<Record<string, unknown>>;
    expect(item).toMatchObject({ tldr: 'short' });
    expect(item).not.toHaveProperty('content');
  });

  it('exposes dormant state changes and project dream results through MCP', async () => {
    const { deps } = setup();
    const memory = await callMcpTool(
      deps,
      'memory_create',
      { tldr: 'temporary', content: 'body' },
      { sessionId: 's1' },
    ) as { id: string };

    expect(await callMcpTool(
      deps,
      'memory_set_dormant',
      { id: memory.id, dormant: true },
      { sessionId: 's1' },
    )).toBe(true);
    expect(await callMcpTool(deps, 'memory_list', {}, { sessionId: 's1' })).toEqual([]);
    await expect(callMcpTool(deps, 'memory_dream', {}, { sessionId: 's1' }))
      .rejects.toThrow('memory_dream requires a project-scoped session');
    expect(await callMcpTool(
      deps,
      'memory_set_dormant',
      { id: memory.id, dormant: false },
      { sessionId: 's1' },
    )).toBe(true);
  });

  it('creates, filters, updates, searches, and gets idea memories by ID through MCP', async () => {
    const { deps } = setup();
    const fact = await callMcpTool(deps, 'memory_create', {
      tldr: 'An odd charger signal', content: 'Confirmed observation.',
    }, { sessionId: 'ideaProject' }) as { id: string };
    const idea = await callMcpTool(deps, 'memory_create', {
      kind: 'idea', tldr: 'An odd charger hypothesis', content: 'Evidence is incomplete.',
    }, { sessionId: 'ideaProject' }) as { id: string; kind: string; ideaStage: string };

    expect(idea).toMatchObject({ kind: 'idea', ideaStage: 'seed' });
    const ideaList = await callMcpTool(deps, 'memory_list', { kind: 'idea' }, { sessionId: 'ideaProject' }) as Array<{ id: string }>;
    const allList = await callMcpTool(deps, 'memory_list', {}, { sessionId: 'ideaProject' }) as Array<{ id: string }>;
    expect(ideaList.map((item) => item.id)).toEqual([idea.id]);
    expect(allList.map((item) => item.id)).toEqual([fact.id, idea.id]);

    const search = await callMcpTool(deps, 'memory_search', { query: 'charger', kind: 'idea' }, { sessionId: 'ideaProject' }) as {
      hits: Array<{ id: string }>;
    };
    expect(search.hits.map((hit) => hit.id)).toEqual([idea.id]);
    const traversal = await callMcpTool(deps, 'memory_get', { id: idea.id }, { sessionId: 'ideaProject' }) as {
      entries: Array<{ id: string }>;
    };
    expect(traversal.entries.map((entry) => entry.id)).toContain(idea.id);

    const updated = await callMcpTool(deps, 'memory_update', {
      id: idea.id, ideaStage: 'growing',
    }, { sessionId: 'ideaProject' }) as { ideaStage: string };
    expect(updated.ideaStage).toBe('growing');
  });

  it('validates idea enums on create, update, list, and search', async () => {
    const { deps } = setup();
    await expect(callMcpTool(deps, 'memory_create', {
      kind: 'fact', tldr: 'invalid kind', content: '',
    }, { sessionId: 'ideaProject' })).rejects.toThrow(/kind must be one of/i);
    await expect(callMcpTool(deps, 'memory_create', {
      kind: 'idea', ideaStage: 'forgotten', tldr: 'invalid stage', content: '',
    }, { sessionId: 'ideaProject' })).rejects.toThrow(/ideaStage must be one of/i);
    const idea = await callMcpTool(deps, 'memory_create', {
      kind: 'idea', tldr: 'An editable seed', content: 'Evidence.',
    }, { sessionId: 'ideaProject' }) as { id: string };
    await expect(callMcpTool(deps, 'memory_update', {
      id: idea.id, ideaStage: 'forgotten',
    }, { sessionId: 'ideaProject' })).rejects.toThrow(/ideaStage must be one of/i);
    await expect(callMcpTool(deps, 'memory_list', { kind: 'fact' }, { sessionId: 'ideaProject' }))
      .rejects.toThrow(/kind must be one of/i);
    await expect(callMcpTool(deps, 'memory_search', { query: 'idea', kind: 'fact' }, { sessionId: 'ideaProject' }))
      .rejects.toThrow(/kind must be one of/i);
  });
});

describe('MCP memory tool discoverability', () => {
  const memoryToolNames = [
    'memory_list', 'memory_get', 'memory_create', 'memory_update', 'memory_delete',
    'memory_search', 'memory_graph', 'memory_export', 'memory_link', 'memory_unlink',
    'memory_dream', 'memory_set_dormant',
    'memory_attachment_add', 'memory_attachment_list', 'memory_attachment_get', 'memory_attachment_delete',
  ];

  it('defines every requested tool with a strict object schema', () => {
    const tools = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
    for (const name of memoryToolNames) {
      const tool = tools.get(name);
      expect(tool, name).toBeDefined();
      expect(tool!.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('exposes idea enums only on create, update, list, and search', () => {
    const tools = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
    const ideaStages = ['seed', 'growing', 'suggested', 'accepted', 'rejected'];
    for (const name of ['memory_create', 'memory_update', 'memory_list', 'memory_search']) {
      expect((tools.get(name)!.inputSchema.properties as any).kind.enum).toEqual(['idea']);
    }
    expect((tools.get('memory_create')!.inputSchema.properties as any).ideaStage.enum).toEqual(['seed']);
    expect((tools.get('memory_update')!.inputSchema.properties as any).ideaStage.enum).toEqual(ideaStages);
    expect((tools.get('memory_get')!.inputSchema.properties as any).kind).toBeUndefined();
  });
});
