/**
 * The CLI types shipped in src/config/cli-types.yaml are what a brand-new
 * install gets. Before this file existed, a fresh install had zero CLI types
 * and could spawn nothing, so these tests guard the contents against drift:
 * the file must stay valid, canonical, and loadable by the real CliTypeStore
 * without being rewritten on first load.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'yaml';

import { CliTypeStore } from '../src/config/cli-type-store.js';
import type { CliTypeConfig } from '../src/config/loader.js';

const SHIPPED_PATH = path.join(process.cwd(), 'src', 'config', 'cli-types.yaml');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HELM_INIT_SEQUENCE = 'Call session_info to get Helm MCP initial information.{Enter}';
const EXPECTED_NAMES = ['Claude Code', 'Codex', 'GitHub Copilot CLI', 'cmd'];

const shippedRaw = fs.readFileSync(SHIPPED_PATH, 'utf8');
const shipped = yaml.parse(shippedRaw) as Record<string, CliTypeConfig>;
const entries = Object.entries(shipped);

describe('shipped cli-types.yaml', () => {
  it('keys every entry by its own UUID identity', () => {
    for (const [key, config] of entries) {
      expect(key).toMatch(UUID_RE);
      expect(config.id).toBe(key);
    }
  });

  it('gives every entry a display name and a spawn command', () => {
    for (const [, config] of entries) {
      expect(config.displayName).toBeTruthy();
      expect(config.name).toBe(config.displayName);
      expect(config.spawnCommand).toBeTruthy();
    }
  });

  it('ships exactly the four default CLI types', () => {
    expect(entries.map(([, c]) => c.displayName)).toEqual(EXPECTED_NAMES);
  });

  it('maps each agent type to its provider up front — the shell stays unmapped', () => {
    // Shipped WITH the provider field so the load-time auto-migration has
    // nothing to stamp and the file stays byte-pristine on first load.
    expect(entries.map(([, c]) => c.provider)).toEqual(['claude', 'codex', 'copilot', undefined]);
  });

  it('gives the agent types the Helm session init prompt and the shell none', () => {
    for (const [, config] of entries) {
      if (config.displayName === 'cmd') {
        expect(config.initialPrompt).toEqual([]);
        continue;
      }
      expect(config.initialPrompt).toEqual([
        { label: 'Helm session init', sequence: HELM_INIT_SEQUENCE },
      ]);
    }
  });
});

describe('CliTypeStore against the shipped defaults', () => {
  const tempDir = path.join(process.cwd(), '.test-shipped-cli-types-' + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'cli-types.yaml'), shippedRaw);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads all four types without rewriting the file', () => {
    const before = fs.readFileSync(path.join(tempDir, 'cli-types.yaml'), 'utf8');
    const store = new CliTypeStore(tempDir);
    store.load();

    expect(store.list()).toHaveLength(EXPECTED_NAMES.length);
    // A rewrite on load would mean the shipped file is not in canonical schema.
    expect(fs.readFileSync(path.join(tempDir, 'cli-types.yaml'), 'utf8')).toBe(before);
  });

  it('resolves each default by display name and by id, unambiguously', () => {
    const store = new CliTypeStore(tempDir);
    store.load();

    for (const [id, config] of entries) {
      expect(store.resolve(config.displayName!)?.id).toBe(id);
      expect(store.resolve(id)?.id).toBe(id);
    }
  });
});
