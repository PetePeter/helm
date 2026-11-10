import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as YAML from 'yaml';
import { ConfigLoader } from '../src/config/loader.js';

const profileDir = mkdtempSync(path.join(tmpdir(), 'helm-startup-prompts-'));
const ids = {
  codex: '91000000-0000-4000-8000-000000000001',
  codexOff: '91000000-0000-4000-8000-000000000002',
  claudePath: '91000000-0000-4000-8000-000000000003',
  unknown: '91000000-0000-4000-8000-000000000004',
  copilot: '91000000-0000-4000-8000-000000000005',
};

writeFileSync(path.join(profileDir, 'settings.yaml'), YAML.stringify({
  hapticFeedback: true,
  notifications: true,
  escProtectionEnabled: true,
}), 'utf8');
writeFileSync(path.join(profileDir, 'cli-types.yaml'), YAML.stringify({
  [ids.codex]: { id: ids.codex, name: 'Luna XHigh', displayName: 'Luna XHigh', spawnCommand: 'codex --model xhigh' },
  [ids.codexOff]: { id: ids.codexOff, name: 'Codex Off', displayName: 'Codex Off', spawnCommand: 'codex', startupPrompts: [] },
  [ids.claudePath]: { id: ids.claudePath, name: 'Claude Path', displayName: 'Claude Path', spawnCommand: '"C:\\Tools\\claude.exe" --session-id x' },
  [ids.unknown]: { id: ids.unknown, name: 'Custom', displayName: 'Custom', spawnCommand: 'my-agent' },
  [ids.copilot]: { id: ids.copilot, name: 'Copilot Custom', displayName: 'Copilot Custom', spawnCommand: 'copilot --agent' },
}), 'utf8');

const loader = new ConfigLoader(profileDir);
loader.load();

describe('ConfigLoader.getStartupPrompts', () => {
  it('uses the launch command when custom CLI types omit startupPrompts', () => {
    const rules = loader.getStartupPrompts(ids.codex);
    expect(rules).toHaveLength(2);
    expect(rules.map(rule => rule.regex)).toEqual(expect.arrayContaining([
      expect.stringContaining('contents'),
      expect.stringContaining('allow'),
    ]));
    expect(loader.getStartupPrompts(ids.claudePath)[0].regex).toContain('files');
    expect(loader.getStartupPrompts(ids.copilot)[0].regex).toContain('confirm');
    expect(loader.getStartupPrompts(ids.unknown)).toEqual([]);
  });

  it('respects an explicit empty list as disabled', () => {
    expect(loader.getStartupPrompts(ids.codexOff)).toEqual([]);
  });
});

afterAll(() => rmSync(profileDir, { recursive: true, force: true }));
