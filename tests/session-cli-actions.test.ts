/**
 * Worker-control MCP actions — session_clear / session_compact / session_export.
 * Verifies helmActions mapping resolution, $param substitution, and unconfigured errors.
 * The delivery boundary (deliverPromptSequenceToSession) is mocked to capture the
 * resolved sequence string that would be pasted into the target PTY.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { deliverSpy } = vi.hoisted(() => ({ deliverSpy: vi.fn(async () => undefined) }));

vi.mock('../src/session/sequence-delivery.js', () => ({
  deliverPromptSequenceToSession: deliverSpy,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HelmSessionDeliveryService } from '../src/mcp/services/helm-session-delivery-service.js';
import type { CliTypeConfig } from '../src/config/loader.js';

function makeService(entry: Partial<CliTypeConfig> | null, ptyRunning = true) {
  const session = { id: 's1', name: 'worker', cliType: 'claude-code' };
  const sessionManager = {
    getSession: (id: string) => (id === 's1' ? session : null),
    getAllSessions: () => [session],
  };
  const ptyManager = { has: () => ptyRunning };
  const configLoader = { getCliTypeEntry: () => entry, getCliTypeLabel: (ref: string) => ref };
  // Records arm order against deliverSpy so "armed before the command was
  // written" is assertable, not merely "both happened".
  const armed: Array<{ sessionId: string; text: string; deliveriesBefore: number }> = [];
  const handover = {
    arm: (sessionId: string, text: string) =>
      armed.push({ sessionId, text, deliveriesBefore: deliverSpy.mock.calls.length }),
  };
  const service = new HelmSessionDeliveryService(
    sessionManager as any,
    ptyManager as any,
    configLoader as any,
    handover,
  );
  return { service, session, armed };
}

/** Extract the `text` passed to the (mocked) delivery call at index. */
function deliveredText(callIndex = 0): string {
  return deliverSpy.mock.calls[callIndex][0].text;
}

describe('session_compact', () => {
  beforeEach(() => {
    deliverSpy.mockClear();
    process.env.HELM_CLEAR_SETTLE_DELAY_MS = '0';
  });

  it('substitutes $instruction into the configured compact command', async () => {
    const { service } = makeService({ helmActions: { compact: '/compact $instruction{Enter}' } });

    const result = await service.compactSession('s1', { instruction: 'keep the auth work' });

    expect(deliveredText()).toBe('/compact keep the auth work{Enter}');
    expect(result).toMatchObject({ ok: true, action: 'compact', sessionId: 's1' });
    expect(result.note).toMatch(/~1 minute/);
  });

  it('substitutes empty string when no instruction is given', async () => {
    const { service } = makeService({ helmActions: { compact: '/compact $instruction{Enter}' } });
    await service.compactSession('s1', {});
    expect(deliveredText()).toBe('/compact {Enter}');
  });

  // Regression: the shipped defaults said $instructions, and a raw substring
  // replace of $instruction left a stray "s" — "/compact s" wedged Codex.
  it('treats $instructions as the same placeholder, leaving no stray suffix', async () => {
    const { service } = makeService({ helmActions: { compact: '/compact $instructions{Enter}' } });
    await service.compactSession('s1', {});
    expect(deliveredText()).toBe('/compact {Enter}');
    await service.compactSession('s1', { instruction: 'focus' });
    expect(deliveredText(1)).toBe('/compact focus{Enter}');
  });

  it('leaves unknown $placeholders untouched rather than splicing a known prefix', async () => {
    const { service } = makeService({ helmActions: { compact: '/compact $instructionFoo{Enter}' } });
    await service.compactSession('s1', { instruction: 'x' });
    expect(deliveredText()).toBe('/compact $instructionFoo{Enter}');
  });

  it('throws when the CLI has no compact action configured', async () => {
    const { service } = makeService({ helmActions: {} });
    await expect(service.compactSession('s1', {})).rejects.toThrow(/no "compact" action configured/);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it('preserves {Wait N} in the sequence (delivery awaits it to hold the MCP return)', async () => {
    const { service } = makeService({ helmActions: { compact: '/compact $instruction{Enter}{Wait 60000}' } });
    await service.compactSession('s1', { instruction: 'x' });
    expect(deliveredText()).toContain('{Wait 60000}');
  });

  it('arms the handover before writing the command, and returns without waiting for it', async () => {
    const { service, armed } = makeService({ helmActions: { compact: '/compact $instruction{Enter}' } });

    const result = await service.compactSession('s1', { instruction: 'auth', handover: 'resume the migration' });

    // Arming after the write would race the compaction's own output, losing the
    // fresh active→inactive edge the delivery waits on.
    expect(armed).toEqual([{ sessionId: 's1', text: 'resume the migration', deliveriesBefore: 0 }]);
    expect(deliveredText()).toBe('/compact auth{Enter}');
    // The caller is usually the session being compacted — blocking until the
    // handover lands would leave the tool call unanswered inside the discard.
    expect(result).toMatchObject({ ok: true, action: 'compact', sessionId: 's1', handoverPending: true });
  });

  it('arms nothing and keeps the return shape when no handover is given', async () => {
    const { service, armed } = makeService({ helmActions: { compact: '/compact $instruction{Enter}' } });

    const result = await service.compactSession('s1', { instruction: 'auth' });

    expect(armed).toEqual([]);
    expect(result).toMatchObject({ ok: true, action: 'compact', sessionId: 's1', handoverPending: false });
  });
});

describe('session_export', () => {
  beforeEach(() => {
    deliverSpy.mockClear();
    process.env.HELM_CLEAR_SETTLE_DELAY_MS = '0';
  });

  it('substitutes $path and echoes the path back', async () => {
    const { service } = makeService({ helmActions: { export: '/export $path{Enter}' } });

    const result = await service.exportSession('s1', { path: 'C:\\tmp\\old.md' });

    expect(deliveredText()).toBe('/export C:\\tmp\\old.md{Enter}');
    expect(result).toMatchObject({ ok: true, action: 'export', sessionId: 's1', path: 'C:\\tmp\\old.md' });
  });

  it('throws when path is missing', async () => {
    const { service } = makeService({ helmActions: { export: '/export $path{Enter}' } });
    await expect(service.exportSession('s1', { path: '   ' })).rejects.toThrow(/path is required/);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it('throws when the CLI has no export action configured', async () => {
    const { service } = makeService({ helmActions: {} });
    await expect(service.exportSession('s1', { path: 'C:\\tmp\\x.md' })).rejects.toThrow(/no "export" action configured/);
  });
});

describe('session_clear', () => {
  beforeEach(() => {
    deliverSpy.mockClear();
    process.env.HELM_CLEAR_SETTLE_DELAY_MS = '0';
  });

  it('uses helmActions.clear when configured', async () => {
    const { service } = makeService({ helmActions: { clear: '/reset{Enter}' } });
    const result = await service.clearSession('s1', {});
    expect(deliveredText()).toBe('/reset{Enter}');
    expect(result).toMatchObject({ ok: true, action: 'clear', sessionId: 's1', contextRelayed: false });
  });

  it('falls back to legacy clearCommand when helmActions.clear is absent', async () => {
    const { service } = makeService({ clearCommand: '/legacy-clear' });
    await service.clearSession('s1', {});
    expect(deliveredText()).toBe('/legacy-clear');
  });

  it('falls back to /clear when nothing is configured', async () => {
    const { service } = makeService({});
    await service.clearSession('s1', {});
    expect(deliveredText()).toBe('/clear');
  });

  it('relays a context note after clearing', async () => {
    const { service } = makeService({ helmActions: { clear: '/clear{Enter}' } });
    const result = await service.clearSession('s1', { context: 'remember the migration' });
    expect(deliverSpy).toHaveBeenCalledTimes(2);
    expect(deliveredText(1)).toBe('remember the migration');
    expect(result.contextRelayed).toBe(true);
  });
});

describe('worker actions — PTY guard', () => {
  beforeEach(() => {
    deliverSpy.mockClear();
    process.env.HELM_CLEAR_SETTLE_DELAY_MS = '0';
  });

  it('throws when the target PTY is not running', async () => {
    const { service } = makeService({ helmActions: { compact: '/compact{Enter}' } }, false);
    await expect(service.compactSession('s1', {})).rejects.toThrow(/not running/);
  });

  it('throws when the target session does not exist', async () => {
    const { service } = makeService({ helmActions: { compact: '/compact{Enter}' } });
    await expect(service.compactSession('missing', {})).rejects.toThrow(/Session not found/);
  });
});
