/**
 * Tool definition surface tests (P-0343).
 * Verifies append tools are absent and context_update has expectedUpdatedAt.
 */
import { describe, it, expect } from 'vitest';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';

const names = MCP_TOOLS.map((t) => t.name);

describe('MCP tool definitions (P-0343)', () => {
  it('context_append is absent from tool list', () => {
    expect(names).not.toContain('context_append');
  });

  it('sequence_memory_append is absent from tool list', () => {
    expect(names).not.toContain('sequence_memory_append');
  });

  it('context_update includes expectedUpdatedAt in schema', () => {
    const def = MCP_TOOLS.find((t) => t.name === 'context_update');
    expect(def).toBeDefined();
    expect(def!.inputSchema.properties).toHaveProperty('expectedUpdatedAt');
  });

  it('context_update expectedUpdatedAt is not required', () => {
    const def = MCP_TOOLS.find((t) => t.name === 'context_update');
    const required: string[] = def!.inputSchema.required ?? [];
    expect(required).not.toContain('expectedUpdatedAt');
  });

  it('documents checking a new session after spawn', () => {
    const def = MCP_TOOLS.find((tool) => tool.name === 'session_create')!;
    expect(def.description).toContain('about 5 seconds after spawning');
    expect(def.description).toContain('session_read_terminal');
    expect(def.description).toContain('initialPrompt was supplied');
    expect(def.description).toContain('report that instead of sending more work');
    expect(def.description).toContain('Claude Code');
    expect(def.description).toContain('Codex');
    expect(def.description).toContain('Copilot CLI');
  });

  it('plan_create exposes completionRecap as an optional boolean', () => {
    const def = MCP_TOOLS.find((t) => t.name === 'plan_create');
    const properties = def!.inputSchema.properties as Record<string, unknown>;
    const required: string[] = def!.inputSchema.required ?? [];

    expect(properties.completionRecap).toEqual({ type: 'boolean' });
    expect(required).not.toContain('completionRecap');
  });

  it('documents file ownership and temp-path cleanup for artifact MCP tools', () => {
    const create = MCP_TOOLS.find((t) => t.name === 'artifact_create')!;
    const update = MCP_TOOLS.find((t) => t.name === 'artifact_update')!;
    const get = MCP_TOOLS.find((t) => t.name === 'artifact_get')!;
    expect(create.description).toContain('caller owns the source file');
    expect(update.inputSchema.properties).toHaveProperty('filePath');
    expect(get.inputSchema.properties).toHaveProperty('asFile');
    expect(get.description).toContain('caller-owned');
  });

  it('exposes normal/manifesto intent on artifact create/update plus a metadata-only setter', () => {
    const create = MCP_TOOLS.find((t) => t.name === 'artifact_create')!;
    const update = MCP_TOOLS.find((t) => t.name === 'artifact_update')!;
    const set = MCP_TOOLS.find((t) => t.name === 'artifact_set_intent')!;
    expect(create.inputSchema.properties.intent.enum).toEqual(['normal', 'manifesto']);
    expect(update.inputSchema.properties.intent.enum).toEqual(['normal', 'manifesto']);
    expect(set.inputSchema.required).toEqual(['id', 'intent']);
  });

  it('exposes recycle-bin search filters and an expected-name restore guard', () => {
    const search = MCP_TOOLS.find(tool => tool.name === 'recycle_bin_search');
    const restore = MCP_TOOLS.find(tool => tool.name === 'recycle_bin_restore');

    expect(search).toBeDefined();
    expect(search!.inputSchema.properties).toHaveProperty('query');
    expect(search!.inputSchema.properties).toHaveProperty('dirPath');
    expect(search!.inputSchema.properties).toHaveProperty('cliType');
    expect(search!.inputSchema.properties).toHaveProperty('limit');
    expect(restore).toBeDefined();
    expect(restore!.inputSchema.properties).toHaveProperty('id');
    expect(restore!.inputSchema.properties).toHaveProperty('name');
    expect(restore!.inputSchema.required).toEqual(['id']);
  });
});
