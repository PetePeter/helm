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
});
