import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfigDir, getProfileConfigDir } from '../src/utils/app-paths.js';
import { seedConfigIfNeeded } from '../src/utils/app-paths.js';
import { getGlobalPersistencePaths, getProfilePersistencePaths } from '../src/session/persistence-paths.js';
import { ConfigLoader } from '../src/config/loader.js';
import { migrateProfileConfig } from '../src/config/profile-config-migration.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';

const require = createRequire(import.meta.url);
const lockfile = require('proper-lockfile') as {
  lock(filePath: string, options?: { retries?: number }): Promise<() => Promise<void>>;
};

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'helm-profile-config-'));
  roots.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string | Buffer): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('profile config paths', () => {
  it('resolves isolated profile directories and rejects unsafe identifiers', () => {
    const appData = makeRoot();
    const first = getProfileConfigDir('1', appData);
    const second = getProfileConfigDir('child-2', appData);

    expect(first).toBe(path.join(appData, 'Helm', 'profiles', '1', 'config'));
    expect(second).not.toBe(first);
    expect(() => getProfileConfigDir('', appData)).toThrow(/profile id/i);
    expect(() => getProfileConfigDir('../escape', appData)).toThrow(/profile id/i);

    const firstPaths = getProfilePersistencePaths(first);
    const secondPaths = getProfilePersistencePaths(second);
    const globalPaths = getGlobalPersistencePaths(getConfigDir('', appData));
    expect(firstPaths.sessionsFile).not.toBe(secondPaths.sessionsFile);
    expect(globalPaths.peersFile).toBe(path.join(getConfigDir('', appData), 'peers.yaml'));
    expect(Object.values(firstPaths)).not.toContain(globalPaths.peersFile);
  });

  it('preserves every global path basename and moves every profile path basename', async () => {
    const appData = makeRoot();
    const globalDir = getConfigDir('', appData);
    const profileDir = getProfileConfigDir('1', appData);
    const globalPaths = getGlobalPersistencePaths(globalDir);
    const profilePaths = getProfilePersistencePaths(profileDir);
    const globalBasenames = Object.values(globalPaths).map(filePath => path.basename(filePath));
    const profileBasenames = Object.values(profilePaths).map(filePath => path.basename(filePath));

    expect(new Set(globalBasenames).size).toBe(globalBasenames.length);
    expect(new Set(profileBasenames).size).toBe(profileBasenames.length);
    expect(profileBasenames.some(name => globalBasenames.includes(name))).toBe(false);

    expect(globalBasenames).toEqual(expect.arrayContaining([
      'settings.yaml',
      'input-config.yaml',
      'bindings.yaml',
      'mobile-audit.yaml',
    ]));

    for (const [key, filePath] of Object.entries(globalPaths)) {
      const name = path.basename(filePath);
      if (name === 'user-profile-migration.yaml') continue;
      if (key.endsWith('Dir')) {
        fs.mkdirSync(path.join(globalDir, name), { recursive: true });
      } else if (name === 'user-profiles.yaml') {
        write(globalDir, name, YAML.stringify({ version: 1, profiles: [] }));
      } else if (name === 'mobile-devices.yaml') {
        write(globalDir, name, YAML.stringify({ devices: [] }));
      } else {
        write(globalDir, name, `${name}\n`);
      }
    }

    for (const [key, filePath] of Object.entries(profilePaths)) {
      const name = path.basename(filePath);
      if (key.endsWith('Dir')) fs.mkdirSync(path.join(globalDir, name), { recursive: true });
      else write(globalDir, name, `${name}\n`);
    }

    // These stale names have no global reader, so migration's default is profile 1.
    write(globalDir, 'telegram-topics.yaml', 'legacy telegram topics\n');
    write(globalDir, 'telefony/legacy.txt', 'legacy telefony data\n');

    await migrateProfileConfig({ globalConfigDir: globalDir, profileConfigDir: profileDir });

    for (const filePath of Object.values(globalPaths)) {
      const name = path.basename(filePath);
      expect(fs.existsSync(path.join(globalDir, name)), `${name} should remain global`).toBe(true);
      expect(fs.existsSync(path.join(profileDir, name)), `${name} should not move`).toBe(false);
    }
    for (const name of profileBasenames) {
      expect(fs.existsSync(path.join(profileDir, name)), `${name} should move to profile 1`).toBe(true);
      expect(fs.existsSync(path.join(globalDir, name)), `${name} should leave the global root`).toBe(false);
    }
    for (const name of ['telegram-topics.yaml', 'telefony']) {
      expect(fs.existsSync(path.join(profileDir, name))).toBe(true);
      expect(fs.existsSync(path.join(globalDir, name))).toBe(false);
    }
  });
});

describe('profile and global default seeding', () => {
  it('seeds shipped profile files separately from machine-shared config', () => {
    const appData = makeRoot();
    const source = path.join(appData, 'defaults');
    const globalDir = getConfigDir('', appData);
    const profileDir = getProfileConfigDir('1', appData);
    write(source, 'settings.yaml', 'settings: true\n');
    write(source, 'cli-types.yaml', 'cli: true\n');
    write(source, 'hooks/helm-hook-shim.py', 'print("shared")\n');

    seedConfigIfNeeded(source, globalDir, { exclude: ['cli-types.yaml'] });
    seedConfigIfNeeded(source, profileDir, { include: ['cli-types.yaml'] });

    expect(fs.existsSync(path.join(globalDir, 'settings.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'cli-types.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(globalDir, 'hooks', 'helm-hook-shim.py'))).toBe(true);
    expect(fs.existsSync(path.join(profileDir, 'cli-types.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(profileDir, 'settings.yaml'))).toBe(false);
  });
});

describe('ConfigLoader profile ownership', () => {
  it('loads CLI types from the profile and shared input, bindings, and settings globally', () => {
    const appData = makeRoot();
    const globalDir = getConfigDir('', appData);
    const profileDir = getProfileConfigDir('1', appData);
    write(globalDir, 'settings.yaml', YAML.stringify({ mcp: { enabled: true, port: 1234, authToken: 'global' } }));
    write(globalDir, 'input-config.yaml', YAML.stringify({ activity: { timeoutMs: 1234 } }));
    write(globalDir, 'bindings.yaml', YAML.stringify({
      profiles: { shared: { name: 'Shared', bindings: { A: { action: 'keyboard', sequence: '{Ctrl+A}' } } } },
    }));
    write(profileDir, 'cli-types.yaml', YAML.stringify({
      'profile-cli': { name: 'Profile CLI', displayName: 'Profile CLI', bindingProfileId: 'shared' },
    }));
    write(profileDir, 'settings.yaml', YAML.stringify({ mcp: { enabled: false } }));
    write(profileDir, 'input-config.yaml', YAML.stringify({ activity: { timeoutMs: 99 } }));
    write(profileDir, 'bindings.yaml', YAML.stringify({ profiles: {} }));

    const loader = new ConfigLoader({ profileConfigDir: profileDir, globalConfigDir: globalDir });
    loader.load();

    const cliTypeId = loader.getCliTypes()[0];
    expect(loader.getCliTypeLabel(cliTypeId)).toBe('Profile CLI');
    expect(loader.getMcpConfig()).toMatchObject({ enabled: true, port: 1234, authToken: 'global' });
    expect(loader.getActivityTimeout()).toBe(1234);
    expect(loader.getBindings(cliTypeId)).toMatchObject({ A: { action: 'keyboard', sequence: '{Ctrl+A}' } });
    expect(loader.getSkillsPath()).toBe(path.join(profileDir, 'skills.yaml'));
  });
});

describe('UserProfileStore', () => {
  it('creates and reloads the profile 1 registry without accepting raw PIN fields', () => {
    const appData = makeRoot();
    const store = new UserProfileStore(getConfigDir('', appData));

    store.ensureDefaultProfile();
    expect(new UserProfileStore(getConfigDir('', appData)).list()).toEqual([
      { id: '1', name: 'me', pinHash: null },
    ]);

    fs.writeFileSync(store.filePath, YAML.stringify({
      version: 1,
      profiles: [{ id: '1', name: 'me', pin: '1234', pinHash: null }],
    }));
    expect(() => store.list()).toThrow(/raw PIN/i);
  });
});

describe('migrateProfileConfig', () => {
  it('classifies mixed-case global filenames according to filesystem case rules', async () => {
    const appData = makeRoot();
    const globalDir = getConfigDir('', appData);
    const profileDir = getProfileConfigDir('1', appData);
    write(globalDir, 'Settings.yaml', 'mcp:\n  enabled: true\n');
    write(globalDir, 'Bindings.yaml', 'profiles: {}\n');
    write(globalDir, 'Mobile-Devices.yaml', YAML.stringify({ devices: [{ id: 'phone-1', label: 'phone' }] }));

    await migrateProfileConfig({ globalConfigDir: globalDir, profileConfigDir: profileDir });

    const expectedRoot = process.platform === 'win32' ? globalDir : profileDir;
    const otherRoot = process.platform === 'win32' ? profileDir : globalDir;
    for (const name of ['Settings.yaml', 'Bindings.yaml', 'Mobile-Devices.yaml']) {
      expect(fs.existsSync(path.join(expectedRoot, name))).toBe(true);
      expect(fs.existsSync(path.join(otherRoot, name))).toBe(false);
    }
  });

  it('rejects case-colliding global entries before moving data', async ({ skip }) => {
    const appData = makeRoot();
    const globalDir = getConfigDir('', appData);
    const profileDir = getProfileConfigDir('1', appData);
    write(globalDir, 'settings.yaml', 'canonical: true\n');
    try {
      fs.writeFileSync(path.join(globalDir, 'Settings.yaml'), 'alias: true\n', { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return skip();
      throw error;
    }
    write(globalDir, 'sessions.yaml', 'sessions: []\n');

    await expect(migrateProfileConfig({ globalConfigDir: globalDir, profileConfigDir: profileDir }))
      .rejects.toThrow(/case-colliding/i);

    expect(fs.readFileSync(path.join(globalDir, 'sessions.yaml'), 'utf8')).toBe('sessions: []\n');
    expect(fs.existsSync(path.join(profileDir, 'sessions.yaml'))).toBe(false);
  });

  it('moves profile data, rewrites stored config-root paths, preserves global files, and resumes idempotently', async () => {
    const appData = makeRoot();
    const globalDir = getConfigDir('', appData);
    const profileDir = getProfileConfigDir('1', appData);
    const oldPath = path.join(globalDir, 'plans', 'incoming');
    const newPath = path.join(profileDir, 'plans', 'incoming');
    fs.mkdirSync(globalDir, { recursive: true });

    write(globalDir, 'projects.json', JSON.stringify({
      projects: [
        { id: 'p1', name: 'Helm data', canonicalPath: oldPath },
        { id: 'p2', name: 'Code', canonicalPath: '/workspace/code' },
        { id: 'p3', name: 'Operator', canonicalPath: path.join(globalDir, 'operator') },
      ],
    }));
    write(globalDir, 'sessions.yaml', YAML.stringify({ sessions: [{ id: 's1', cliTranscriptPath: path.join(globalDir, 'api-sessions', 's1.jsonl') }] }));
    write(globalDir, 'artifacts.yaml', YAML.stringify({ artifacts: { s1: [{ content: `See ${oldPath}` }] } }));
    write(globalDir, 'scheduled-tasks.yaml', YAML.stringify({ tasks: [{ workingDirectory: oldPath }] }));
    write(globalDir, 'plan-attachments/p1/readme.md', `Open ${oldPath}\n`);
    write(globalDir, 'memory-attachments/m1/note.md', `Stored at ${oldPath}\n`);
    write(globalDir, 'artifact-attachments/a1/record.md', `Stored at ${oldPath}\n`);
    write(globalDir, 'plan-attachments/p1/image.png', Buffer.from([0, 255, 1, 2]));
    write(globalDir, 'memory-attachments/m1/payload.png', Buffer.from(oldPath, 'utf8'));
    write(globalDir, 'peers.yaml', 'peers: []\n');
    write(globalDir, 'machine-identity.yaml', 'id: machine\n');
    write(globalDir, 'self-signed-cert.yaml', 'cert: local\n');
    write(globalDir, 'peer-pins.yaml', 'pins: []\n');
    write(globalDir, 'peer-secrets.yaml', 'secrets: []\n');
    write(globalDir, 'peer-audit.yaml', 'events: []\n');
    write(globalDir, 'mobile-secrets.yaml', 'secrets: []\n');
    write(globalDir, 'mobile-chat-journal.json', '{"entries":[]}\n');
    write(globalDir, 'mobile-devices.yaml', YAML.stringify({ devices: [{ id: 'phone-1', label: 'phone' }] }));
    write(globalDir, 'settings.yaml', YAML.stringify({
      enabled: true,
      sessionGroups: {
        bookmarked: [oldPath, path.join(globalDir, 'operator'), path.join(globalDir, 'hooks')],
      },
    }));
    write(globalDir, 'input-config.yaml', 'sticks: {}\n');
    write(globalDir, 'bindings.yaml', 'profiles: {}\n');
    write(globalDir, 'hooks/helm-hook-shim.py', 'print("global")\n');
    write(globalDir, 'operator/sessions.yaml', 'sessions: []\n');

    await migrateProfileConfig({ globalConfigDir: globalDir, profileConfigDir: profileDir });

    expect(JSON.parse(fs.readFileSync(path.join(profileDir, 'projects.json'), 'utf8')).projects[0].canonicalPath).toBe(newPath);
    expect(JSON.parse(fs.readFileSync(path.join(profileDir, 'projects.json'), 'utf8')).projects[1].canonicalPath).toBe('/workspace/code');
    expect(JSON.parse(fs.readFileSync(path.join(profileDir, 'projects.json'), 'utf8')).projects[2].canonicalPath).toBe(path.join(globalDir, 'operator'));
    expect(fs.readFileSync(path.join(profileDir, 'sessions.yaml'), 'utf8')).toContain(path.join(profileDir, 'api-sessions', 's1.jsonl'));
    expect(fs.readFileSync(path.join(profileDir, 'artifacts.yaml'), 'utf8')).toContain(newPath);
    expect(fs.readFileSync(path.join(profileDir, 'scheduled-tasks.yaml'), 'utf8')).toContain(newPath);
    expect(fs.readFileSync(path.join(profileDir, 'plan-attachments/p1/readme.md'), 'utf8')).toBe(`Open ${newPath}\n`);
    expect(fs.readFileSync(path.join(profileDir, 'memory-attachments/m1/note.md'), 'utf8')).toBe(`Stored at ${newPath}\n`);
    expect(fs.readFileSync(path.join(profileDir, 'artifact-attachments/a1/record.md'), 'utf8')).toBe(`Stored at ${newPath}\n`);
    expect(YAML.parse(fs.readFileSync(path.join(globalDir, 'settings.yaml'), 'utf8')).sessionGroups.bookmarked)
      .toEqual([newPath, path.join(globalDir, 'operator'), path.join(globalDir, 'hooks')]);
    for (const relativePath of [
      'projects.json', 'sessions.yaml', 'artifacts.yaml', 'scheduled-tasks.yaml',
      'plan-attachments/p1/readme.md', 'memory-attachments/m1/note.md', 'artifact-attachments/a1/record.md',
    ]) {
      expect(fs.readFileSync(path.join(profileDir, relativePath), 'utf8')).not.toContain(oldPath);
    }
    expect(fs.readFileSync(path.join(profileDir, 'sessions.yaml'), 'utf8')).not.toContain(path.join(globalDir, 'api-sessions'));
    expect(fs.readFileSync(path.join(profileDir, 'plan-attachments/p1/image.png'))).toEqual(Buffer.from([0, 255, 1, 2]));
    expect(fs.readFileSync(path.join(profileDir, 'memory-attachments/m1/payload.png'))).toEqual(Buffer.from(oldPath, 'utf8'));
    expect(fs.readFileSync(path.join(globalDir, 'peers.yaml'), 'utf8')).toBe('peers: []\n');
    expect(fs.existsSync(path.join(globalDir, 'peer-pins.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'machine-identity.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'self-signed-cert.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'peer-secrets.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'peer-audit.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'mobile-secrets.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'mobile-chat-journal.json'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'settings.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'input-config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'bindings.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'hooks', 'helm-hook-shim.py'))).toBe(true);
    expect(fs.existsSync(path.join(globalDir, 'operator', 'sessions.yaml'))).toBe(true);
    expect(YAML.parse(fs.readFileSync(path.join(globalDir, 'mobile-devices.yaml'), 'utf8'))).toEqual({
      devices: [{ id: 'phone-1', label: 'phone', userProfileId: '1' }],
    });
    expect(new UserProfileStore(globalDir).list()).toEqual([{ id: '1', name: 'me', pinHash: null }]);

    const beforeRetry = fs.readFileSync(path.join(profileDir, 'projects.json'), 'utf8');
    await migrateProfileConfig({ globalConfigDir: globalDir, profileConfigDir: profileDir });
    expect(fs.readFileSync(path.join(profileDir, 'projects.json'), 'utf8')).toBe(beforeRetry);
    expect(YAML.parse(fs.readFileSync(path.join(globalDir, 'user-profile-migration.yaml'), 'utf8')).status).toBe('complete');
  });

  it('leaves an existing complete journal untouched when another instance holds the migration lock', async () => {
    const appData = makeRoot();
    const globalDir = getConfigDir('', appData);
    const profileDir = getProfileConfigDir('1', appData);
    fs.mkdirSync(globalDir, { recursive: true });
    write(globalDir, 'sessions.yaml', 'sessions: []\n');
    const journal = YAML.stringify({ version: 1, status: 'complete', startedAt: 1, updatedAt: 2 });
    write(globalDir, 'user-profile-migration.yaml', journal);
    const release = await lockfile.lock(globalDir, { retries: 0 });

    try {
      await expect(migrateProfileConfig({ globalConfigDir: globalDir, profileConfigDir: profileDir })).rejects.toThrow(/lock/i);
      expect(fs.readFileSync(path.join(globalDir, 'user-profile-migration.yaml'), 'utf8')).toBe(journal);
      expect(fs.readFileSync(path.join(globalDir, 'sessions.yaml'), 'utf8')).toBe('sessions: []\n');
      expect(fs.existsSync(path.join(profileDir, 'sessions.yaml'))).toBe(false);
    } finally {
      await release();
    }
  });

  it('resumes a journaled migration after some entries were already moved', async () => {
    const appData = makeRoot();
    const globalDir = getConfigDir('', appData);
    const profileDir = getProfileConfigDir('1', appData);
    const oldPath = path.join(globalDir, 'plans');
    const newPath = path.join(profileDir, 'plans');
    write(globalDir, 'user-profile-migration.yaml', YAML.stringify({ version: 1, status: 'in-progress', startedAt: 1, updatedAt: 1 }));
    write(globalDir, 'sessions.yaml', YAML.stringify({ sessions: [] }));
    write(profileDir, 'projects.json', JSON.stringify({ projects: [{ id: 'p1', name: 'p', canonicalPath: oldPath }] }));

    await migrateProfileConfig({ globalConfigDir: globalDir, profileConfigDir: profileDir });

    expect(JSON.parse(fs.readFileSync(path.join(profileDir, 'projects.json'), 'utf8')).projects[0].canonicalPath).toBe(newPath);
    expect(fs.existsSync(path.join(profileDir, 'sessions.yaml'))).toBe(true);
    expect(YAML.parse(fs.readFileSync(path.join(globalDir, 'user-profile-migration.yaml'), 'utf8')).status).toBe('complete');
  });

  it('rejects a source/target collision without overwriting either file', async () => {
    const appData = makeRoot();
    const globalDir = getConfigDir('', appData);
    const profileDir = getProfileConfigDir('1', appData);
    write(globalDir, 'sessions.yaml', 'source: old\n');
    write(profileDir, 'sessions.yaml', 'target: existing\n');

    await expect(migrateProfileConfig({ globalConfigDir: globalDir, profileConfigDir: profileDir })).rejects.toThrow(/collision/i);
    expect(fs.readFileSync(path.join(globalDir, 'sessions.yaml'), 'utf8')).toBe('source: old\n');
    expect(fs.readFileSync(path.join(profileDir, 'sessions.yaml'), 'utf8')).toBe('target: existing\n');
    expect(YAML.parse(fs.readFileSync(path.join(globalDir, 'user-profile-migration.yaml'), 'utf8')).status).toBe('in-progress');
  });
});
