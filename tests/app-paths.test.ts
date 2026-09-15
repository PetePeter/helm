/**
 * App paths unit tests — packaged vs dev path resolution.
 *
 * When the app is installed (packaged inside app.asar), writable paths
 * (logs, config) must point to <appData>/Helm/ instead of relative paths
 * inside the read-only install directory — where <appData> is the
 * platform-appropriate base (see defaultAppDataBase).
 *
 * These tests must pass on Windows, macOS and Linux alike, so they either pass
 * an explicit base or inject the platform, never relying on the host's OS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// Import the module under test
import { isPackaged, getLogDir, getConfigDir, getSessionDataDir, getTempDir, getRendererHtmlPath, getAppRootDir, seedConfigIfNeeded, getUserDataDir, defaultAppDataBase } from '../src/utils/app-paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_DIRNAME = 'X:\\coding\\gamepad-cli-hub\\dist-electron';
const PACKAGED_DIRNAME = 'C:\\Program Files\\gamepad-cli-hub\\resources\\app.asar\\dist-electron';
const FAKE_APPDATA = path.join(process.cwd(), '.test-appdata-' + Date.now());

afterEach(() => {
  // Clean up temp dirs
  if (fs.existsSync(FAKE_APPDATA)) {
    fs.rmSync(FAKE_APPDATA, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// isPackaged
// ---------------------------------------------------------------------------

describe('isPackaged', () => {
  it('returns true when dirname contains app.asar', () => {
    expect(isPackaged(PACKAGED_DIRNAME)).toBe(true);
  });

  it('returns false for normal dev paths', () => {
    expect(isPackaged(DEV_DIRNAME)).toBe(false);
  });

  it('returns true for unix-style asar paths', () => {
    expect(isPackaged('/opt/app/resources/app.asar/dist')).toBe(true);
  });

  it('returns false for paths that mention asar elsewhere', () => {
    // e.g. a folder literally named "app.asar-backup" shouldn't trigger
    // This is a boundary case — app.asar as a substring is sufficient
    // because Electron always uses exactly "app.asar" as the archive name
    expect(isPackaged('C:\\dev\\app.asar\\main')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getLogDir
// ---------------------------------------------------------------------------

describe('getLogDir', () => {
  it('returns APPDATA-based path in dev mode', () => {
    const result = getLogDir(DEV_DIRNAME, FAKE_APPDATA);
    expect(result).toBe(path.join(FAKE_APPDATA, 'Helm', 'logs'));
  });

  it('returns APPDATA-based path when packaged', () => {
    const result = getLogDir(PACKAGED_DIRNAME, FAKE_APPDATA);
    expect(result).toBe(path.join(FAKE_APPDATA, 'Helm', 'logs'));
  });

  it('derives the base from the platform default when appData is omitted', () => {
    // Host-independent: whatever this machine is, the no-arg form must agree
    // with defaultAppDataBase() rather than with any one OS's convention.
    for (const dirname of [DEV_DIRNAME, PACKAGED_DIRNAME]) {
      expect(getLogDir(dirname)).toBe(path.join(defaultAppDataBase(), 'Helm', 'logs'));
    }
  });
});

// ---------------------------------------------------------------------------
// getConfigDir
// ---------------------------------------------------------------------------

describe('getConfigDir', () => {
  it('returns APPDATA-based path in dev mode', () => {
    const result = getConfigDir(DEV_DIRNAME, FAKE_APPDATA);
    expect(result).toBe(path.join(FAKE_APPDATA, 'Helm', 'config'));
  });

  it('returns APPDATA-based path when packaged', () => {
    const result = getConfigDir(PACKAGED_DIRNAME, FAKE_APPDATA);
    expect(result).toBe(path.join(FAKE_APPDATA, 'Helm', 'config'));
  });

  it('derives the base from the platform default when appData is omitted', () => {
    for (const dirname of [DEV_DIRNAME, PACKAGED_DIRNAME]) {
      expect(getConfigDir(dirname)).toBe(path.join(defaultAppDataBase(), 'Helm', 'config'));
    }
  });
});

// ---------------------------------------------------------------------------
// getUserDataDir / getSessionDataDir
// ---------------------------------------------------------------------------

describe('runtime data dirs', () => {
  it('roots Electron userData at APPDATA/Helm', () => {
    expect(getUserDataDir(FAKE_APPDATA)).toBe(path.join(FAKE_APPDATA, 'Helm'));
  });

  it('roots Electron sessionData at APPDATA/Helm/session-data', () => {
    expect(getSessionDataDir(PACKAGED_DIRNAME, FAKE_APPDATA)).toBe(
      path.join(FAKE_APPDATA, 'Helm', 'session-data')
    );
  });
});

// ---------------------------------------------------------------------------
// getTempDir
// ---------------------------------------------------------------------------

describe('getTempDir', () => {
  it('returns APPDATA-based path in dev mode', () => {
    const result = getTempDir(DEV_DIRNAME, FAKE_APPDATA);
    expect(result).toBe(path.join(FAKE_APPDATA, 'Helm', 'tmp'));
  });

  it('returns APPDATA-based path when packaged', () => {
    const result = getTempDir(PACKAGED_DIRNAME, FAKE_APPDATA);
    expect(result).toBe(path.join(FAKE_APPDATA, 'Helm', 'tmp'));
  });

  it('derives the base from the platform default when appData is omitted', () => {
    expect(getTempDir(DEV_DIRNAME)).toBe(path.join(defaultAppDataBase(), 'Helm', 'tmp'));
  });
});

// ---------------------------------------------------------------------------
// defaultAppDataBase — the per-platform base, asserted on every platform.
//
// This must mirror Electron's app.getPath('appData'). Previously the macOS and
// Linux branches had no coverage at all: the suite steered resolution by
// setting process.env.APPDATA, which is only consulted on win32, so those
// tests asserted Windows layout and failed on any other host.
// ---------------------------------------------------------------------------

describe('defaultAppDataBase', () => {
  const HOME = path.join('/home', 'someone');

  it('uses %APPDATA% on Windows', () => {
    expect(defaultAppDataBase('win32', { APPDATA: 'D:\\Roaming', USERPROFILE: HOME }))
      .toBe('D:\\Roaming');
  });

  it('falls back to <profile>/AppData/Roaming on Windows without APPDATA', () => {
    expect(defaultAppDataBase('win32', { USERPROFILE: HOME }))
      .toBe(path.join(HOME, 'AppData', 'Roaming'));
  });

  it('uses ~/Library/Application Support on macOS', () => {
    expect(defaultAppDataBase('darwin', { HOME }))
      .toBe(path.join(HOME, 'Library', 'Application Support'));
  });

  it('ignores APPDATA on macOS', () => {
    // APPDATA is a Windows-only convention; honouring it elsewhere would put
    // real user data in the wrong place.
    expect(defaultAppDataBase('darwin', { HOME, APPDATA: 'D:\\Roaming' }))
      .toBe(path.join(HOME, 'Library', 'Application Support'));
  });

  it('prefers $XDG_CONFIG_HOME on Linux', () => {
    expect(defaultAppDataBase('linux', { HOME, XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg');
  });

  it('falls back to ~/.config on Linux', () => {
    expect(defaultAppDataBase('linux', { HOME })).toBe(path.join(HOME, '.config'));
  });

  it('falls back to the current directory when the home dir is unknown', () => {
    expect(defaultAppDataBase('darwin', {})).toBe(path.join('.', 'Library', 'Application Support'));
    expect(defaultAppDataBase('linux', {})).toBe(path.join('.', '.config'));
  });

  it('roots the user data dir at <platform base>/Helm', () => {
    expect(getUserDataDir()).toBe(path.join(defaultAppDataBase(), 'Helm'));
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting guards: writable paths must always live under appData/Helm
// and must never leak the repo cwd. Catches regressions where someone
// re-introduces dev/cwd branching in the path resolvers.
// ---------------------------------------------------------------------------

describe('writable path guards', () => {
  it('never returns a cwd/repo-rooted path in any mode', () => {
    // The old dev-mode paths were repo-relative; they must never come back
    expect(getConfigDir(DEV_DIRNAME, FAKE_APPDATA)).not.toBe(path.join(process.cwd(), 'config'));
    expect(getConfigDir(PACKAGED_DIRNAME, FAKE_APPDATA)).not.toBe(path.join(process.cwd(), 'config'));
    expect(getLogDir(DEV_DIRNAME, FAKE_APPDATA)).not.toBe(path.join(process.cwd(), 'logs'));
    expect(getLogDir(PACKAGED_DIRNAME, FAKE_APPDATA)).not.toBe(path.join(process.cwd(), 'logs'));
    expect(getTempDir(DEV_DIRNAME, FAKE_APPDATA)).not.toBe(path.join(process.cwd(), 'tmp'));
    expect(getTempDir(PACKAGED_DIRNAME, FAKE_APPDATA)).not.toBe(path.join(process.cwd(), 'tmp'));
  });

  it('roots all writable paths at appData/Helm', () => {
    const expectedPrefix = path.join(FAKE_APPDATA, 'Helm');
    for (const fn of [getConfigDir, getLogDir, getSessionDataDir, getTempDir]) {
      for (const dirname of [DEV_DIRNAME, PACKAGED_DIRNAME]) {
        const result = fn(dirname, FAKE_APPDATA);
        expect(result.startsWith(expectedPrefix)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// seedConfigIfNeeded — copies default config on first packaged launch
// ---------------------------------------------------------------------------

describe('seedConfigIfNeeded', () => {
  const sourceConfigDir = path.join(FAKE_APPDATA, 'source-config');
  const targetConfigDir = path.join(FAKE_APPDATA, 'Helm', 'config');

  beforeEach(() => {
    // Create a fake source config directory (simulating app.asar/config/)
    fs.mkdirSync(path.join(sourceConfigDir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceConfigDir, 'settings.yaml'),
      'activeProfile: default\n'
    );
    fs.writeFileSync(
      path.join(sourceConfigDir, 'profiles', 'default.yaml'),
      'tools:\n  claude-code:\n    name: Claude Code\n'
    );
  });

  it('copies config files when target dir does not exist', () => {
    seedConfigIfNeeded(sourceConfigDir, targetConfigDir);

    expect(fs.existsSync(path.join(targetConfigDir, 'settings.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(targetConfigDir, 'profiles', 'default.yaml'))).toBe(true);

    const settings = fs.readFileSync(path.join(targetConfigDir, 'settings.yaml'), 'utf8');
    expect(settings).toContain('activeProfile: default');

    const profile = fs.readFileSync(path.join(targetConfigDir, 'profiles', 'default.yaml'), 'utf8');
    expect(profile).toContain('Claude Code');
  });

  it('does not overwrite existing config', () => {
    // Pre-create target with custom content
    fs.mkdirSync(targetConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetConfigDir, 'settings.yaml'),
      'activeProfile: custom\n'
    );

    seedConfigIfNeeded(sourceConfigDir, targetConfigDir);

    // Original content should be preserved
    const settings = fs.readFileSync(path.join(targetConfigDir, 'settings.yaml'), 'utf8');
    expect(settings).toContain('activeProfile: custom');
  });

  it('is a no-op when source dir does not exist', () => {
    const bogusSource = path.join(FAKE_APPDATA, 'nonexistent');
    // Should not throw
    seedConfigIfNeeded(bogusSource, targetConfigDir);
    expect(fs.existsSync(targetConfigDir)).toBe(false);
  });

  it('creates parent directories as needed', () => {
    const deepTarget = path.join(FAKE_APPDATA, 'deep', 'nested', 'config');
    seedConfigIfNeeded(sourceConfigDir, deepTarget);
    expect(fs.existsSync(path.join(deepTarget, 'settings.yaml'))).toBe(true);
  });

  // The guard is per file, not per directory: a default shipped after the user's
  // config dir already exists must still land, without touching their files.
  it('adds a newly shipped default into an existing config dir', () => {
    fs.mkdirSync(targetConfigDir, { recursive: true });
    fs.writeFileSync(path.join(targetConfigDir, 'settings.yaml'), 'activeProfile: custom\n');
    fs.writeFileSync(path.join(sourceConfigDir, 'cli-types.yaml'), 'shipped: true\n');

    seedConfigIfNeeded(sourceConfigDir, targetConfigDir);

    expect(fs.readFileSync(path.join(targetConfigDir, 'cli-types.yaml'), 'utf8')).toContain('shipped: true');
    expect(fs.readFileSync(path.join(targetConfigDir, 'settings.yaml'), 'utf8')).toBe('activeProfile: custom\n');
  });

  it('leaves existing files byte-identical inside nested directories', () => {
    const targetProfiles = path.join(targetConfigDir, 'profiles');
    fs.mkdirSync(targetProfiles, { recursive: true });
    fs.writeFileSync(path.join(targetProfiles, 'default.yaml'), 'tools:\n  mine:\n    name: Mine\n');

    seedConfigIfNeeded(sourceConfigDir, targetConfigDir);

    expect(fs.readFileSync(path.join(targetProfiles, 'default.yaml'), 'utf8')).toBe('tools:\n  mine:\n    name: Mine\n');
    // Missing sibling still seeded, so recursion is not short-circuited by the skip.
    expect(fs.existsSync(path.join(targetConfigDir, 'settings.yaml'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getRendererHtmlPath — resolves renderer/index.html relative to __dirname
// ---------------------------------------------------------------------------

describe('getRendererHtmlPath', () => {
  it('returns __dirname-relative path in dev mode', () => {
    // dist-electron/main.js → ../dist/renderer/index.html
    const result = getRendererHtmlPath(DEV_DIRNAME);
    const expected = path.join(DEV_DIRNAME, '..', 'dist', 'renderer', 'index.html');
    expect(result).toBe(expected);
  });

  it('returns asar-relative path when packaged', () => {
    // resources/app.asar/dist-electron/main.js → ../dist/renderer/index.html
    const result = getRendererHtmlPath(PACKAGED_DIRNAME);
    const expected = path.join(PACKAGED_DIRNAME, '..', 'dist', 'renderer', 'index.html');
    expect(result).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// getAppRootDir — resolves project root relative to __dirname
// ---------------------------------------------------------------------------

describe('getAppRootDir', () => {
  it('returns one level up from dist-electron in dev mode', () => {
    const result = getAppRootDir(DEV_DIRNAME);
    expect(result).toBe(path.resolve(DEV_DIRNAME, '..'));
  });

  it('returns one level up from dist-electron when packaged', () => {
    const result = getAppRootDir(PACKAGED_DIRNAME);
    expect(result).toBe(path.resolve(PACKAGED_DIRNAME, '..'));
  });
});
