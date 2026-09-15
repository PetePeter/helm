/**
 * App Paths — resolve writable directories for logs and config.
 *
 * When packaged inside an Electron app.asar archive, relative paths
 * point into the read-only install directory (e.g. C:\Program Files\).
 * This module detects packaging and redirects to the per-user app-data dir.
 *
 * The base dir mirrors Electron's own `app.getPath('appData')`:
 *   - Windows: %APPDATA%              (…/AppData/Roaming)
 *   - macOS:   ~/Library/Application Support
 *   - Linux:   $XDG_CONFIG_HOME or ~/.config
 * so that no-arg callers resolve to the same place Electron uses for the
 * app's userData/sessionData, instead of a bare $HOME/Helm fallback.
 *
 * Note: fs.copyFileSync is NOT patched by Electron for asar reads.
 * We use readFileSync + writeFileSync instead, which ARE patched.
 */

import * as path from 'path';
import * as fs from 'fs';

export const APP_NAME = 'Helm';

/**
 * Detect whether the app is running from a packaged Electron asar archive.
 */
export function isPackaged(dirname: string): boolean {
  return dirname.includes('app.asar');
}

/**
 * Platform-appropriate per-user app-data base, matching Electron's
 * `app.getPath('appData')`. Used when no explicit base is supplied.
 *
 * `platform`/`env` are injectable so tests can assert all three platforms
 * deterministically on any host. Steering this through the real environment
 * only works on Windows (APPDATA is read on win32 alone), which previously
 * left the macOS and Linux branches untested.
 */
export function defaultAppDataBase(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME || env.USERPROFILE || '.';
  switch (platform) {
    case 'win32':
      return env.APPDATA || path.join(home, 'AppData', 'Roaming');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support');
    default:
      // Linux and other Unix-likes.
      return env.XDG_CONFIG_HOME || path.join(home, '.config');
  }
}

/**
 * Resolve the user-data base directory: <appData>/Helm.
 * `appData` overrides the platform default (used by Electron identity + tests).
 */
export function getUserDataDir(appData?: string): string {
  const base = appData || defaultAppDataBase();
  return path.join(base, APP_NAME);
}

/**
 * One-time relocation of data written by older builds that used the legacy
 * `$HOME/Helm` fallback base (pre platform-aware paths). Moves the
 * config/logs/tmp subdirs into the correct per-platform userData dir when the
 * destination subdir does not yet exist. Idempotent and non-destructive:
 * never overwrites an existing destination, and leaves session-data alone
 * (Electron already manages that at the correct location).
 *
 * Returns the list of subdirs that were migrated (empty when nothing to do).
 */
export function migrateLegacyUserDataIfNeeded(appData?: string): string[] {
  const legacyBase = process.env.HOME || process.env.USERPROFILE;
  if (!legacyBase) return [];

  const legacyDir = path.join(legacyBase, APP_NAME);
  const targetDir = getUserDataDir(appData);
  if (path.resolve(legacyDir) === path.resolve(targetDir)) return [];
  if (!fs.existsSync(legacyDir)) return [];

  const migrated: string[] = [];
  for (const sub of ['config', 'logs', 'tmp']) {
    const from = path.join(legacyDir, sub);
    const to = path.join(targetDir, sub);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(from, to);
      migrated.push(sub);
    }
  }
  return migrated;
}

/**
 * Return the writable log directory.
 * Always: <appData>/Helm/logs
 */
export function getLogDir(_dirname: string, appData?: string): string {
  return path.join(getUserDataDir(appData), 'logs');
}

/**
 * Return the writable config directory.
 * Always: <appData>/Helm/config
 */
export function getConfigDir(_dirname: string, appData?: string): string {
  return path.join(getUserDataDir(appData), 'config');
}

/**
 * Return the runtime browser/session-data directory used by Electron/Chromium.
 * Always: <appData>/Helm/session-data
 */
export function getSessionDataDir(_dirname: string, appData?: string): string {
  return path.join(getUserDataDir(appData), 'session-data');
}

/**
 * Return the path to the built renderer index.html.
 * Vite outputs to dist/renderer/; __dirname is dist-electron/.
 */
export function getRendererHtmlPath(dirname: string): string {
  return path.join(dirname, '..', 'dist', 'renderer', 'index.html');
}

/**
 * Return the app root directory (one level up from dist-electron/).
 * Works both in dev and inside asar.
 */
export function getAppRootDir(dirname: string): string {
  return path.resolve(dirname, '..');
}

/**
 * Return a writable temp directory for app-specific scratch files
 * (e.g. Ctrl+G external editor prompts).
 * Always: <appData>/Helm/tmp
 */
export function getTempDir(_dirname: string, appData?: string): string {
  return path.join(getUserDataDir(appData), 'tmp');
}

/**
 * Copy default config files from the source (inside asar) to the target
 * (user data dir), filling in whatever is missing.
 *
 * The decision is per FILE, not per directory: an existing file is never read,
 * merged or overwritten, but a newly shipped default lands on upgrade instead
 * of being locked out forever by the presence of the config dir.
 *
 * Uses readFileSync + writeFileSync instead of copyFileSync because
 * Electron does NOT patch copyFileSync for asar archive reads.
 */
export function seedConfigIfNeeded(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) return;
  copyDirRecursive(sourceDir, targetDir);
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      // readFileSync + writeFileSync: asar-safe (Electron patches both).
      // copyFileSync is NOT patched for asar reads.
      const content = fs.readFileSync(srcPath);
      fs.writeFileSync(destPath, content);
    }
  }
}
