/**
 * ConfigLoader.reloadActiveProfileIfChanged() tests
 *
 * The profile system has been replaced by dedicated stores. This method is now
 * a no-op kept for API compatibility. These tests verify that:
 * - The method still exists and is callable without throwing
 * - The loader returns correct values from the dedicated stores after load()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../../src/config/loader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(process.cwd(), '.test-loader-reload-' + Date.now());

function writeYaml(relativePath: string, data: unknown): void {
  const fullPath = path.join(TEST_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, YAML.stringify(data), 'utf8');
}

const SETTINGS = { hapticFeedback: true, notifications: true, escProtectionEnabled: true };

function setupStores(toolName: string): void {
  writeYaml('settings.yaml', SETTINGS);
  writeYaml('cli-types.yaml', {
    'claude-code': {
      name: toolName,
      spawnCommand: 'claude',
      initialPrompt: [],
    },
  });
  writeYaml('bindings.yaml', {
    'claude-code': {
      A: { action: 'keyboard', sequence: '{Enter}' },
    },
  });
  writeYaml('input-config.yaml', { workingDirectories: [] });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let loader: ConfigLoader;

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setupStores('Original');
  loader = new ConfigLoader(TEST_DIR);
  loader.load();
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reloadActiveProfileIfChanged', () => {

  it('is a no-op — does not throw', () => {
    expect(() => loader.reloadActiveProfileIfChanged()).not.toThrow();
  });

  it('returns correct values from dedicated stores after load', () => {
    expect(loader.getCliTypeEntry('Original')?.name).toBe('Original');
    expect(loader.getBindings('Original')?.A).toEqual({ action: 'keyboard', sequence: '{Enter}' });
  });

  it('can call reloadActiveProfileIfChanged multiple times without error', () => {
    loader.reloadActiveProfileIfChanged();
    loader.reloadActiveProfileIfChanged();
    expect(loader.getCliTypeEntry('Original')?.name).toBe('Original');
  });

});
