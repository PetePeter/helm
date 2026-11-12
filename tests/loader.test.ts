/**
 * Config loader auto-seeding tests — Option A dev mode support
 *
 * Tests verify:
 * - seedConfigIfNeeded copies templates when target missing
 * - seedConfigIfNeeded skips if target already exists
 * - Dev mode calls seeding at loader import time
 * - readYaml succeeds after seeding populates settings.yaml
 * - Missing bundled dir skipped gracefully
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(process.cwd(), '.test-loader-' + Date.now());

function writeYaml(relativePath: string, data: unknown): void {
  const fullPath = path.join(TEST_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, YAML.stringify(data), 'utf8');
}

function readYaml<T>(relativePath: string): T {
  const fullPath = path.join(TEST_DIR, relativePath);
  return YAML.parse(fs.readFileSync(fullPath, 'utf8')) as T;
}

function dirExists(relativePath: string): boolean {
  return fs.existsSync(path.join(TEST_DIR, relativePath));
}

function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(TEST_DIR, relativePath));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Config auto-seeding for dev mode (Option A)', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // =========================================================================
  // Test 1: seedConfigIfNeeded copies templates when target missing
  // =========================================================================

  it('seedConfigIfNeeded copies templates when target missing', async () => {
    // Setup: Create a fake bundled config directory with templates
    const bundledDir = path.join(TEST_DIR, 'bundled-config');
    const targetDir = path.join(TEST_DIR, 'user-config');

    fs.mkdirSync(path.join(bundledDir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, 'settings.yaml'),
      'activeProfile: default\nhapticFeedback: false\nnotifications: true\n'
    );
    fs.writeFileSync(
      path.join(bundledDir, 'profiles', 'default.yaml'),
      'name: Default\ntools: {}\nworkingDirectories: []\nbindings: {}\n'
    );
    fs.writeFileSync(path.join(bundledDir, 'sessions.yaml'), '[]\n');
    fs.writeFileSync(path.join(bundledDir, 'drafts.yaml'), '[]\n');
    fs.mkdirSync(path.join(bundledDir, 'plans'), { recursive: true });

    // Execute: Import seedConfigIfNeeded and call it
    const { seedConfigIfNeeded } = await import('../src/utils/app-paths.js');
    seedConfigIfNeeded(bundledDir, targetDir);

    // Verify: All files and directories copied
    expect(fs.existsSync(path.join(targetDir, 'settings.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'profiles', 'default.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'sessions.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'drafts.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'plans'))).toBe(true);

    // Verify: Content matches source
    const settings = fs.readFileSync(path.join(targetDir, 'settings.yaml'), 'utf8');
    expect(settings).toContain('activeProfile: default');
    expect(settings).toContain('hapticFeedback: false');

    const profile = fs.readFileSync(path.join(targetDir, 'profiles', 'default.yaml'), 'utf8');
    expect(profile).toContain('name: Default');
  });

  // =========================================================================
  // Test 2: seedConfigIfNeeded skips if target already exists
  // =========================================================================

  it('seedConfigIfNeeded skips if target already exists', async () => {
    const bundledDir = path.join(TEST_DIR, 'bundled-config');
    const targetDir = path.join(TEST_DIR, 'user-config');

    // Setup: Create bundled source
    fs.mkdirSync(path.join(bundledDir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, 'settings.yaml'),
      'activeProfile: default\n'
    );
    fs.writeFileSync(
      path.join(bundledDir, 'profiles', 'default.yaml'),
      'name: Default\n'
    );

    // Setup: Pre-create target with different content
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'settings.yaml'),
      'activeProfile: custom\nfakeField: true\n'
    );

    // Execute: Call seedConfigIfNeeded
    const { seedConfigIfNeeded } = await import('../src/utils/app-paths.js');
    seedConfigIfNeeded(bundledDir, targetDir);

    // Verify: Original target content preserved (not overwritten)
    const settings = fs.readFileSync(path.join(targetDir, 'settings.yaml'), 'utf8');
    expect(settings).toContain('activeProfile: custom');
    expect(settings).toContain('fakeField: true');
    expect(settings).not.toContain('hapticFeedback');
  });

  // =========================================================================
  // Test 3: Dev mode calls seeding at loader import time
  // =========================================================================

  it('loader imports and calls seeding (dev + packaged modes)', async () => {
    // This test verifies that seedConfigIfNeeded is called at loader import time
    // We create a test directory, load ConfigLoader, and verify seeds occurred

    const bundledDir = path.join(TEST_DIR, 'bundled-templates');
    const configDir = path.join(TEST_DIR, 'dev-config');

    // Setup: Create bundled templates
    fs.mkdirSync(path.join(bundledDir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, 'settings.yaml'),
      'activeProfile: default\nhapticFeedback: false\n'
    );
    fs.writeFileSync(
      path.join(bundledDir, 'profiles', 'default.yaml'),
      'name: Default\ntools: {}\nworkingDirectories: []\nbindings: {}\n'
    );
    fs.writeFileSync(path.join(bundledDir, 'sessions.yaml'), '[]\n');
    fs.writeFileSync(path.join(bundledDir, 'drafts.yaml'), '[]\n');

    // Execute: Call seeding (simulating what loader.ts does)
    const { seedConfigIfNeeded } = await import('../src/utils/app-paths.js');
    seedConfigIfNeeded(bundledDir, configDir);

    // Verify: Files exist in target
    expect(fs.existsSync(path.join(configDir, 'settings.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'profiles', 'default.yaml'))).toBe(true);
  });

  // =========================================================================
  // Test 4: readYaml succeeds after seeding populates settings.yaml
  // =========================================================================

  it('readYaml succeeds after seeding populates settings.yaml', async () => {
    const bundledDir = path.join(TEST_DIR, 'bundled-seed');
    const userConfigDir = path.join(TEST_DIR, 'user-seeded-config');

    // Setup: Create bundled templates with valid YAML
    fs.mkdirSync(path.join(bundledDir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, 'settings.yaml'),
      'activeProfile: default\nhapticFeedback: false\nnotifications: true\n'
    );
    fs.writeFileSync(
      path.join(bundledDir, 'profiles', 'default.yaml'),
      'name: Default\ntools: {}\nworkingDirectories: []\nbindings: {}\n'
    );
    fs.writeFileSync(path.join(bundledDir, 'sessions.yaml'), '[]\n');
    fs.writeFileSync(path.join(bundledDir, 'drafts.yaml'), '[]\n');

    // Execute: Seed the config
    const { seedConfigIfNeeded } = await import('../src/utils/app-paths.js');
    seedConfigIfNeeded(bundledDir, userConfigDir);

    // Verify: Can now load and parse settings
    const settingsPath = path.join(userConfigDir, 'settings.yaml');
    const content = fs.readFileSync(settingsPath, 'utf8');
    const parsed = YAML.parse(content);

    expect(parsed).toBeDefined();
    expect(parsed.activeProfile).toBe('default');
    expect(parsed.hapticFeedback).toBe(false);
    expect(parsed.notifications).toBe(true);
  });

  // =========================================================================
  // Test 5: Missing bundled dir skipped gracefully (early return)
  // =========================================================================

  it('Missing bundled dir skipped gracefully (early return)', async () => {
    const bogusSource = path.join(TEST_DIR, 'nonexistent-source');
    const targetDir = path.join(TEST_DIR, 'should-not-be-created');

    // Verify bundled source does NOT exist
    expect(fs.existsSync(bogusSource)).toBe(false);

    // Execute: Call seeding with nonexistent source
    const { seedConfigIfNeeded } = await import('../src/utils/app-paths.js');
    expect(() => {
      seedConfigIfNeeded(bogusSource, targetDir);
    }).not.toThrow();

    // Verify: Target directory was NOT created
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  // =========================================================================
  // Test 6: Full ConfigLoader workflow with seeded config
  // =========================================================================

  it('ConfigLoader loads successfully after seeding', async () => {
    const bundledDir = path.join(TEST_DIR, 'bundled-workflow');
    const userConfigDir = path.join(TEST_DIR, 'user-workflow-config');

    // Setup: Create bundled templates
    fs.mkdirSync(path.join(bundledDir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(bundledDir, 'settings.yaml'),
      'hapticFeedback: true\nnotifications: false\n'
    );
    fs.writeFileSync(
      path.join(bundledDir, 'profiles', 'default.yaml'),
      'name: Default\ntools:\n  claude-code:\n    name: Claude Code\n    command: cc\nworkingDirectories: []\nbindings: {}\n'
    );
    fs.writeFileSync(path.join(bundledDir, 'sessions.yaml'), '[]\n');
    fs.writeFileSync(path.join(bundledDir, 'drafts.yaml'), '[]\n');

    // Execute: Seed and load
    const { seedConfigIfNeeded } = await import('../src/utils/app-paths.js');
    seedConfigIfNeeded(bundledDir, userConfigDir);

    const loader = new ConfigLoader(userConfigDir);
    loader.load();

    // Verify: Config loaded correctly
    expect(loader.getHapticFeedback()).toBe(true);
    expect(loader.getNotifications()).toBe(false);
    // Keys are UUIDs post id-migration; the seeded entry keeps its label.
    const names = loader.getCliTypes().map(id => loader.getCliTypeEntry(id)?.displayName);
    expect(names).toContain('Claude Code');
  });

  // =========================================================================
  // Test 7: Nested directory structures copied correctly
  // =========================================================================

  it('Nested directory structures (profiles/, plans/) copied correctly', async () => {
    const bundledDir = path.join(TEST_DIR, 'bundled-nested');
    const targetDir = path.join(TEST_DIR, 'user-nested');

    // Setup: Create nested structure
    fs.mkdirSync(path.join(bundledDir, 'profiles'), { recursive: true });
    fs.mkdirSync(path.join(bundledDir, 'plans', 'incoming'), { recursive: true });
    fs.writeFileSync(path.join(bundledDir, 'settings.yaml'), 'activeProfile: default\n');
    fs.writeFileSync(
      path.join(bundledDir, 'profiles', 'default.yaml'),
      'name: Default\ntools: {}\nworkingDirectories: []\nbindings: {}\n'
    );
    fs.writeFileSync(
      path.join(bundledDir, 'profiles', 'advanced.yaml'),
      'name: Advanced\ntools: {}\nworkingDirectories: []\nbindings: {}\n'
    );
    fs.writeFileSync(path.join(bundledDir, 'sessions.yaml'), '[]\n');
    fs.writeFileSync(path.join(bundledDir, 'drafts.yaml'), '[]\n');
    fs.writeFileSync(path.join(bundledDir, 'plans', 'incoming', '.gitkeep'), '');

    // Execute: Seed
    const { seedConfigIfNeeded } = await import('../src/utils/app-paths.js');
    seedConfigIfNeeded(bundledDir, targetDir);

    // Verify: Nested files and directories exist
    expect(fs.existsSync(path.join(targetDir, 'profiles', 'default.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'profiles', 'advanced.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'plans', 'incoming'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'plans', 'incoming', '.gitkeep'))).toBe(true);
  });
});
