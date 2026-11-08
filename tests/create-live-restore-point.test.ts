import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateProfileConfig } from '../src/config/profile-config-migration.js';
import { getConfigDir, getProfileConfigDir } from '../src/utils/app-paths.js';

const roots: string[] = [];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const restorePointScript = path.join(projectRoot, 'scripts', 'create-live-restore-point.mjs');

function makeAppDataBase(): string {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'helm-live-restore-point-'));
  roots.push(base);
  return base;
}

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runRestorePoint(appDataBase: string): { destination: string; manifest: Record<string, unknown> } {
  const env = { ...process.env };
  if (process.platform === 'win32') env.APPDATA = appDataBase;
  else if (process.platform === 'darwin') env.HOME = appDataBase;
  else env.XDG_CONFIG_HOME = appDataBase;
  const output = execFileSync(process.execPath, [restorePointScript], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
  const destinationLine = output.split(/\r?\n/).find(line => line.startsWith('[restore-point] '));
  expect(destinationLine).toBeDefined();
  const destination = destinationLine!
    .slice('[restore-point] '.length)
    .replace(/ \(\d+ file\(s\)\)$/, '');
  const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'manifest.json'), 'utf8'));
  return { destination, manifest };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('create-live-restore-point', () => {
  it('snapshots migrated profile 1 state and keeps its existing restore history', async () => {
    const appDataBase = makeAppDataBase();
    const globalConfigDir = getConfigDir('', appDataBase);
    const profileConfigDir = getProfileConfigDir('1', appDataBase);
    write(globalConfigDir, 'sessions.yaml', 'sessions: [legacy]\n');
    write(globalConfigDir, 'artifacts.yaml', 'artifacts: [legacy]\n');
    write(globalConfigDir, 'restore-points/previous/manifest.json', '{"files":["older"]}\n');

    await migrateProfileConfig({ globalConfigDir, profileConfigDir });

    const { destination, manifest } = runRestorePoint(appDataBase);

    expect(manifest).toEqual({
      createdAt: expect.any(String),
      source: profileConfigDir,
      files: ['sessions.yaml', 'artifacts.yaml'],
    });
    expect(destination.startsWith(path.join(globalConfigDir, 'restore-points'))).toBe(true);
    expect(fs.readFileSync(path.join(globalConfigDir, 'restore-points', 'previous', 'manifest.json'), 'utf8'))
      .toBe('{"files":["older"]}\n');
    expect(fs.existsSync(path.join(profileConfigDir, 'restore-points'))).toBe(false);
  });

  it('keeps snapshot source and history in the legacy root until migration completes', () => {
    const appDataBase = makeAppDataBase();
    const globalConfigDir = getConfigDir('', appDataBase);
    const profileConfigDir = getProfileConfigDir('1', appDataBase);
    write(globalConfigDir, 'sessions.yaml', 'sessions: [legacy]\n');
    write(globalConfigDir, 'artifacts.yaml', 'artifacts: [legacy]\n');

    const { destination, manifest } = runRestorePoint(appDataBase);

    expect(manifest.source).toBe(globalConfigDir);
    expect(manifest.files).toEqual(['sessions.yaml', 'artifacts.yaml']);
    expect(destination.startsWith(path.join(globalConfigDir, 'restore-points'))).toBe(true);
    expect(fs.existsSync(path.join(profileConfigDir, 'restore-points'))).toBe(false);
  });

  it('does not snapshot a partially migrated config tree', () => {
    const appDataBase = makeAppDataBase();
    const globalConfigDir = getConfigDir('', appDataBase);
    write(globalConfigDir, 'user-profile-migration.yaml', [
      'version: 1',
      'status: in-progress',
      'startedAt: 1',
      'updatedAt: 2',
      '',
    ].join('\n'));

    expect(() => runRestorePoint(appDataBase)).toThrow(/migration is in progress/i);
    expect(fs.existsSync(path.join(globalConfigDir, 'restore-points'))).toBe(false);
  });
});
