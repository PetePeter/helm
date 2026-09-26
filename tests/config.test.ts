/**
 * Config loader unit tests — dedicated store system
 *
 * Tests cover: loading from cli-types.yaml / bindings.yaml / input-config.yaml,
 * existing getters, setBinding, CLI type CRUD, working directory CRUD, and sequences.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { stickVirtualButtonName, STICK_VIRTUAL_BUTTONS } from '../src/config/loader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { createDefaultLayout } from '../renderer/dock-layout';

// ---------------------------------------------------------------------------
// File-system helpers: use a real temp dir with real YAML files
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(process.cwd(), '.test-config-' + Date.now());

function writeYaml(relativePath: string, data: unknown): void {
  const fullPath = path.join(TEST_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, YAML.stringify(data), 'utf8');
}

function readYaml<T>(relativePath: string): T {
  const fullPath = path.join(TEST_DIR, relativePath);
  return YAML.parse(fs.readFileSync(fullPath, 'utf8')) as T;
}

/**
 * CLI types are keyed by UUID on disk since the id migration — re-index the raw
 * YAML by the human slug (legacyKey) so on-disk assertions stay readable.
 */
function readCliTypesBySlug(): Record<string, any> {
  const raw = readYaml<Record<string, any>>('cli-types.yaml');
  return Object.fromEntries(Object.values(raw).map((e: any) => [e.legacyKey ?? e.id, e]));
}

/** bindings.yaml is keyed by the CLI type UUID — re-index by slug via cli-types.yaml. */
function readBindingsBySlug(): Record<string, any> {
  const types = readYaml<Record<string, any>>('cli-types.yaml');
  const slugById = new Map(Object.entries(types).map(([id, e]: [string, any]) => [id, e.legacyKey ?? id]));
  const raw = readYaml<Record<string, any>>('bindings.yaml');
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [slugById.get(k) ?? k, v]));
}

/** CLI type keys are UUIDs — map them back to slugs for order/membership assertions. */
function cliTypeSlugs(loader: any): string[] {
  return loader.getCliTypes().map((id: string) => loader.getCliTypeEntry(id)?.legacyKey ?? id);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SETTINGS = { hapticFeedback: true, notifications: true, escProtectionEnabled: true };

const CLI_TYPES = {
  'claude-code': {
    name: 'Claude Code',
    spawnCommand: 'cc',
    initialPrompt: [],
  },
  'copilot-cli': {
    name: 'GitHub Copilot CLI',
    spawnCommand: 'copilot',
    initialPrompt: [],
  },
};

const BINDINGS = {
  'claude-code': {
    A: { action: 'keyboard', sequence: '{Ctrl+L}' },
    B: { action: 'voice', key: 'Space', mode: 'hold' },
  },
  'copilot-cli': {
    A: { action: 'keyboard', sequence: '{Ctrl+L}' },
    Y: { action: 'keyboard', sequence: '{Ctrl+C}' },
  },
};

const WORKING_DIRS = [
  { name: 'Projects', path: 'X:\\coding' },
  { name: 'Home', path: 'C:\\Users\\oscar' },
];

function setupTestFiles(): void {
  writeYaml('settings.yaml', SETTINGS);
  writeYaml('cli-types.yaml', CLI_TYPES);
  writeYaml('bindings.yaml', BINDINGS);
  writeYaml('input-config.yaml', { workingDirectories: WORKING_DIRS });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfigLoader', () => {
  let loader: ConfigLoader;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setupTestFiles();
    loader = new ConfigLoader(TEST_DIR);
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    // Safety net: clean up if afterEach was skipped (crash / interrupt)
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // Loading
  // =========================================================================

  describe('load', () => {
    it('loads all config files without error', () => {
      expect(() => loader.load()).not.toThrow();
    });

    it('throws when settings.yaml is missing', () => {
      fs.unlinkSync(path.join(TEST_DIR, 'settings.yaml'));
      expect(() => loader.load()).toThrow('Configuration file not found');
    });

    it('loads successfully when cli-types.yaml is absent (empty store)', () => {
      fs.unlinkSync(path.join(TEST_DIR, 'cli-types.yaml'));
      expect(() => loader.load()).not.toThrow();
    });
  });

  // =========================================================================
  // Existing getters (backward compatibility)
  // =========================================================================

  describe('getBindings', () => {
    it('returns bindings for a valid CLI type', () => {
      loader.load();
      const bindings = loader.getBindings('claude-code');
      expect(bindings).toEqual(BINDINGS['claude-code']);
    });

    it('returns null for non-existent CLI type', () => {
      loader.load();
      expect(loader.getBindings('non-existent')).toBeNull();
    });

    it('throws error when called before load', () => {
      expect(() => loader.getBindings('claude-code')).toThrow('Configuration not loaded');
    });
  });

  describe('getSpawnConfig', () => {
    it('returns built spawn config from cli-types.yaml', () => {
      loader.load();
      expect(loader.getSpawnConfig('claude-code')).toEqual({ command: 'cc', args: [] });
    });

    it('returns null for non-existent CLI type', () => {
      loader.load();
      expect(loader.getSpawnConfig('non-existent')).toBeNull();
    });

    it('throws error when called before load', () => {
      expect(() => loader.getSpawnConfig('claude-code')).toThrow('Configuration not loaded');
    });
  });

  describe('getCliTypeName', () => {
    it('returns name from cli-types.yaml', () => {
      loader.load();
      expect(loader.getCliTypeName('claude-code')).toBe('Claude Code');
    });

    it('returns null for non-existent CLI type', () => {
      loader.load();
      expect(loader.getCliTypeName('non-existent')).toBeNull();
    });
  });

  describe('getCliTypes', () => {
    it('returns CLI type keys from cli-types.yaml', () => {
      loader.load();
      expect(cliTypeSlugs(loader)).toEqual(['claude-code', 'copilot-cli']);
    });
  });

  describe('getWorkingDirectories', () => {
    it('returns [] when no project store is attached', () => {
      loader.load();
      expect(loader.getWorkingDirectories()).toEqual([]);
    });

    it('derives one entry per project canonical + alternate path, named by project', () => {
      loader.load();
      loader.setProjectStore({
        list: () => [
          { id: '1', name: 'Helm', canonicalPath: 'X:\\coding\\helm', createdAt: 0, updatedAt: 0 },
          { id: '2', name: 'Other', canonicalPath: 'X:\\coding\\other', alternatePaths: ['X:\\coding\\other-alt'], createdAt: 0, updatedAt: 0 },
        ],
      } as any);

      expect(loader.getWorkingDirectories()).toEqual([
        { name: 'Helm', path: 'X:\\coding\\helm' },
        { name: 'Other', path: 'X:\\coding\\other' },
        { name: 'Other', path: 'X:\\coding\\other-alt' },
      ]);
    });

    it('deduplicates overlapping canonical/alternate paths (normalized)', () => {
      loader.load();
      // Case-variant overlap only dedupes on win32 (paths are case-folded there);
      // trailing-slash variants normalize identically on every platform.
      const altVariant = process.platform === 'win32' ? 'x:\\coding\\HELM' : 'X:\\coding\\helm\\';
      loader.setProjectStore({
        list: () => [
          { id: '1', name: 'Helm', canonicalPath: 'X:\\coding\\helm', alternatePaths: [altVariant], createdAt: 0, updatedAt: 0 },
        ],
      } as any);

      expect(loader.getWorkingDirectories()).toEqual([
        { name: 'Helm', path: 'X:\\coding\\helm' },
      ]);
    });
  });

  describe('getChipbarActions', () => {
    it('returns the incoming inbox path, not the plans root', () => {
      writeYaml('input-config.yaml', {
        workingDirectories: WORKING_DIRS,
        chipActions: [{ label: '💾 Save Plan', sequence: 'save to {plansDir}{Enter}' }],
      });

      loader.load();

      expect(loader.getChipbarActions()).toEqual({
        actions: [{ label: '💾 Save Plan', sequence: 'save to {plansDir}{Enter}' }],
        inboxDir: path.join(TEST_DIR, 'plans', 'incoming'),
      });
    });
  });

  describe('session group prefs', () => {
    it('persists overviewHidden to settings.yaml', () => {
      loader.load();

      loader.setSessionGroupPrefs({
        order: ['X:\\coding\\project-a'],
        collapsed: ['X:\\coding\\project-b'],
        overviewHidden: ['session-1', 'session-2'],
      });

      const onDisk = readYaml<any>('settings.yaml');
      expect(onDisk.sessionGroups.overviewHidden).toEqual(['session-1', 'session-2']);
    });

    it('roundtrips overviewHidden through save and reload', () => {
      loader.load();

      loader.setSessionGroupPrefs({
        order: ['X:\\coding\\project-a'],
        collapsed: [],
        overviewHidden: ['session-3'],
      });

      const loader2 = new ConfigLoader(TEST_DIR);
      loader2.load();
      expect(loader2.getSessionGroupPrefs()).toEqual({
        order: ['X:\\coding\\project-a'],
        collapsed: [],
        overviewHidden: ['session-3'],
      });
    });
  });

  describe('editor history', () => {
    it('persists editor history to settings.yaml and reloads it', () => {
      loader.load();
      loader.setEditorHistory(['first prompt', 'second prompt']);

      const onDisk = readYaml<any>('settings.yaml');
      expect(onDisk.editorHistory).toEqual(['first prompt', 'second prompt']);

      const loader2 = new ConfigLoader(TEST_DIR);
      loader2.load();
      expect(loader2.getEditorHistory()).toEqual(['first prompt', 'second prompt']);
    });
  });

  describe('plan filters', () => {
    it('deep-merges partial plan filter updates without resetting sibling fields', () => {
      loader.load();
      loader.setPlanFilters({
        types: { feature: 'no' },
        hasAttachment: { no: 'no' },
      });
      loader.setPlanFilters({
        statuses: { done: 'no' },
        auto: 'yes',
      });

      expect(loader.getPlanFilters()).toEqual({
        types: { bug: 'either', feature: 'no', research: 'either', untyped: 'either' },
        statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'no' },
        hasAttachment: { yes: 'either', no: 'no' },
        auto: 'yes',
      });
    });
  });

  // =========================================================================
  // setBinding (backward compatible)
  // =========================================================================

  describe('setBinding', () => {
    it('throws error when called before load', () => {
      expect(() => loader.setBinding('A', 'claude-code', { action: 'keyboard', keys: ['Enter'] }))
        .toThrow('Configuration not loaded');
    });

    it('sets a CLI-specific binding and persists', () => {
      loader.load();
      const newBinding = { action: 'keyboard' as const, keys: ['Ctrl', 'z'] };
      loader.setBinding('X', 'claude-code', newBinding);

      expect(loader.getBindings('claude-code')!['X']).toEqual(newBinding);

      const onDisk = readBindingsBySlug();
      expect(onDisk['claude-code']['X']).toEqual(newBinding);
    });

    it('throws error for unknown CLI type', () => {
      loader.load();
      expect(() => loader.setBinding('A', 'nonexistent', { action: 'keyboard', keys: ['Enter'] }))
        .toThrow('Unknown CLI type: nonexistent');
    });

    it('sets a prompt-tree binding and persists', () => {
      loader.load();
      const promptTreeBinding = {
        action: 'prompt-tree' as const,
      };
      loader.setBinding('Y', 'claude-code', promptTreeBinding);

      expect(loader.getBindings('claude-code')!['Y']).toEqual(promptTreeBinding);

      const onDisk = readBindingsBySlug();
      expect(onDisk['claude-code']['Y']).toEqual(promptTreeBinding);
    });

    it('round-trips prompt-tree binding through save and reload', () => {
      loader.load();
      const promptTreeBinding = {
        action: 'prompt-tree' as const,
      };
      loader.setBinding('Y', 'copilot-cli', promptTreeBinding);

      // Reload from disk
      const loader2 = new ConfigLoader(TEST_DIR);
      loader2.load();
      expect(loader2.getBindings('copilot-cli')!['Y']).toEqual(promptTreeBinding);
    });
  });

  // =========================================================================
  // copyCliBindings
  // =========================================================================

  describe('copyCliBindings', () => {
    it('copies all bindings from one CLI to another', () => {
      loader.load();
      loader.copyCliBindings('claude-code', 'copilot-cli');
      const target = loader.getBindings('copilot-cli')!;
      // claude-code has A and B — both should now exist on copilot-cli
      expect(target['A']).toEqual({ action: 'keyboard', sequence: '{Ctrl+L}' });
      expect(target['B']).toEqual({ action: 'voice', key: 'Space', mode: 'hold' });
    });

    it('overwrites existing bindings on target', () => {
      loader.load();
      // copilot-cli already has A={Ctrl+L} and Y={Ctrl+C}
      loader.copyCliBindings('claude-code', 'copilot-cli');
      const target = loader.getBindings('copilot-cli')!;
      // A was overwritten with claude-code's A
      expect(target['A']).toEqual({ action: 'keyboard', sequence: '{Ctrl+L}' });
      // Y was not in source — should remain untouched
      expect(target['Y']).toEqual({ action: 'keyboard', sequence: '{Ctrl+C}' });
    });

    it('returns count of copied bindings', () => {
      loader.load();
      const count = loader.copyCliBindings('claude-code', 'copilot-cli');
      expect(count).toBe(2); // A and B
    });

    it('throws for unknown source CLI', () => {
      loader.load();
      expect(() => loader.copyCliBindings('nonexistent', 'copilot-cli'))
        .toThrow('No bindings found for source: nonexistent');
    });

    it('throws for unknown target CLI', () => {
      loader.load();
      expect(() => loader.copyCliBindings('claude-code', 'nonexistent'))
        .toThrow('Unknown target CLI type: nonexistent');
    });

    it('persists copied bindings to disk', () => {
      loader.load();
      loader.copyCliBindings('claude-code', 'copilot-cli');
      const fresh = new ConfigLoader(TEST_DIR);
      fresh.load();
      const target = fresh.getBindings('copilot-cli')!;
      expect(target['B']).toEqual({ action: 'voice', key: 'Space', mode: 'hold' });
    });

    it('does not mutate source bindings via shared reference', () => {
      loader.load();
      loader.copyCliBindings('claude-code', 'copilot-cli');
      // Modify target binding — should not affect source
      loader.setBinding('A', 'copilot-cli', { action: 'keyboard', sequence: '{Enter}' });
      const source = loader.getBindings('claude-code')!;
      expect(source['A']).toEqual({ action: 'keyboard', sequence: '{Ctrl+L}' });
    });
  });

  // =========================================================================
  // Sequences (named groups)
  // =========================================================================

  describe('Sequences', () => {
    beforeEach(() => {
      // Set up cli-types with sequences
      writeYaml('cli-types.yaml', {
        ...CLI_TYPES,
        'claude-code': {
          ...CLI_TYPES['claude-code'],
          sequences: {
            prompts: [
              { label: 'commit', sequence: 'use skill(commit)' },
              { label: 'review', sequence: 'use skill(code-review-it)' },
            ],
            snippets: [
              { label: 'hello', sequence: 'Hello world!' },
            ],
          },
        },
      });
      loader = new ConfigLoader(TEST_DIR);
    });

    it('getSequences returns all groups for a CLI type', () => {
      loader.load();
      const sequences = loader.getSequences('claude-code');
      expect(Object.keys(sequences)).toEqual(['prompts', 'snippets']);
      expect(sequences['prompts']).toHaveLength(2);
      expect(sequences['snippets']).toHaveLength(1);
    });

    it('getSequences returns empty object for CLI without sequences', () => {
      loader.load();
      const sequences = loader.getSequences('copilot-cli');
      expect(sequences).toEqual({});
    });

    it('getSequences returns empty object for unknown CLI', () => {
      loader.load();
      const sequences = loader.getSequences('nonexistent');
      expect(sequences).toEqual({});
    });

    it('getSequenceGroup returns specific group', () => {
      loader.load();
      const prompts = loader.getSequenceGroup('claude-code', 'prompts');
      expect(prompts).toHaveLength(2);
      expect(prompts![0]).toEqual({ label: 'commit', sequence: 'use skill(commit)' });
    });

    it('getSequenceGroup returns null for unknown group', () => {
      loader.load();
      expect(loader.getSequenceGroup('claude-code', 'nonexistent')).toBeNull();
    });

    it('getSequenceGroup returns null for unknown CLI', () => {
      loader.load();
      expect(loader.getSequenceGroup('nonexistent', 'prompts')).toBeNull();
    });

    it('copyCliBindings also copies sequences', () => {
      loader.load();
      loader.copyCliBindings('claude-code', 'copilot-cli');
      const sequences = loader.getSequences('copilot-cli');
      expect(Object.keys(sequences)).toEqual(['prompts', 'snippets']);
      expect(sequences['prompts']).toHaveLength(2);
    });

    it('copied sequences are deep clones (no shared references)', () => {
      loader.load();
      loader.copyCliBindings('claude-code', 'copilot-cli');
      // Mutate target sequences — should not affect source
      const targetSeq = loader.getSequences('copilot-cli');
      targetSeq['prompts'].push({ label: 'new', sequence: 'new item' });
      const sourceSeq = loader.getSequences('claude-code');
      expect(sourceSeq['prompts']).toHaveLength(2);
    });

    it('copyCliBindings persists sequences to disk', () => {
      loader.load();
      loader.copyCliBindings('claude-code', 'copilot-cli');
      const fresh = new ConfigLoader(TEST_DIR);
      fresh.load();
      const sequences = fresh.getSequences('copilot-cli');
      expect(sequences['prompts']).toHaveLength(2);
    });

    it('setSequenceGroup creates a new group', () => {
      loader.load();
      loader.setSequenceGroup('copilot-cli', 'shortcuts', [
        { label: 'clear', sequence: '/clear{Enter}' },
      ]);
      const group = loader.getSequenceGroup('copilot-cli', 'shortcuts');
      expect(group).toHaveLength(1);
      expect(group![0]).toEqual({ label: 'clear', sequence: '/clear{Enter}' });
    });

    it('setSequenceGroup updates an existing group', () => {
      loader.load();
      loader.setSequenceGroup('claude-code', 'prompts', [
        { label: 'only', sequence: 'one item' },
      ]);
      const group = loader.getSequenceGroup('claude-code', 'prompts');
      expect(group).toHaveLength(1);
      expect(group![0].label).toBe('only');
    });

    it('setSequenceGroup persists to disk', () => {
      loader.load();
      loader.setSequenceGroup('copilot-cli', 'actions', [
        { label: 'test', sequence: 'npm test{Enter}' },
      ]);
      const fresh = new ConfigLoader(TEST_DIR);
      fresh.load();
      expect(fresh.getSequenceGroup('copilot-cli', 'actions')).toHaveLength(1);
    });

    it('setSequenceGroup throws for unknown CLI type', () => {
      loader.load();
      expect(() => loader.setSequenceGroup('nonexistent', 'g', [])).toThrow('Unknown CLI type');
    });

    it('removeSequenceGroup deletes a group', () => {
      loader.load();
      loader.removeSequenceGroup('claude-code', 'prompts');
      expect(loader.getSequenceGroup('claude-code', 'prompts')).toBeNull();
      // Other groups preserved
      expect(loader.getSequenceGroup('claude-code', 'snippets')).toHaveLength(1);
    });

    it('removeSequenceGroup cleans up empty sequences object', () => {
      loader.load();
      loader.removeSequenceGroup('claude-code', 'prompts');
      loader.removeSequenceGroup('claude-code', 'snippets');
      expect(loader.getSequences('claude-code')).toEqual({});
    });

    it('removeSequenceGroup persists to disk', () => {
      loader.load();
      loader.removeSequenceGroup('claude-code', 'snippets');
      const fresh = new ConfigLoader(TEST_DIR);
      fresh.load();
      expect(fresh.getSequenceGroup('claude-code', 'snippets')).toBeNull();
      expect(fresh.getSequenceGroup('claude-code', 'prompts')).toHaveLength(2);
    });

    it('removeSequenceGroup is a no-op for nonexistent group', () => {
      loader.load();
      loader.removeSequenceGroup('claude-code', 'nonexistent');
      // No throw, sequences unchanged
      expect(loader.getSequences('claude-code')).toHaveProperty('prompts');
    });
  });

  // =========================================================================
  // Tools CRUD
  // =========================================================================

  describe('Tools CRUD', () => {
    it('addCliType adds a new CLI type and persists', () => {
      loader.load();
      loader.addCliType('new-tool', 'New Tool', 'echo');

      expect(cliTypeSlugs(loader)).toContain('new-tool');
      expect(loader.getCliTypeName('new-tool')).toBe('New Tool');
      expect(loader.getSpawnConfig('new-tool')).toEqual({ command: 'echo', args: [] });

      const onDisk = readCliTypesBySlug();
      expect(onDisk['new-tool']).toBeDefined();
      expect(onDisk['new-tool'].spawnCommand).toBe('echo');
    });

    it('addCliType throws if key already exists', () => {
      loader.load();
      expect(() => loader.addCliType('claude-code', 'X', ''))
        .toThrow('CLI type already exists: claude-code');
    });

    it('updateCliType updates an existing CLI type', () => {
      loader.load();
      loader.updateCliType('claude-code', 'CC Updated', 'cc');

      expect(loader.getCliTypeName('claude-code')).toBe('CC Updated');
      expect(loader.getSpawnConfig('claude-code')).toEqual({ command: 'cc', args: [] });
    });

    it('updateCliType throws for non-existent key', () => {
      loader.load();
      expect(() => loader.updateCliType('nope', 'X', ''))
        .toThrow('CLI type not found: nope');
    });

    it('removeCliType removes and persists', () => {
      loader.load();
      loader.removeCliType('copilot-cli');

      expect(cliTypeSlugs(loader)).not.toContain('copilot-cli');

      const onDisk = readCliTypesBySlug();
      expect(onDisk['copilot-cli']).toBeUndefined();
    });

    it('removeCliType throws for non-existent key', () => {
      loader.load();
      expect(() => loader.removeCliType('nope')).toThrow('CLI type not found: nope');
    });

    it('initialPromptDelay is preserved through updateCliType', () => {
      writeYaml('cli-types.yaml', {
        'claude-code': {
          name: 'Claude Code',
          spawnCommand: 'cc',
          initialPrompt: [{ label: 'Prompt', sequence: 'hello' }],
          initialPromptDelay: 3000,
        },
        'copilot-cli': {
          name: 'GitHub Copilot CLI',
          spawnCommand: 'copilot',
          initialPrompt: [],
        },
      });
      loader.load();

      // Update name and command — delay should survive
      loader.updateCliType('claude-code', 'CC Renamed', 'cc2', [{ label: 'New', sequence: 'new prompt' }]);

      const entry = loader.getCliTypeEntry('claude-code');
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe('CC Renamed');
      expect(entry!.spawnCommand).toBe('cc2');
      expect(entry!.initialPrompt).toEqual([{ label: 'New', sequence: 'new prompt' }]);
      expect(entry!.initialPromptDelay).toBe(3000);

      // Verify persisted to disk
      const onDisk = readCliTypesBySlug();
      expect(onDisk['claude-code'].initialPromptDelay).toBe(3000);
    });

    it('initialPromptDelay is loaded from disk on fresh load', () => {
      writeYaml('cli-types.yaml', {
        'claude-code': {
          name: 'Claude Code',
          spawnCommand: 'cc',
          initialPrompt: [],
          initialPromptDelay: 1500,
        },
      });
      loader.load();

      const entry = loader.getCliTypeEntry('claude-code');
      expect(entry!.initialPromptDelay).toBe(1500);
    });

    it('initialPromptDelay is undefined when not set in config', () => {
      loader.load();
      const entry = loader.getCliTypeEntry('claude-code');
      expect(entry!.initialPromptDelay).toBeUndefined();
    });

    it('addCliType stores helmActions, dropping blank fields', () => {
      loader.load();
      loader.addCliType('worker', 'Worker', [], 0, {
        helmActions: { clear: '/clear{Enter}', compact: '  ', export: '/export $path{Enter}' },
      });

      const entry = loader.getCliTypeEntry('worker');
      expect(entry!.helmActions).toEqual({ clear: '/clear{Enter}', export: '/export $path{Enter}' });
      const onDisk = readCliTypesBySlug();
      expect(onDisk['worker'].helmActions).toEqual({ clear: '/clear{Enter}', export: '/export $path{Enter}' });
    });

    it('addCliType omits helmActions entirely when all fields blank', () => {
      loader.load();
      loader.addCliType('worker', 'Worker', [], 0, { helmActions: { clear: '', compact: '', export: '' } });
      expect(loader.getCliTypeEntry('worker')!.helmActions).toBeUndefined();
    });

    it('updateCliType sets and later clears helmActions', () => {
      loader.load();
      loader.updateCliType('claude-code', 'Claude Code', [], 0, {
        helmActions: { compact: '/compact $instruction{Enter}' },
      });
      expect(loader.getCliTypeEntry('claude-code')!.helmActions).toEqual({ compact: '/compact $instruction{Enter}' });

      // Providing an all-blank map clears the field.
      loader.updateCliType('claude-code', 'Claude Code', [], 0, {
        helmActions: { clear: '', compact: '', export: '' },
      });
      expect(loader.getCliTypeEntry('claude-code')!.helmActions).toBeUndefined();
    });

    it('updateCliType preserves helmActions when options omit the field', () => {
      loader.load();
      loader.updateCliType('claude-code', 'Claude Code', [], 0, { helmActions: { clear: '/clear{Enter}' } });
      // A later update with no helmActions key must not wipe it.
      loader.updateCliType('claude-code', 'Claude Renamed', 'cc');
      expect(loader.getCliTypeEntry('claude-code')!.helmActions).toEqual({ clear: '/clear{Enter}' });
    });

    it('helmActions round-trips from disk on fresh load', () => {
      writeYaml('cli-types.yaml', {
        'claude-code': {
          name: 'Claude Code',
          spawnCommand: 'cc',
          initialPrompt: [],
          helmActions: { clear: '/clear{Enter}', compact: '/compact $instruction{Enter}', export: '/export $path{Enter}' },
        },
      });
      loader.load();
      expect(loader.getCliTypeEntry('claude-code')!.helmActions).toEqual({
        clear: '/clear{Enter}',
        compact: '/compact $instruction{Enter}',
        export: '/export $path{Enter}',
      });
    });

    it('addCliType with initialPromptDelay saves it', () => {
      loader.load();
      loader.addCliType('my-tool', 'My Tool', 'mytool', [{ label: 'Prompt', sequence: 'hello' }], 5000);

      const entry = loader.getCliTypeEntry('my-tool');
      expect(entry).not.toBeNull();
      expect(entry!.initialPromptDelay).toBe(5000);

      const onDisk = readCliTypesBySlug();
      expect(onDisk['my-tool'].initialPromptDelay).toBe(5000);
    });

    it('addCliType saves disabled Helm inter-session preamble option', () => {
      loader.load();
      loader.addCliType('my-tool', 'My Tool', [{ label: 'Prompt', sequence: 'hello' }], 5000, {
        helmPreambleForInterSession: false,
      });

      const entry = loader.getCliTypeEntry('my-tool');
      expect(entry!.helmPreambleForInterSession).toBe(false);

      const onDisk = readCliTypesBySlug();
      expect(onDisk['my-tool'].helmPreambleForInterSession).toBe(false);
    });

    it('updateCliType persists disabled Helm inter-session preamble and omits enabled default', () => {
      loader.load();

      loader.updateCliType('claude-code', 'Claude Code', [{ label: 'Prompt', sequence: 'hello' }], 5000, {
        helmPreambleForInterSession: false,
      });

      let entry = loader.getCliTypeEntry('claude-code');
      expect(entry!.helmPreambleForInterSession).toBe(false);
      let onDisk = readCliTypesBySlug();
      expect(onDisk['claude-code'].helmPreambleForInterSession).toBe(false);

      loader.updateCliType('claude-code', 'Claude Code', [{ label: 'Prompt', sequence: 'hello' }], 5000, {
        helmPreambleForInterSession: true,
      });

      entry = loader.getCliTypeEntry('claude-code');
      expect(entry!.helmPreambleForInterSession).toBeUndefined();
      onDisk = readCliTypesBySlug();
      expect(onDisk['claude-code'].helmPreambleForInterSession).toBeUndefined();
    });

    it('updateCliType with initialPromptDelay saves new value (not preserving old)', () => {
      writeYaml('cli-types.yaml', {
        'claude-code': {
          name: 'Claude Code',
          spawnCommand: 'cc',
          initialPrompt: [],
          initialPromptDelay: 3000,
        },
        'copilot-cli': {
          name: 'GitHub Copilot CLI',
          spawnCommand: 'copilot',
          initialPrompt: [],
        },
      });
      loader.load();

      loader.updateCliType('claude-code', 'CC Updated', 'cc2', [{ label: 'Prompt', sequence: 'prompt' }], 7000);

      const entry = loader.getCliTypeEntry('claude-code');
      expect(entry!.initialPromptDelay).toBe(7000);

      const onDisk = readCliTypesBySlug();
      expect(onDisk['claude-code'].initialPromptDelay).toBe(7000);
    });

    it('updateCliType preserves sequences and other optional fields', () => {
      writeYaml('cli-types.yaml', {
        ...CLI_TYPES,
        'claude-code': {
          ...CLI_TYPES['claude-code'],
          sequences: { prompts: [{ label: 'commit', sequence: 'use skill(commit)' }] },
          renameCommand: '/session {cliSessionName}',
          resumeCommand: 'claude --resume {cliSessionName}',
          continueCommand: 'claude --continue',
        },
      });
      loader = new ConfigLoader(TEST_DIR);
      loader.load();

      // Edit only name/command — all other fields must survive
      loader.updateCliType('claude-code', 'CC Renamed', 'cc2');
      const entry = loader.getCliTypeEntry('claude-code')!;
      expect(entry.name).toBe('CC Renamed');
      expect(entry.spawnCommand).toBe('cc2');
      expect(entry.sequences).toEqual({ prompts: [{ label: 'commit', sequence: 'use skill(commit)' }] });
      expect(entry.renameCommand).toBe('/session {cliSessionName}');
      expect(entry.resumeCommand).toBe('claude --resume {cliSessionName}');
      expect(entry.continueCommand).toBe('claude --continue');
    });

    it('updateCliType with options sets optional command fields', () => {
      loader.load();
      loader.updateCliType('claude-code', 'CC', 'cc', [], 0, {
        renameCommand: '/name {cliSessionName}',
      });
      const entry = loader.getCliTypeEntry('claude-code')!;
      expect(entry.renameCommand).toBe('/name {cliSessionName}');
    });

    it('updateCliType with empty string clears optional field', () => {
      writeYaml('cli-types.yaml', {
        ...CLI_TYPES,
        'claude-code': { ...CLI_TYPES['claude-code'], renameCommand: '/go {cliSessionName}' },
      });
      loader = new ConfigLoader(TEST_DIR);
      loader.load();

      loader.updateCliType('claude-code', 'CC', 'cc', [], 0, { renameCommand: '' });
      const entry = loader.getCliTypeEntry('claude-code')!;
      expect(entry.renameCommand).toBeUndefined();
    });

    it('addCliType with options stores optional command fields', () => {
      loader.load();
      loader.addCliType('new-tool', 'New', 'newtool', [], 0, {
        renameCommand: '/name {cliSessionName}',
        resumeCommand: 'newtool --resume {cliSessionName}',
      });
      const entry = loader.getCliTypeEntry('new-tool')!;
      expect(entry.renameCommand).toBe('/name {cliSessionName}');
      expect(entry.resumeCommand).toBe('newtool --resume {cliSessionName}');
    });

    it('addCliType with spawnCommand stores the full launch template', () => {
      loader.load();
      loader.addCliType('arg-tool', 'Arg Tool', [], 0, {
        spawnCommand: 'mytool --model opus --verbose',
      });
      const entry = loader.getCliTypeEntry('arg-tool')!;
      expect(entry.spawnCommand).toBe('mytool --model opus --verbose');
      expect(loader.getSpawnConfig('arg-tool')).toEqual({
        command: 'mytool',
        args: ['--model', 'opus', '--verbose'],
      });
    });

    it('addCliType stores largeTextAsTempFile when enabled', () => {
      loader.load();
      loader.addCliType('large-tool', 'Large Tool', [], 0, {
        largeTextAsTempFile: true,
      });
      const entry = loader.getCliTypeEntry('large-tool')!;
      expect(entry.largeTextAsTempFile).toBe(true);
    });

    it('updateCliType turns Mess reminders off and omits the true default', () => {
      loader.load();
      loader.updateCliType('claude-code', 'CC', [], 0, { messReminders: false });
      expect(loader.getCliTypeEntry('claude-code')!.messReminders).toBe(false);

      loader.updateCliType('claude-code', 'CC', [], 0, { messReminders: true });
      expect(loader.getCliTypeEntry('claude-code')!.messReminders).toBeUndefined();
    });

    it('updateCliType with spawnCommand stores the full launch template', () => {
      loader.load();
      loader.updateCliType('claude-code', 'CC', [], 0, {
        spawnCommand: 'cc --debug --timeout 30',
      });
      const entry = loader.getCliTypeEntry('claude-code')!;
      expect(entry.spawnCommand).toBe('cc --debug --timeout 30');
    });

    it('updateCliType toggles largeTextAsTempFile and omits the false default', () => {
      loader.load();
      loader.updateCliType('claude-code', 'CC', [], 0, {
        largeTextAsTempFile: true,
      });
      expect(loader.getCliTypeEntry('claude-code')!.largeTextAsTempFile).toBe(true);

      loader.updateCliType('claude-code', 'CC', [], 0, {
        largeTextAsTempFile: false,
      });
      expect(loader.getCliTypeEntry('claude-code')!.largeTextAsTempFile).toBeUndefined();
    });

    it('updateCliType toggles mouseTracking and omits the false default', () => {
      loader.load();
      loader.addCliType('mouse-tool', 'Mouse Tool', [], 0, { mouseTracking: true });
      expect(loader.getCliTypeEntry('mouse-tool')!.mouseTracking).toBe(true);

      loader.updateCliType('mouse-tool', 'Mouse Tool', [], 0, { mouseTracking: false });
      expect(loader.getCliTypeEntry('mouse-tool')!.mouseTracking).toBeUndefined();

      loader.updateCliType('mouse-tool', 'Mouse Tool', [], 0, { mouseTracking: true });
      expect(loader.getCliTypeEntry('mouse-tool')!.mouseTracking).toBe(true);
    });

    it('addCliType with env stores environment variable entries', () => {
      loader.load();
      loader.addCliType('env-tool', 'Env Tool', 'mytool', [], 0, {
        env: [
          { name: 'COPILOT_PROVIDER_BASE_URL', value: 'http://192.168.56.1:1234' },
          { name: 'COPILOT_MODEL', value: 'qwen/qwen3.6-35b-a3b' },
        ],
      });

      const entry = loader.getCliTypeEntry('env-tool')!;
      expect(entry.env).toEqual([
        { name: 'COPILOT_PROVIDER_BASE_URL', value: 'http://192.168.56.1:1234' },
        { name: 'COPILOT_MODEL', value: 'qwen/qwen3.6-35b-a3b' },
      ]);
    });

    it('updateCliType with env replaces environment variable entries', () => {
      writeYaml('cli-types.yaml', {
        ...CLI_TYPES,
        'claude-code': {
          ...CLI_TYPES['claude-code'],
          env: [{ name: 'OLD_KEY', value: 'old-value' }],
        },
      });
      loader = new ConfigLoader(TEST_DIR);
      loader.load();

      loader.updateCliType('claude-code', 'CC', 'cc', [], 0, {
        env: [
          { name: 'COPILOT_PROVIDER_TYPE', value: 'openai' },
          { name: 'COPILOT_MODEL', value: 'qwen' },
        ],
      });

      const entry = loader.getCliTypeEntry('claude-code')!;
      expect(entry.env).toEqual([
        { name: 'COPILOT_PROVIDER_TYPE', value: 'openai' },
        { name: 'COPILOT_MODEL', value: 'qwen' },
      ]);
    });

    it('updateCliType with empty spawnCommand clears the fresh launch template', () => {
      writeYaml('cli-types.yaml', {
        ...CLI_TYPES,
        'claude-code': { ...CLI_TYPES['claude-code'], spawnCommand: 'cc --verbose' },
      });
      loader = new ConfigLoader(TEST_DIR);
      loader.load();

      loader.updateCliType('claude-code', 'CC', [], 0, { spawnCommand: '' });
      const entry = loader.getCliTypeEntry('claude-code')!;
      expect(entry.spawnCommand).toBeUndefined();
    });

    it('updateCliType with empty env clears env field', () => {
      writeYaml('cli-types.yaml', {
        ...CLI_TYPES,
        'claude-code': {
          ...CLI_TYPES['claude-code'],
          env: [{ name: 'COPILOT_MODEL', value: 'qwen' }],
        },
      });
      loader = new ConfigLoader(TEST_DIR);
      loader.load();

      loader.updateCliType('claude-code', 'CC', 'cc', [], 0, { env: [] });
      const entry = loader.getCliTypeEntry('claude-code')!;
      expect(entry.env).toBeUndefined();
    });

    it('spawnCommand round-trip preserves on disk', () => {
      loader.load();
      loader.addCliType('rt-tool', 'RT', [], 0, { spawnCommand: 'rt --flag value' });

      const fresh = new ConfigLoader(TEST_DIR);
      fresh.load();
      expect(fresh.getCliTypeEntry('rt-tool')!.spawnCommand).toBe('rt --flag value');
      expect(fresh.getSpawnConfig('rt-tool')).toEqual({
        command: 'rt',
        args: ['--flag', 'value'],
      });
    });

    it('env round-trip preserves on disk and sanitizes invalid entries on load', () => {
      writeYaml('cli-types.yaml', {
        ...CLI_TYPES,
        'claude-code': {
          ...CLI_TYPES['claude-code'],
          env: [
            { name: 'COPILOT_PROVIDER_BASE_URL', value: 'http://localhost:1234' },
            { name: '  COPILOT_MODEL  ', value: 'qwen' },
            { name: '', value: 'ignored' },
          ],
        },
      });

      const fresh = new ConfigLoader(TEST_DIR);
      fresh.load();
      expect(fresh.getCliTypeEntry('claude-code')!.env).toEqual([
        { name: 'COPILOT_PROVIDER_BASE_URL', value: 'http://localhost:1234' },
        { name: 'COPILOT_MODEL', value: 'qwen' },
      ]);
    });

    it('getSpawnConfig preserves quoted args for complex CLI options', () => {
      loader.load();
      loader.addCliType('codex', 'Codex CLI', [], 0, {
        spawnCommand: 'codex --full-auto -c \'model="gpt-5"\' --cd "X:\\coding\\My Project"',
      });

      expect(loader.getSpawnConfig('codex')).toEqual({
        command: 'codex',
        args: ['--full-auto', '-c', 'model="gpt-5"', '--cd', 'X:\\coding\\My Project'],
      });
    });

    it('updateCliType round-trip preserves all fields on disk', () => {
      writeYaml('cli-types.yaml', {
        ...CLI_TYPES,
        'claude-code': {
          ...CLI_TYPES['claude-code'],
          sequences: { prompts: [{ label: 'x', sequence: 'y' }] },
          renameCommand: '/h {cliSessionName}',
          continueCommand: 'c',
        },
      });
      loader = new ConfigLoader(TEST_DIR);
      loader.load();

      loader.updateCliType('claude-code', 'New Name', 'new-cmd');

      // Reload from disk
      const fresh = new ConfigLoader(TEST_DIR);
      fresh.load();
      const entry = fresh.getCliTypeEntry('claude-code')!;
      expect(entry.name).toBe('New Name');
      expect(entry.spawnCommand).toBe('new-cmd');
      expect(entry.sequences).toEqual({ prompts: [{ label: 'x', sequence: 'y' }] });
      expect(entry.renameCommand).toBe('/h {cliSessionName}');
      expect(entry.continueCommand).toBe('c');
    });

    it('auto-migrates string initialPrompt to SequenceListItem array on load', () => {
      writeYaml('cli-types.yaml', {
        'claude-code': {
          name: 'Claude Code',
          spawnCommand: 'cc',
          initialPrompt: 'hello world',
          initialPromptDelay: 1000,
        },
      });
      loader.load();

      const entry = loader.getCliTypeEntry('claude-code');
      expect(entry!.initialPrompt).toEqual([{ label: 'Prompt', sequence: 'hello world' }]);
      expect(entry!.initialPromptDelay).toBe(1000);

      // Verify migrated on disk too
      const onDisk = readCliTypesBySlug();
      expect(onDisk['claude-code'].initialPrompt).toEqual([{ label: 'Prompt', sequence: 'hello world' }]);
    });

    it('auto-migrates empty string initialPrompt to empty array', () => {
      writeYaml('cli-types.yaml', {
        'claude-code': {
          name: 'Claude Code',
          spawnCommand: 'cc',
          initialPrompt: '',
        },
      });
      loader.load();

      const entry = loader.getCliTypeEntry('claude-code');
      expect(entry!.initialPrompt).toEqual([]);
    });

    it('does not re-migrate already-migrated initialPrompt arrays', () => {
      writeYaml('cli-types.yaml', {
        'claude-code': {
          name: 'Claude Code',
          spawnCommand: 'cc',
          initialPrompt: [{ label: 'Cmd', sequence: '/clear{Enter}' }],
        },
      });
      loader.load();

      const entry = loader.getCliTypeEntry('claude-code');
      expect(entry!.initialPrompt).toEqual([{ label: 'Cmd', sequence: '/clear{Enter}' }]);
    });
  });

  describe('button naming in bindings', () => {
    it('loads bindings with Sandwich button name', () => {
      writeYaml('bindings.yaml', {
        'claude-code': {
          Sandwich: { action: 'keyboard', sequence: '{Escape}' },
        },
      });
      loader.load();

      const bindings = loader.getBindings('claude-code');
      expect(bindings).toHaveProperty('Sandwich');
      expect(bindings!['Sandwich']).toEqual({ action: 'keyboard', sequence: '{Escape}' });
    });

    it('loads bindings with Xbox button name', () => {
      writeYaml('bindings.yaml', {
        'claude-code': {
          Xbox: { action: 'keyboard', sequence: '{Enter}' },
          Back: { action: 'keyboard', sequence: '{Escape}' },
        },
      });
      loader.load();

      const bindings = loader.getBindings('claude-code');
      expect(bindings).toHaveProperty('Xbox');
      expect(bindings!['Xbox']).toEqual({ action: 'keyboard', sequence: '{Enter}' });
    });

    it('persists renamed button bindings through setBinding', () => {
      loader.load();
      loader.setBinding('Sandwich', 'claude-code', { action: 'keyboard', keys: ['Ctrl', 'w'] });

      // Re-load and verify
      loader.load();
      const bindings = loader.getBindings('claude-code');
      expect(bindings).toHaveProperty('Sandwich');
      expect(bindings!['Sandwich']).toEqual({ action: 'keyboard', keys: ['Ctrl', 'w'] });
    });
  });

  // =========================================================================
  // Stick Config
  // =========================================================================

  describe('getStickConfig', () => {
    it('returns defaults when input-config has no sticks section', () => {
      loader.load();
      const left = loader.getStickConfig('left');
      expect(left).toEqual({ mode: 'disabled', deadzone: 0.25, repeatRate: 50 });

      const right = loader.getStickConfig('right');
      expect(right).toEqual({ mode: 'disabled', deadzone: 0.25, repeatRate: 50 });
    });

    it('returns stick config from input-config when present', () => {
      writeYaml('input-config.yaml', {
        workingDirectories: WORKING_DIRS,
        sticks: {
          left: { mode: 'cursor', deadzone: 0.3, repeatRate: 80 },
          right: { mode: 'scroll', deadzone: 0.2, repeatRate: 150 },
        },
      });
      loader.load();

      expect(loader.getStickConfig('left')).toEqual({ mode: 'cursor', deadzone: 0.3, repeatRate: 80 });
      expect(loader.getStickConfig('right')).toEqual({ mode: 'scroll', deadzone: 0.2, repeatRate: 150 });
    });

    it('returns defaults for missing stick when only one is configured', () => {
      writeYaml('input-config.yaml', {
        workingDirectories: WORKING_DIRS,
        sticks: {
          left: { mode: 'cursor', deadzone: 0.25, repeatRate: 100 },
        },
      });
      loader.load();

      expect(loader.getStickConfig('left')).toEqual({ mode: 'cursor', deadzone: 0.25, repeatRate: 100 });
      expect(loader.getStickConfig('right')).toEqual({ mode: 'disabled', deadzone: 0.25, repeatRate: 50 });
    });

    it('throws when called before load', () => {
      expect(() => loader.getStickConfig('left')).toThrow('Configuration not loaded');
    });
  });

  // =========================================================================
  // getDpadConfig
  // =========================================================================

  describe('getDpadConfig', () => {
    it('returns defaults when input-config has no dpad section', () => {
      loader.load();
      expect(loader.getDpadConfig()).toEqual({ initialDelay: 400, repeatRate: 120 });
    });

    it('returns dpad config from input-config when present', () => {
      writeYaml('input-config.yaml', {
        workingDirectories: WORKING_DIRS,
        dpad: { initialDelay: 300, repeatRate: 80 },
      });
      loader.load();

      expect(loader.getDpadConfig()).toEqual({ initialDelay: 300, repeatRate: 80 });
    });

    it('fills in defaults for partial dpad config', () => {
      writeYaml('input-config.yaml', {
        workingDirectories: WORKING_DIRS,
        dpad: { initialDelay: 500 },
      });
      loader.load();

      expect(loader.getDpadConfig()).toEqual({ initialDelay: 500, repeatRate: 120 });
    });
  });

  // =========================================================================
  // Activity config
  // =========================================================================

  describe('getActivityTimeout', () => {
    it('returns default 5000ms when input-config has no activity section', () => {
      loader.load();
      expect(loader.getActivityTimeout()).toBe(5000);
    });

    it('returns activity timeout from input-config when present', () => {
      writeYaml('input-config.yaml', {
        workingDirectories: WORKING_DIRS,
        activity: { timeoutMs: 45000 },
      });
      loader.load();

      expect(loader.getActivityTimeout()).toBe(45000);
    });
  });

  describe('setActivityTimeout', () => {
    it('sets activity timeout and persists to input-config', () => {
      loader.load();
      loader.setActivityTimeout(60000);

      expect(loader.getActivityTimeout()).toBe(60000);

      const config = readYaml<any>('input-config.yaml');
      expect(config.activity?.timeoutMs).toBe(60000);
    });

    it('updates existing activity config', () => {
      writeYaml('input-config.yaml', {
        workingDirectories: WORKING_DIRS,
        activity: { timeoutMs: 45000 },
      });
      loader.load();

      loader.setActivityTimeout(15000);

      const config = readYaml<any>('input-config.yaml');
      expect(config.activity?.timeoutMs).toBe(15000);
    });
  });

  // =========================================================================
  // Scroll binding type
  // =========================================================================

  describe('scroll binding type', () => {
    it('can store and retrieve scroll bindings', () => {
      loader.load();
      loader.setBinding('RightStickUp', 'claude-code', { action: 'scroll', direction: 'up', lines: 3 } as any);
      loader.setBinding('RightStickDown', 'claude-code', { action: 'scroll', direction: 'down' } as any);

      const bindings = loader.getBindings('claude-code')!;
      expect(bindings['RightStickUp']).toEqual({ action: 'scroll', direction: 'up', lines: 3 });
      expect(bindings['RightStickDown']).toEqual({ action: 'scroll', direction: 'down' });
    });

    it('persists scroll bindings to disk', () => {
      loader.load();
      loader.setBinding('RightStickUp', 'claude-code', { action: 'scroll', direction: 'up' } as any);

      // Reload from disk
      const freshLoader = new ConfigLoader(TEST_DIR);
      freshLoader.load();
      const bindings = freshLoader.getBindings('claude-code')!;
      expect(bindings['RightStickUp']).toEqual({ action: 'scroll', direction: 'up' });
    });
  });

  // =========================================================================
  // Haptic Feedback Setting
  // =========================================================================

  describe('hapticFeedback', () => {
    it('defaults to true when not present in settings.yaml', () => {
      // SETTINGS fixture has hapticFeedback: true
      loader.load();
      expect(loader.getHapticFeedback()).toBe(true);
    });

    it('reads hapticFeedback from settings.yaml when present', () => {
      writeYaml('settings.yaml', { hapticFeedback: false });
      loader.load();
      expect(loader.getHapticFeedback()).toBe(false);
    });

    it('setHapticFeedback persists to settings.yaml', () => {
      loader.load();
      loader.setHapticFeedback(false);

      const onDisk = readYaml<any>('settings.yaml');
      expect(onDisk.hapticFeedback).toBe(false);
    });

    it('setHapticFeedback round-trips through reload', () => {
      loader.load();
      loader.setHapticFeedback(false);

      // Create a fresh loader and reload
      const loader2 = new ConfigLoader(TEST_DIR);
      loader2.load();
      expect(loader2.getHapticFeedback()).toBe(false);
    });

    it('throws when called before load', () => {
      expect(() => loader.getHapticFeedback()).toThrow('Configuration not loaded');
    });
  });

  describe('operator config', () => {
    it('defaults to disabled with no CLI type, and round-trips through settings.yaml', () => {
      loader.load();
      expect(loader.getOperatorConfig()).toEqual({ enabled: false, cliType: '', workingDir: '' });
      loader.setOperatorConfig({ enabled: true, cliType: 'uuid-1' });
      expect(readYaml<any>('settings.yaml').operator).toEqual({ enabled: true, cliType: 'uuid-1', workingDir: '' });
      const loader2 = new ConfigLoader(TEST_DIR);
      loader2.load();
      expect(loader2.getOperatorConfig()).toEqual({ enabled: true, cliType: 'uuid-1', workingDir: '' });
    });
  });

  describe('update check mode', () => {
    it('defaults to auto, and treats an unknown value as auto', () => {
      loader.load();
      expect(loader.getUpdateCheckMode()).toBe('auto');
      writeYaml('settings.yaml', { ...SETTINGS, updateCheck: 'sometimes' });
      const loader2 = new ConfigLoader(TEST_DIR);
      loader2.load();
      expect(loader2.getUpdateCheckMode()).toBe('auto');
    });

    it('manual round-trips through settings.yaml', () => {
      loader.load();
      loader.setUpdateCheckMode('manual');
      expect(readYaml<any>('settings.yaml').updateCheck).toBe('manual');
      const loader2 = new ConfigLoader(TEST_DIR);
      loader2.load();
      expect(loader2.getUpdateCheckMode()).toBe('manual');
    });
  });

  // =========================================================================
  // Sidebar preferences
  // =========================================================================

  describe('sidebar preferences', () => {
    it('getSidebarPrefs returns defaults when settings.yaml has no sidebar section', () => {
      loader.load();
      expect(loader.getSidebarPrefs()).toEqual({ width: 1280, height: undefined, x: undefined, y: undefined });
    });

    it('getSidebarPrefs reads saved values from settings.yaml', () => {
      writeYaml('settings.yaml', { sidebar: { width: 400 } });
      loader.load();
      expect(loader.getSidebarPrefs()).toMatchObject({ width: 400 });
    });

    it('setSidebarPrefs updates only width', () => {
      writeYaml('settings.yaml', { sidebar: { width: 320 } });
      loader.load();
      loader.setSidebarPrefs({ width: 400 });
      expect(loader.getSidebarPrefs()).toMatchObject({ width: 400 });
    });

    it('setSidebarPrefs persists to disk', () => {
      loader.load();
      loader.setSidebarPrefs({ width: 500 });

      const onDisk = readYaml<any>('settings.yaml');
      expect(onDisk.sidebar.width).toBe(500);
    });

    it('getSidebarPrefs fills missing fields from defaults', () => {
      writeYaml('settings.yaml', { sidebar: {} });
      loader.load();
      expect(loader.getSidebarPrefs()).toEqual({ width: 1280, height: undefined, x: undefined, y: undefined });
    });

    it('round-trips height, x, y through set/get', () => {
      loader.load();
      loader.setSidebarPrefs({ width: 1000, height: 600, x: 100, y: 50 });
      const prefs = loader.getSidebarPrefs();
      expect(prefs.height).toBe(600);
      expect(prefs.x).toBe(100);
      expect(prefs.y).toBe(50);
    });

    it('throws when called before load', () => {
      expect(() => loader.getSidebarPrefs()).toThrow('Configuration not loaded');
    });
  });

  // =========================================================================
  // Dock workspace persistence
  // =========================================================================

  describe('dock workspace persistence', () => {
    it('round-trips the renderer-owned layout through settings.yaml', () => {
      const layout = createDefaultLayout();
      loader.load();
      loader.setWorkspaceLayout(layout);

      expect(loader.getWorkspaceLayout()).toEqual(layout);
      expect(readYaml<any>('settings.yaml').workspaceLayout).toEqual(layout);
    });

    it('preserves unrelated settings while updating the layout', () => {
      writeYaml('settings.yaml', {
        ...SETTINGS,
        notifications: false,
        sidebar: { width: 444, spawnCollapsed: true },
      });
      loader.load();
      loader.setWorkspaceLayout(createDefaultLayout());

      const onDisk = readYaml<any>('settings.yaml');
      expect(onDisk.notifications).toBe(false);
      expect(onDisk.sidebar).toEqual({ width: 444, spawnCollapsed: true });
      expect(onDisk.workspaceLayout).toEqual(createDefaultLayout());
    });

    it('stores the pop-out profile under its own key, leaving the main layout alone', () => {
      const mainLayout = createDefaultLayout('main');
      const popoutLayout = createDefaultLayout('popout');
      loader.load();
      loader.setWorkspaceLayout(mainLayout);
      loader.setWorkspaceLayout(popoutLayout, 'popout');

      expect(loader.getWorkspaceLayout()).toEqual(mainLayout);
      expect(loader.getWorkspaceLayout('popout')).toEqual(popoutLayout);

      const onDisk = readYaml<any>('settings.yaml');
      expect(onDisk.workspaceLayout).toEqual(mainLayout);
      expect(onDisk.popoutWorkspaceLayout).toEqual(popoutLayout);
    });

    it('throws before configuration is loaded', () => {
      const unloaded = new ConfigLoader(TEST_DIR);
      expect(() => unloaded.getWorkspaceLayout()).toThrow('Configuration not loaded');
      expect(() => unloaded.setWorkspaceLayout(createDefaultLayout())).toThrow('Configuration not loaded');
    });
  });

  // =========================================================================
  // buildSpawnConfig (via getSpawnConfig)
  // =========================================================================

  describe('buildSpawnConfig', () => {
    it('builds spawn config with command', () => {
      writeYaml('cli-types.yaml', { test: { name: 'Test', spawnCommand: 'python' } });
      loader.load();
      expect(loader.getSpawnConfig('test')).toEqual({ command: 'python', args: [] });
    });

    it('builds spawn config without command', () => {
      writeYaml('cli-types.yaml', { test: { name: 'Test', spawnCommand: '' } });
      loader.load();
      expect(loader.getSpawnConfig('test')).toEqual({ command: '', args: [] });
    });
  });
});

// ============================================================================
// stickVirtualButtonName
// ============================================================================

describe('stickVirtualButtonName', () => {
  it('builds left stick up name', () => {
    expect(stickVirtualButtonName('left', 'up')).toBe('LeftStickUp');
  });

  it('builds right stick down name', () => {
    expect(stickVirtualButtonName('right', 'down')).toBe('RightStickDown');
  });

  it('builds left stick right name', () => {
    expect(stickVirtualButtonName('left', 'right')).toBe('LeftStickRight');
  });

  it('builds right stick left name', () => {
    expect(stickVirtualButtonName('right', 'left')).toBe('RightStickLeft');
  });
});

describe('STICK_VIRTUAL_BUTTONS', () => {
  it('contains exactly 8 virtual button names', () => {
    expect(STICK_VIRTUAL_BUTTONS).toHaveLength(8);
  });

  it('includes all 4 directions for each stick', () => {
    expect(STICK_VIRTUAL_BUTTONS).toContain('LeftStickUp');
    expect(STICK_VIRTUAL_BUTTONS).toContain('LeftStickDown');
    expect(STICK_VIRTUAL_BUTTONS).toContain('LeftStickLeft');
    expect(STICK_VIRTUAL_BUTTONS).toContain('LeftStickRight');
    expect(STICK_VIRTUAL_BUTTONS).toContain('RightStickUp');
    expect(STICK_VIRTUAL_BUTTONS).toContain('RightStickDown');
    expect(STICK_VIRTUAL_BUTTONS).toContain('RightStickLeft');
    expect(STICK_VIRTUAL_BUTTONS).toContain('RightStickRight');
  });
});

// ============================================================================
// slugify (standalone export)
// ============================================================================

import { slugify } from '../src/config/loader.js';
import {
  normalizeMcpPort,
  normalizeToolConfig,
  parseCliArgs,
  parseCommandTemplate,
  resolveEnvWithMode,
} from '../src/config/loader-helpers.js';

describe('slugify', () => {
  it('converts name to kebab-case slug', () => {
    expect(slugify('Claude Code')).toBe('claude-code');
  });

  it('handles special characters', () => {
    expect(slugify('My Tool (v2)')).toBe('my-tool-v2');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('handles already-kebab input', () => {
    expect(slugify('claude-code')).toBe('claude-code');
  });

  it('collapses multiple separators', () => {
    expect(slugify('a   b   c')).toBe('a-b-c');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

describe('loader helper module', () => {
  it('parses CLI args and command templates outside ConfigLoader', () => {
    expect(parseCliArgs('codex --cd "X:\\coding\\My Project" --flag')).toEqual([
      'codex',
      '--cd',
      'X:\\coding\\My Project',
      '--flag',
    ]);
    expect(parseCommandTemplate('codex --full-auto')).toEqual({
      command: 'codex',
      args: ['--full-auto'],
    });
    expect(parseCommandTemplate('')).toEqual({ command: '', args: [] });
  });

  it('resolves env entries with append and prepend modes', () => {
    const result = resolveEnvWithMode(
      [
        { name: 'PLAIN', value: 'value' },
        { name: 'PATH', value: 'front', mode: 'prepend' },
        { name: 'TAIL', value: 'back', mode: 'append' },
      ],
      { PATH: 'existing', TAIL: 'existing' },
      (raw) => raw.toUpperCase(),
    );

    expect(result.PLAIN).toBe('VALUE');
    expect(result.PATH).toContain('FRONT');
    expect(result.PATH).toContain('existing');
    expect(result.TAIL).toContain('existing');
    expect(result.TAIL).toContain('BACK');
  });

  it('normalizes MCP ports and legacy tool launch fields outside ConfigLoader', () => {
    expect(normalizeMcpPort(49000)).toBe(49000);
    expect(normalizeMcpPort('nope')).toBe(47373);

    const tool: any = {
      name: 'Legacy',
      command: 'legacy-cli',
      args: '--flag value',
      initialPrompt: 'hello',
      env: [{ name: ' PATH ', value: 'x', mode: 'prepend' }, { name: '', value: 'skip' }],
    };

    expect(normalizeToolConfig(tool)).toBe(true);
    expect(tool.spawnCommand).toBe('legacy-cli --flag value');
    expect(tool.command).toBeUndefined();
    expect(tool.args).toBeUndefined();
    expect(tool.initialPrompt).toEqual([{ label: 'Prompt', sequence: 'hello' }]);
    expect(tool.env).toEqual([{ name: 'PATH', value: 'x', mode: 'prepend' }]);
  });
});
