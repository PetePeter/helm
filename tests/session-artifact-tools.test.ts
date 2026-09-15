/**
 * session_artifact_* — the session-ADDRESSED artifact surface.
 *
 * The existing artifact_* family resolves its subject from the caller's own
 * auth context, so from a phone (the mobile:<deviceId> proxy, which owns
 * nothing) it can only ever answer with the proxy's empty data — which is why
 * that family sits in MOBILE_UNREACHABLE_TOOL_PREFIXES. These six take the
 * session as an argument instead, so a phone can aim at a real session and the
 * family it came from stays unreachable.
 *
 * Deletion lives ONLY on the session-addressed surface: the caller-resolved
 * `artifact_delete`/`artifact_delete_all` pair was removed, and there is
 * deliberately no bulk `session_artifact_delete_all` — deletion is per
 * artifact, so an aimed call can never wipe a session it was merely told a
 * name of.
 *
 * A fake service is enough here: what the dispatcher owns is argument
 * validation and the session-existence gate, and a verify-per-call would not
 * say what a wrong argument produced.
 */

import { describe, expect, it, vi } from 'vitest';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';
import { MCP_TOOLS } from '../src/mcp/tools/definitions.js';
import { isMobileUnreachableTool } from '../src/mobile/mobile-gate.js';

const SESSION = '11111111-2222-4333-8444-555555555555';

function makeDeps() {
  const service = {
    getSession: vi.fn((ref: string) => (ref === SESSION ? { id: SESSION, name: 'work' } : null)),
    listArtifacts: vi.fn(() => []),
    readArtifact: vi.fn(() => ({
      id: 'a1', title: 'hi', kind: 'markdown', versionCount: 1,
      createdAt: 1, updatedAt: 1, requestedVersion: 1, requestedVersionContent: '# hi',
    })),
    createArtifact: vi.fn(() => ({ id: 'a2' })),
    updateArtifact: vi.fn(() => ({ id: 'a1', versions: [{ version: 1 }, { version: 2 }] })),
    downloadArtifact: vi.fn(() => ({ filename: 'report.md', mimeType: 'text/markdown', base64: 'I2hp' })),
    deleteArtifact: vi.fn(() => ({ id: 'a1', deleted: true })),
  };
  return {
    service: service as any,
    serviceMocks: service,
    setPlanStateWithValidation: vi.fn(),
    completePlanWithValidation: vi.fn(),
  };
}

describe('session_artifact_* placement against the unreachable filter', () => {
  it('keeps every self-addressed artifact tool unreachable from a phone', () => {
    const artifactPrefixed = MCP_TOOLS.filter(t => t.name.startsWith('artifact_')).map(t => t.name);
    expect(artifactPrefixed.length).toBeGreaterThanOrEqual(5);
    for (const name of artifactPrefixed) expect(isMobileUnreachableTool(name)).toBe(true);
  });

  it('exposes the six session-addressed tools and lets them through the filter', () => {
    const names = [
      'session_artifact_list',
      'session_artifact_get',
      'session_artifact_create',
      'session_artifact_update',
      'session_artifact_download',
      'session_artifact_delete',
    ];
    for (const name of names) {
      expect(MCP_TOOLS.some(t => t.name === name), `${name} is defined`).toBe(true);
      expect(isMobileUnreachableTool(name), `${name} is reachable`).toBe(false);
    }
  });

  it('retires the caller-resolved deletes and offers no bulk delete anywhere', () => {
    // artifact_delete/artifact_delete_all trusted the caller's own auth context
    // (unreachable from a phone), and a session-addressed bulk delete would let
    // one aimed call clear a whole session. Neither name may return.
    for (const gone of ['artifact_delete', 'artifact_delete_all', 'session_artifact_delete_all']) {
      expect(MCP_TOOLS.some(t => t.name === gone), `${gone} is gone`).toBe(false);
    }
  });
});

describe('session_artifact_* session resolution', () => {
  it('refuses an unknown session with the shared session_get error shape', async () => {
    const deps = makeDeps();
    await expect(
      callMcpTool(deps, 'session_artifact_list', { sessionId: 'ghost' }, {}),
    ).rejects.toThrow('Session not found: ghost');
    expect(deps.serviceMocks.listArtifacts).not.toHaveBeenCalled();
  });

  it('checks the named session for every tool in the family, not just reads', async () => {
    const deps = makeDeps();
    await expect(
      callMcpTool(deps, 'session_artifact_create', { sessionId: 'ghost', title: 't', kind: 'md', content: 'c' }, {}),
    ).rejects.toThrow('Session not found: ghost');
    await expect(
      callMcpTool(deps, 'session_artifact_update', { sessionId: 'ghost', artifactId: 'a1', content: 'c' }, {}),
    ).rejects.toThrow('Session not found: ghost');
    await expect(
      callMcpTool(deps, 'session_artifact_download', { sessionId: 'ghost', artifactId: 'a1' }, {}),
    ).rejects.toThrow('Session not found: ghost');
    await expect(
      callMcpTool(deps, 'session_artifact_delete', { sessionId: 'ghost', artifactId: 'a1' }, {}),
    ).rejects.toThrow('Session not found: ghost');
    expect(deps.serviceMocks.createArtifact).not.toHaveBeenCalled();
    expect(deps.serviceMocks.deleteArtifact).not.toHaveBeenCalled();
  });

  it('requires a sessionId argument', async () => {
    const deps = makeDeps();
    await expect(callMcpTool(deps, 'session_artifact_list', {}, {})).rejects.toThrow('sessionId is required');
  });
});

describe('session_artifact_* dispatch', () => {
  it('lists the named session\'s artifacts', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'session_artifact_list', { sessionId: SESSION }, {});
    expect(deps.serviceMocks.listArtifacts).toHaveBeenCalledWith(SESSION);
  });

  it('gets an artifact inline, passing an explicit version through', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'session_artifact_get', { sessionId: SESSION, artifactId: 'a1' }, {});
    await callMcpTool(deps, 'session_artifact_get', { sessionId: SESSION, artifactId: 'a1', version: 2 }, {});
    expect(deps.serviceMocks.readArtifact).toHaveBeenNthCalledWith(1, SESSION, 'a1', undefined);
    expect(deps.serviceMocks.readArtifact).toHaveBeenNthCalledWith(2, SESSION, 'a1', 2);
  });

  it('rejects a nonsense version instead of answering it with silence', async () => {
    // A fractional or non-finite version would pass a bare typeof check and
    // then match no version — reading as "the artifact has no content".
    const deps = makeDeps();
    for (const version of [1.5, 0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(
        callMcpTool(deps, 'session_artifact_get', { sessionId: SESSION, artifactId: 'a1', version }, {}),
      ).rejects.toThrow('version must be a positive integer');
      await expect(
        callMcpTool(deps, 'session_artifact_download', { sessionId: SESSION, artifactId: 'a1', version }, {}),
      ).rejects.toThrow('version must be a positive integer');
    }
    expect(deps.serviceMocks.readArtifact).not.toHaveBeenCalled();
    expect(deps.serviceMocks.downloadArtifact).not.toHaveBeenCalled();
  });

  it('creates with kind md, the only kind a session-addressed call may mint', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'session_artifact_create', {
      sessionId: SESSION, title: 'Report', kind: 'md', content: '# Report',
    }, {});
    expect(deps.serviceMocks.createArtifact).toHaveBeenCalledWith(SESSION, 'Report', 'markdown', '# Report');
  });

  it('rejects every other kind rather than silently coercing it', async () => {
    const deps = makeDeps();
    for (const kind of ['html', 'markdown', 'pdf', 'MD']) {
      await expect(
        callMcpTool(deps, 'session_artifact_create', { sessionId: SESSION, title: 't', kind, content: 'c' }, {}),
      ).rejects.toThrow("kind must be 'md'");
    }
    expect(deps.serviceMocks.createArtifact).not.toHaveBeenCalled();
  });

  it('updates by artifact id', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'session_artifact_update', {
      sessionId: SESSION, artifactId: 'a1', content: 'v2 body',
    }, {});
    expect(deps.serviceMocks.updateArtifact).toHaveBeenCalledWith(SESSION, 'a1', 'v2 body');
  });

  it('downloads as a base64 file envelope', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'session_artifact_download', { sessionId: SESSION, artifactId: 'a1' }, {});
    expect(deps.serviceMocks.downloadArtifact).toHaveBeenCalledWith(SESSION, 'a1', undefined, undefined);
  });

  it('forwards a managed attachment id when one is supplied', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'session_artifact_download', {
      sessionId: SESSION, artifactId: 'a1', attachmentId: 'att-1',
    }, {});
    expect(deps.serviceMocks.downloadArtifact)
      .toHaveBeenCalledWith(SESSION, 'a1', undefined, { attachmentId: 'att-1' });
  });

  it('deletes by artifact id, ownership still enforced inside the service', async () => {
    const deps = makeDeps();
    await callMcpTool(deps, 'session_artifact_delete', { sessionId: SESSION, artifactId: 'a1' }, {});
    expect(deps.serviceMocks.deleteArtifact).toHaveBeenCalledWith(SESSION, 'a1');
  });
});
