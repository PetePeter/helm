/**
 * ConfigLoader.getHookDenyRules — G2's rule source.
 *
 * Deny rules live per CLI type in cli-types.yaml under `hooks.denyRules`; the
 * receiver asks by provider (claude/codex/copilot) because a HookEvent names
 * the family, not the config key. These tests seed a real config dir and read
 * through the real loader.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../../src/config/loader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

const TEST_DIR = path.join(process.cwd(), '.test-hook-deny-rules-' + Date.now());

function writeYaml(relativePath: string, data: unknown): void {
  const fullPath = path.join(TEST_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, YAML.stringify(data), 'utf8');
}

beforeEach(() => {
  writeYaml('settings.yaml', {});
  writeYaml('cli-types.yaml', {
    '11111111-1111-4111-8111-111111111111': {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Claude Code',
      spawnCommand: 'claude',
      hooks: {
        provider: 'claude',
        configPath: '~/.claude/settings.json',
        events: ['PreToolUse'],
        denyRules: [{ tools: ['Artifact'], reason: 'use session_artifact_create' }],
      },
    },
    '22222222-2222-4222-8222-222222222222': {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Codex',
      spawnCommand: 'codex',
      hooks: { provider: 'codex', configPath: '~/.codex/hooks.json', events: ['PreToolUse'] },
    },
  });
  writeYaml('bindings.yaml', {});
  writeYaml('input-config.yaml', { workingDirectories: [] });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('getHookDenyRules', () => {
  it('returns the denyRules of the CLI type carrying that provider', () => {
    const loader = new ConfigLoader(TEST_DIR);
    loader.load();

    expect(loader.getHookDenyRules('claude')).toEqual([
      { tools: ['Artifact'], reason: 'use session_artifact_create' },
    ]);
  });

  it('returns an empty list when the provider has no rules configured', () => {
    const loader = new ConfigLoader(TEST_DIR);
    loader.load();

    expect(loader.getHookDenyRules('codex')).toEqual([]);
  });

  it('returns an empty list when no CLI type uses that provider', () => {
    const loader = new ConfigLoader(TEST_DIR);
    loader.load();

    expect(loader.getHookDenyRules('copilot')).toEqual([]);
  });
});
