/**
 * Update IPC Handlers
 *
 * `update:check` — fetch the latest GitHub release and report whether a newer
 * build exists. Never throws: a failed fetch answers `{ update: null }` so a
 * dead network can never look like "update available" either.
 *
 * `update:install` — download the installer into the Helm temp dir (streamed,
 * with `update:progress` pushed to every window), write the detached update
 * script, spawn it, and quit. The script waits for the app to exit, runs the
 * NSIS installer with `/S`, and relaunches Helm — see buildUpdateScript().
 *
 * `update:getMode` / `update:setMode` — the auto/manual launch-check setting.
 * The renderer decides whether to check at launch; main only persists it.
 *
 * Everything with a side effect (network, filesystem, process spawn, quit) is
 * injected through deps so the handler logic runs against fakes in tests.
 */

import { BrowserWindow, app, ipcMain, net } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger.js';
import {
  LATEST_RELEASE_API_URL,
  buildUpdateScript,
  isRepoDownloadUrl,
  parseLatestRelease,
  type UpdateInfo,
} from '../../session/update-checker.js';
import type { UpdateCheckMode } from '../../config/loader.js';

export interface UpdateCheckResult {
  /** False in dev — the renderer only auto-prompts for a packaged app. */
  packaged: boolean;
  current: string;
  update: UpdateInfo | null;
}

export type UpdateStage = 'downloading' | 'restarting' | 'failed';

export interface UpdateProgress {
  stage: UpdateStage;
  percent: number;
  receivedBytes?: number;
  totalBytes?: number;
  error?: string;
}

/** The subset of deps tests replace; production values come from Electron. */
export interface UpdateHandlerOverrides {
  /** Absolute path of the running Helm.exe — where the script relaunches. */
  execPath?: string;
  /**
   * Helm's temp dir (app-data, never the repo tree) for installer + script.
   * Deliberately required: the dir must be the one cleanupWorkTempFiles
   * sweeps, so an unset default cannot silently drift to %TEMP%.
   */
  tempDir: string;
  /** Persistence for the auto/manual launch-check setting (ConfigLoader). */
  modeStore: {
    getUpdateCheckMode(): UpdateCheckMode;
    setUpdateCheckMode(mode: UpdateCheckMode): void;
  };
  fetchFn?: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  spawnFn?: (command: string, args: string[], options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean }) => { unref(): void };
  /** Progress push; default broadcasts `update:progress` to every live window. */
  sendProgress?: (progress: UpdateProgress) => void;
  /** Ask the app to quit (runs the normal cleanup path). */
  quit?: () => void;
}

export function setupUpdateHandlers(overrides: UpdateHandlerOverrides): void {
  // A second click while an install is in flight must not re-download or,
  // worse, spawn a second quit.
  let installing = false;

  const sendProgress =
    overrides.sendProgress ??
    ((progress: UpdateProgress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:progress', progress);
      }
    });

  ipcMain.handle('update:check', async (): Promise<UpdateCheckResult> => {
    const current = app.getVersion();
    try {
      const response = await fetchRelease(LATEST_RELEASE_API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'helm-desktop' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        logger.warn(`[Update] Release check HTTP ${response.status} — reporting no update`);
        return { packaged: app.isPackaged, current, update: null };
      }
      const update = parseLatestRelease(await response.json(), current);
      if (update) logger.info(`[Update] ${update.version} available (running ${current})`);
      return { packaged: app.isPackaged, current, update };
    } catch (error) {
      // Offline / rate-limited / DNS — quiet. The check is opportunistic.
      logger.warn(`[Update] Release check failed: ${error}`);
      return { packaged: app.isPackaged, current, update: null };
    }
  });

  ipcMain.handle('update:getMode', (): UpdateCheckMode => overrides.modeStore.getUpdateCheckMode());

  ipcMain.handle('update:setMode', (_event, mode: unknown): { success: boolean; error?: string } => {
    if (mode !== 'auto' && mode !== 'manual') return { success: false, error: `Invalid update check mode: ${String(mode)}` };
    try {
      overrides.modeStore.setUpdateCheckMode(mode);
      return { success: true };
    } catch (error) {
      logger.error(`[Update] Failed to save check mode: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('update:install', async (_event, installerUrl: string): Promise<{ success: boolean; error?: string }> => {
    if (installing) return { success: true };
    // The renderer passes back the URL from update:check; re-validate it so a
    // tampered renderer can at most trigger re-downloading our own release.
    if (!isRepoDownloadUrl(installerUrl)) {
      return { success: false, error: 'Refused to download: not a Helm release asset' };
    }
    installing = true;

    try {
      const dir = overrides.tempDir;
      fs.mkdirSync(dir, { recursive: true });
      // Slash-free so a crafted URL tail can never traverse out of the dir.
      const fileName = decodeURIComponent(installerUrl.split('/').pop() ?? 'update.exe').replace(/[/\\]/g, '');
      // Prefixed so cleanupWorkTempFiles' startup sweep can reap a stranded
      // installer or script from an update that never completed.
      const installerPath = path.join(dir, `helm-update-${fileName}`);
      await download(installerUrl, installerPath);

      const scriptPath = path.join(dir, 'helm-update-run.cmd');
      fs.writeFileSync(scriptPath, buildUpdateScript(installerPath, overrides.execPath ?? process.execPath), 'utf-8');
      logger.info(`[Update] Spawning detached update script: ${scriptPath}`);

      // Detached + unref so the script survives this process quitting.
      const child = (overrides.spawnFn ?? spawn)('cmd.exe', ['/c', scriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();

      sendProgress({ stage: 'restarting', percent: 100 });
      // Give the renderer a beat to render the restarting toast, then quit
      // through the normal path (PTY close → recycle bin → cleanup).
      setTimeout(() => (overrides.quit ?? (() => app.quit()))(), 1000);
      return { success: true };
    } catch (error) {
      installing = false;
      const message = String(error);
      logger.error(`[Update] Install failed: ${message}`);
      sendProgress({ stage: 'failed', percent: 0, error: message });
      return { success: false, error: message };
    }
  });

  const fetchRelease = overrides.fetchFn ?? ((url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => net.fetch(url, init));

  async function download(url: string, destPath: string): Promise<void> {
    const response = await fetchRelease(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    if (!response.body) throw new Error('Download failed: empty response body');

    const total = Number(response.headers.get('content-length')) || undefined;
    let received = 0;
    let lastPercent = -1;
    // Stream straight to disk — the installer is ~150 MB and the main
    // process hosts every PTY, so it must not buffer that in memory.
    const out = fs.createWriteStream(destPath);
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        await new Promise<void>((resolve, reject) => {
          out.write(buf, err => (err ? reject(err) : resolve()));
        });
        received += buf.length;
        const percent = total ? Math.floor((received / total) * 100) : 0;
        if (percent > lastPercent) {
          lastPercent = percent;
          sendProgress({ stage: 'downloading', percent, receivedBytes: received, totalBytes: total });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (error) {
      out.destroy();
      fs.rmSync(destPath, { force: true });
      throw error;
    }
    if (total && received !== total) {
      fs.rmSync(destPath, { force: true });
      throw new Error(`Download truncated: ${received} of ${total} bytes`);
    }
  }
}
