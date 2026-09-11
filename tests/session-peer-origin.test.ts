/**
 * Peer-created session origin — a session spawned on THIS machine by a remote
 * Helm peer (via the Fleet proxy) records which peer created it, so the sidebar
 * can mark it visually.
 *
 * The origin is derived from the synthetic proxy identity (`peer:<id>`) that
 * the InboundCallGate dispatches under; a local caller never sets it.
 */

import { describe, it, expect, vi } from 'vitest';
import { HelmSessionService } from '../src/mcp/services/helm-session-service.js';
import { spawnConfiguredSession } from '../src/session/configured-session-spawn.js';
import { proxyAuthContext } from '../src/mcp/peer/proxy-identity.js';
import { mobileAuthContext } from '../src/mobile/mobile-identity.js';

function makeService(added: Array<Record<string, unknown>>) {
  const sessionManager = {
    getAllSessions: vi.fn(() => []),
    getSession: vi.fn(() => null),
    hasSession: vi.fn(() => false),
    addSession: vi.fn((info: Record<string, unknown>) => { added.push(info); }),
    updateSession: vi.fn(),
  };
  const configLoader = {
    getWorkingDirectories: vi.fn(() => [{ path: '/repo/main', name: 'main' }]),
    getCliTypes: vi.fn(() => []),
    getCliTypeEntry: vi.fn(() => ({ name: 'Claude Code', spawnCommand: 'claude' })),
    resolveCliType: vi.fn((ref: string) => ({ id: ref, config: { name: 'Claude Code', spawnCommand: 'claude' } })),
  };
  const ptyManager = {
    spawn: vi.fn(() => ({ pid: 4242 })),
    write: vi.fn(),
    has: vi.fn(() => true),
  };
  const planManager = { getForDirectory: vi.fn(() => []) };
  const service = new HelmSessionService(
    sessionManager as any,
    ptyManager as any,
    configLoader as any,
    planManager as any,
  );
  return { service, sessionManager };
}

describe('HelmSessionService.spawnCli — peer origin', () => {
  it('records the peer id when the creator is a remote-peer proxy identity', () => {
    const added: Array<Record<string, unknown>> = [];
    const { service } = makeService(added);

    service.spawnCli('claude-code', '/repo/main', 'remote work', {
      creatorSessionId: proxyAuthContext('desktop-b').sessionId,
    });

    expect(added[0].createdByPeerId).toBe('desktop-b');
  });

  it('leaves the origin unset for a local session creator', () => {
    const added: Array<Record<string, unknown>> = [];
    const { service } = makeService(added);

    service.spawnCli('claude-code', '/repo/main', 'local work', {
      creatorSessionId: '11111111-2222-3333-4444-555555555555',
    });

    expect(added[0].createdByPeerId).toBeUndefined();
  });

  it('leaves the origin unset when there is no creator at all', () => {
    const added: Array<Record<string, unknown>> = [];
    const { service } = makeService(added);

    service.spawnCli('claude-code', '/repo/main', 'user spawn');

    expect(added[0].createdByPeerId).toBeUndefined();
  });
});

describe('spawnConfiguredSession — peer origin', () => {
  function harness() {
    const addSession = vi.fn();
    return {
      addSession,
      params: {
        ptyManager: { spawn: vi.fn(() => ({ pid: 7 })), write: vi.fn() } as any,
        sessionManager: { addSession, updateSession: vi.fn(), hasSession: vi.fn(() => false) } as any,
        sessionId: 'sess-peer',
        cliType: 'claude-code',
        // No configLoader in this harness, so the command must be explicit —
        // spawnConfiguredSession no longer falls back to executing the cliType.
        command: 'claude',
        cwd: '/repo/main',
      },
    };
  }

  it('threads createdByPeerId onto the stored session', () => {
    const { addSession, params } = harness();

    spawnConfiguredSession({ ...params, createdByPeerId: 'desktop-b' });

    expect(addSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-peer', createdByPeerId: 'desktop-b' }),
    );
  });

  it('omits the key entirely when not supplied', () => {
    const { addSession, params } = harness();

    spawnConfiguredSession(params);

    expect(addSession.mock.calls[0][0]).not.toHaveProperty('createdByPeerId');
  });

  it('threads createdByMobileDeviceId onto the stored session', () => {
    const { addSession, params } = harness();

    spawnConfiguredSession({ ...params, createdByMobileDeviceId: 'device-7' });

    expect(addSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-peer', createdByMobileDeviceId: 'device-7' }),
    );
  });
});

/**
 * The same derivation one prefix along: a phone's `mobile:<deviceId>` proxy
 * identity marks the session as that device's, which is what MobileGate's
 * ownership rule checks before letting a phone close it again.
 */
describe('HelmSessionService.spawnCli — mobile origin', () => {
  it('records the device id when the creator is a mobile proxy identity', () => {
    const added: Array<Record<string, unknown>> = [];
    const { service } = makeService(added);

    service.spawnCli('claude-code', '/repo/main', 'phone work', {
      creatorSessionId: mobileAuthContext('device-7').sessionId,
    });

    expect(added[0].createdByMobileDeviceId).toBe('device-7');
    // The two origins are mutually exclusive — a phone is not a peer.
    expect(added[0].createdByPeerId).toBeUndefined();
  });

  it('leaves the mobile origin unset for a peer-created session', () => {
    const added: Array<Record<string, unknown>> = [];
    const { service } = makeService(added);

    service.spawnCli('claude-code', '/repo/main', 'remote work', {
      creatorSessionId: proxyAuthContext('desktop-b').sessionId,
    });

    expect(added[0].createdByMobileDeviceId).toBeUndefined();
  });

  it('leaves the mobile origin unset for a local session creator', () => {
    const added: Array<Record<string, unknown>> = [];
    const { service } = makeService(added);

    service.spawnCli('claude-code', '/repo/main', 'local work', {
      creatorSessionId: '11111111-2222-3333-4444-555555555555',
    });

    expect(added[0].createdByMobileDeviceId).toBeUndefined();
  });
});
