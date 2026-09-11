/**
 * MobileAuditLog — 7-day rolling trail of inbound phone-call decisions.
 * Real log with an injected persist sink and an injected clock; the round-trip
 * test uses a real temp file so the YAML shape is exercised end to end.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileAuditLog, MOBILE_AUDIT_WINDOW_MS } from '../src/mobile/mobile-audit-log.js';
import { saveMobileAudit, loadMobileAudit } from '../src/mobile/mobile-audit-persistence.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helm-mobile-audit-'));
  dirs.push(dir);
  return join(dir, 'mobile-audit.yaml');
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function entry(over: Partial<Parameters<MobileAuditLog['append']>[0]> = {}) {
  return {
    deviceId: 'dev-1',
    method: 'session_list',
    argSummary: 'keys: (none)',
    outcome: 'ok' as const,
    ranAt: 0,
    ...over,
  };
}

describe('MobileAuditLog', () => {
  it('keeps entries newest-first and persists on every append', () => {
    const saved: unknown[][] = [];
    const log = new MobileAuditLog(e => saved.push(e), () => 0);
    log.importAll([]);
    log.append(entry({ ranAt: 100, method: 'a' }));
    log.append(entry({ ranAt: 200, method: 'b' }));

    expect(log.list().map(e => e.method)).toEqual(['b', 'a']);
    expect(saved).toHaveLength(2);
  });

  it('prunes entries older than the 7-day window', () => {
    const now = 10 * MOBILE_AUDIT_WINDOW_MS;
    const log = new MobileAuditLog(() => {}, () => now);
    log.importAll([]);
    log.append(entry({ ranAt: now - MOBILE_AUDIT_WINDOW_MS - 1, method: 'stale' }));
    log.append(entry({ ranAt: now, method: 'fresh' }));

    expect(log.list().map(e => e.method)).toEqual(['fresh']);
  });

  it('re-prunes defensively on importAll, so a stale file cannot resurrect entries', () => {
    const now = 10 * MOBILE_AUDIT_WINDOW_MS;
    const log = new MobileAuditLog(() => {}, () => now);
    log.importAll([
      { id: '1', ...entry({ ranAt: 0, method: 'ancient' }) },
      { id: '2', ...entry({ ranAt: now, method: 'recent' }) },
    ]);
    expect(log.list().map(e => e.method)).toEqual(['recent']);
  });

  it('round-trips through YAML at mode 0600 and drops stale entries on load', () => {
    const file = tempFile();
    const now = 10 * MOBILE_AUDIT_WINDOW_MS;
    saveMobileAudit(
      [
        { id: '1', ...entry({ ranAt: now, method: 'fresh' }) },
        { id: '2', ...entry({ ranAt: 0, method: 'ancient' }) },
      ],
      file,
    );
    expect(existsSync(file)).toBe(true);
    // Windows does not model POSIX permission bits; assert only where meaningful.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(loadMobileAudit(file, now).map(e => e.method)).toEqual(['fresh']);
  });

  it('returns an empty log for a missing or malformed file rather than throwing', () => {
    const file = tempFile();
    expect(loadMobileAudit(file, 0)).toEqual([]);
    saveMobileAudit([] as never, file);
    expect(loadMobileAudit(file, 0)).toEqual([]);
  });
});
