/**
 * cli-type-migration — one-time re-key of CLI types from slug keys to UUID v4 ids.
 *
 * Uses real YAML files in a temp dir (no mocks) so the write-verify-swap path is
 * exercised exactly as it runs in production.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { migrateCliTypeIds, type CliTypeMigrationFiles } from '../src/config/cli-type-migration.js';
import { ConfigLoader } from '../src/config/loader.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let TEST_DIR: string;
let files: CliTypeMigrationFiles;

function write(name: string, data: unknown): void {
  fs.writeFileSync(path.join(TEST_DIR, name), YAML.stringify(data), 'utf8');
}

function read<T>(name: string): T {
  return YAML.parse(fs.readFileSync(path.join(TEST_DIR, name), 'utf8')) as T;
}

const CLI_TYPES = {
  'claude-code': {
    name: 'Claude Code',
    spawnCommand: 'claude --session-id {cliSessionName}',
    initialPrompt: [{ label: 'hi', sequence: 'hello' }],
    sequences: { review: [{ label: 'Review', sequence: '/review' }] },
    patterns: [{ id: 'p1', name: 'rule', regex: 'foo', type: 'send-text', sequence: 'bar' }],
    env: [{ name: 'FOO', value: 'bar' }],
  },
  'copilot-cli': {
    name: 'Copilot',
    spawnCommand: 'copilot',
  },
  zed: {
    name: 'Zed',
  },
};

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(process.cwd(), '.test-cli-type-migration-'));
  files = {
    cliTypesFile: path.join(TEST_DIR, 'cli-types.yaml'),
    sessionsFile: path.join(TEST_DIR, 'sessions.yaml'),
    recycleBinFile: path.join(TEST_DIR, 'recycle-bin.yaml'),
    scheduledTasksFile: path.join(TEST_DIR, 'scheduled-tasks.yaml'),
    scheduledTaskHistoryFile: path.join(TEST_DIR, 'scheduled-task-history.yaml'),
  };
  write('cli-types.yaml', CLI_TYPES);
});

afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('migrateCliTypeIds', () => {
  it('mints a uuid per entry, preserves order and every config field', () => {
    expect(migrateCliTypeIds(files)).toBe(true);

    const out = read<Record<string, any>>('cli-types.yaml');
    const keys = Object.keys(out);
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(key).toMatch(UUID_V4);
    expect(new Set(keys).size).toBe(3);

    // Order preserved: claude-code, copilot-cli, zed
    expect(keys.map(k => out[k].displayName)).toEqual(['Claude Code', 'Copilot', 'Zed']);
    for (const key of keys) expect(out[key].id).toBe(key);

    const cc = out[keys[0]];
    expect(cc.spawnCommand).toBe('claude --session-id {cliSessionName}');
    expect(cc.initialPrompt).toEqual([{ label: 'hi', sequence: 'hello' }]);
    expect(cc.sequences).toEqual({ review: [{ label: 'Review', sequence: '/review' }] });
    expect(cc.patterns).toEqual(CLI_TYPES['claude-code'].patterns);
    expect(cc.env).toEqual([{ name: 'FOO', value: 'bar' }]);
  });

  it('records legacyKey for every migrated entry', () => {
    migrateCliTypeIds(files);
    const out = read<Record<string, any>>('cli-types.yaml');
    expect(Object.values(out).map(e => e.legacyKey)).toEqual(['claude-code', 'copilot-cli', 'zed']);
  });

  it('falls back to the slug when the legacy entry has no name', () => {
    write('cli-types.yaml', { 'bare-cli': { spawnCommand: 'bare' } });
    migrateCliTypeIds(files);
    const out = read<Record<string, any>>('cli-types.yaml');
    expect(Object.values(out)[0].displayName).toBe('bare-cli');
  });

  it('leaves bindings.yaml alone — binding profiles are not keyed by CLI type', () => {
    write('bindings.yaml', { 'claude-code': { A: { action: 'keyboard', sequence: '{Enter}' } } });
    const before = fs.readFileSync(path.join(TEST_DIR, 'bindings.yaml'), 'utf8');

    migrateCliTypeIds(files);

    expect(fs.readFileSync(path.join(TEST_DIR, 'bindings.yaml'), 'utf8')).toBe(before);
  });

  it('rewrites sessions, recycle-bin entries, scheduled tasks and history cliType slug -> uuid', () => {
    write('sessions.yaml', { sessions: [{ id: 's1', name: 'S1', cliType: 'claude-code', processId: 1 }] });
    write('recycle-bin.yaml', { entries: [{ cliSessionName: 'u1', closedAt: Date.now(), cliType: 'copilot-cli' }] });
    write('scheduled-tasks.yaml', { tasks: [{ id: 't1', cliType: 'zed', scheduledTime: '2026-01-01T00:00:00.000Z' }] });
    write('scheduled-task-history.yaml', { entries: [{ id: 'h1', ranAt: Date.now(), cliType: 'zed' }] });

    migrateCliTypeIds(files);

    const types = read<Record<string, any>>('cli-types.yaml');
    const byLegacy = Object.fromEntries(Object.values(types).map((e: any) => [e.legacyKey, e.id]));

    expect(read<any>('sessions.yaml').sessions[0].cliType).toBe(byLegacy['claude-code']);
    expect(read<any>('sessions.yaml').sessions[0].name).toBe('S1');
    expect(read<any>('recycle-bin.yaml').entries[0].cliType).toBe(byLegacy['copilot-cli']);
    expect(read<any>('scheduled-tasks.yaml').tasks[0].cliType).toBe(byLegacy.zed);
    expect(read<any>('scheduled-tasks.yaml').tasks[0].scheduledTime).toBe('2026-01-01T00:00:00.000Z');
    expect(read<any>('scheduled-task-history.yaml').entries[0].cliType).toBe(byLegacy.zed);
  });

  it('leaves unknown cliType values untouched', () => {
    write('sessions.yaml', { sessions: [{ id: 's1', name: 'S1', cliType: 'ghost-cli', processId: 1 }] });
    migrateCliTypeIds(files);
    expect(read<any>('sessions.yaml').sessions[0].cliType).toBe('ghost-cli');
  });

  it('is idempotent — a second run is a no-op and leaves files byte-identical', () => {
    write('sessions.yaml', { sessions: [{ id: 's1', name: 'S1', cliType: 'claude-code', processId: 1 }] });

    expect(migrateCliTypeIds(files)).toBe(true);
    const snapshot = Object.fromEntries(
      Object.values(files).map(f => [f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null]),
    );

    expect(migrateCliTypeIds(files)).toBe(false);
    for (const [file, content] of Object.entries(snapshot)) {
      expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null).toBe(content);
    }
  });

  it('returns false when there is no cli-types file', () => {
    fs.rmSync(files.cliTypesFile);
    expect(migrateCliTypeIds(files)).toBe(false);
  });

  it('leaves the originals untouched when staging fails', () => {
    write('sessions.yaml', { sessions: [{ id: 's1', name: 'S1', cliType: 'claude-code', processId: 1 }] });
    const beforeTypes = fs.readFileSync(files.cliTypesFile, 'utf8');
    const beforeSessions = fs.readFileSync(files.sessionsFile, 'utf8');
    // A directory where the staged temp file must go makes the write fail.
    fs.mkdirSync(files.cliTypesFile + '.migrating');

    expect(migrateCliTypeIds(files)).toBe(false);
    expect(fs.readFileSync(files.cliTypesFile, 'utf8')).toBe(beforeTypes);
    expect(fs.readFileSync(files.sessionsFile, 'utf8')).toBe(beforeSessions);
  });
});

describe('ConfigLoader CLI type identity', () => {
  beforeEach(() => {
    write('settings.yaml', { hapticFeedback: true, notifications: true, escProtectionEnabled: true });
  });

  it('addCliType mints a fresh uuid key with displayName', () => {
    const loader = new ConfigLoader(TEST_DIR);
    loader.load();
    loader.addCliType('gemini-cli', 'Gemini CLI', 'gemini');

    const keys = loader.getCliTypes();
    const added = keys.find(k => loader.getCliTypeEntry(k)?.displayName === 'Gemini CLI')!;
    expect(added).toMatch(UUID_V4);
    expect(loader.getCliTypeEntry(added)?.id).toBe(added);
    expect(loader.getCliTypeEntry(added)?.spawnCommand).toBe('gemini');
  });

  it('addCliType mints a distinct uuid for each call', () => {
    const loader = new ConfigLoader(TEST_DIR);
    loader.load();
    loader.addCliType('a', 'A');
    loader.addCliType('b', 'A');
    const keys = loader.getCliTypes().filter(k => loader.getCliTypeEntry(k)?.displayName === 'A');
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('updateCliType changes displayName only — id and binding profile untouched', () => {
    const loader = new ConfigLoader(TEST_DIR);
    loader.load();
    const id = loader.getCliTypes().find(
      k => loader.getCliTypeEntry(k)?.displayName === 'Claude Code',
    )!;
    const profileId = loader.createBindingProfile('P');
    loader.setBinding(profileId, 'A', { action: 'context-menu' });
    loader.updateCliType(id, 'Claude Code', [], 0, { bindingProfileId: profileId });

    loader.updateCliType(id, 'Renamed Claude');

    expect(loader.getCliTypes()).toContain(id);
    expect(loader.getCliTypeEntry(id)?.id).toBe(id);
    expect(loader.getCliTypeEntry(id)?.displayName).toBe('Renamed Claude');
    expect(loader.getCliTypeName(id)).toBe('Renamed Claude');
    expect(loader.getCliTypeEntry(id)?.legacyKey).toBe('claude-code');
    expect(loader.getBindings(id)).toEqual({ A: { action: 'context-menu' } });
  });
});
