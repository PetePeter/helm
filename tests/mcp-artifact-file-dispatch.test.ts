import { describe, expect, it, vi } from 'vitest';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';

function makeDeps() {
  const service = {
    createArtifactFromFile: vi.fn(() => ({ artifact: { id: 'a1' } })),
    updateArtifactFromFile: vi.fn(() => ({ artifact: { id: 'a1' }, attachment: { id: 'att-1' } })),
    setArtifactIntent: vi.fn(() => ({ id: 'a1', intent: 'manifesto' })),
    getArtifact: vi.fn(() => ({ artifactId: 'a1', version: 1, tempPath: 'C:\\Temp\\artifact.md' })),
  };
  return {
    service: service as any,
    serviceMocks: service,
    setPlanStateWithValidation: vi.fn(),
    completePlanWithValidation: vi.fn(),
  };
}

describe('MCP artifact file dispatch', () => {
  it('dispatches artifact_create filePath without sending file bytes through MCP', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'artifact_create', {
      filePath: 'C:\\reports\\result.pdf',
      contentType: 'application/pdf',
    }, { sessionId: 'sess-1' });

    expect(deps.serviceMocks.createArtifactFromFile).toHaveBeenCalledWith(
      'sess-1', 'C:\\reports\\result.pdf', undefined, 'application/pdf', undefined,
    );
  });

  it('dispatches artifact_update filePath and artifact_get temp options', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'artifact_update', {
      id: 'a1', filePath: 'C:\\reports\\new.pdf', contentType: 'application/pdf',
    }, { sessionId: 'sess-1' });
    await callMcpTool(deps, 'artifact_get', {
      id: 'a1', version: 2, asFile: true,
    }, { sessionId: 'sess-1' });

    expect(deps.serviceMocks.updateArtifactFromFile).toHaveBeenCalledWith(
      'sess-1', 'a1', 'C:\\reports\\new.pdf', 'application/pdf', undefined,
    );
    expect(deps.serviceMocks.getArtifact).toHaveBeenCalledWith(
      'sess-1', 'a1', 2, { asFile: true },
    );
  });

  it('dispatches a metadata-only artifact intent change', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'artifact_set_intent', { id: 'a1', intent: 'manifesto' }, { sessionId: 'sess-1' });
    expect(deps.serviceMocks.setArtifactIntent).toHaveBeenCalledWith('sess-1', 'a1', 'manifesto');
  });

  it('rejects content and filePath together', async () => {
    const deps = makeDeps();
    await expect(callMcpTool(deps, 'artifact_create', {
      title: 'Bad', kind: 'markdown', content: 'inline', filePath: 'C:\\bad.txt',
    }, { sessionId: 'sess-1' })).rejects.toThrow('either content or filePath');
  });
});
