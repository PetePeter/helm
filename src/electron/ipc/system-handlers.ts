/**
 * System IPC Handlers
 *
 * OS-level operations — logs folder access, external editor, temp file cleanup.
 */

import { ipcMain, shell, app, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger, logDir } from '../../utils/logger.js';
import { getTempDir } from '../../utils/app-paths.js';
import { forceDeleteTempFile } from '../../utils/temp-file-delete.js';
import { ARTIFACT_TEMP_PREFIX } from '../../session/artifact-temp-file.js';
import { MEMORY_ATTACHMENT_TEMP_PREFIX } from '../../session/memory-attachment-manager.js';

export function setupSystemHandlers(dirname: string): void {
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('help:open', async () => {
    try {
      const base = app.isPackaged ? (process.resourcesPath ?? '') : app.getAppPath();
      const guidePath = path.join(base, 'build', 'user-guide.html');
      if (!fs.existsSync(guidePath)) {
        const msg = `User guide not found: ${guidePath}`;
        logger.error(`[IPC] ${msg}`);
        return { success: false, error: msg };
      }
      const win = new BrowserWindow({
        width: 960,
        height: 720,
        title: 'Helm User Guide',
        autoHideMenuBar: true,
        resizable: true,
        maximizable: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      await win.loadFile(guidePath);
      logger.info('[IPC] Opened user guide in BrowserWindow');
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to open user guide: ${error}`);
      return { success: false, error: String(error) };
    }
  });
  // system:openExternalUrl — hand a clicked terminal link to the OS default handler
  // (default browser for http/https, registered handler otherwise) instead of an in-app window.
  ipcMain.handle('system:openExternalUrl', async (_e, url: string) => {
    // Only ever hand safe web/mail schemes to the OS. Blocks file:, custom-protocol,
    // and other handlers that a malicious link (e.g. inside an AI-authored artifact)
    // could otherwise trigger via the shell.
    if (typeof url !== 'string' || !/^(?:https?|mailto):/i.test(url)) {
      logger.warn(`[IPC] Refused to open external URL with disallowed scheme: "${url}"`);
      return { success: false, error: 'Disallowed URL scheme' };
    }
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to open external URL "${url}": ${error}`);
      return { success: false, error: String(error) };
    }
  });
  ipcMain.handle('system:openLogsFolder', async () => {
    try {
      const errorMessage = await shell.openPath(logDir);
      if (errorMessage) {
        logger.error(`[IPC] Failed to open logs folder: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
      return { success: true };
    } catch (error) {
      logger.error(`[IPC] Failed to open logs folder: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  // editor:openExternal — Ctrl+G: open temp file in Notepad, return contents on close
  ipcMain.handle('editor:openExternal', async () => {
    const tmpDir = getTempDir(dirname);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch (err) {
      logger.warn(`[System] Could not create tmp dir ${tmpDir}: ${err}`);
    }
    const tmpFile = path.join(tmpDir, `helm-prompt-${Date.now()}.md`);
    try {
      fs.writeFileSync(tmpFile, '', 'utf-8');
      logger.info(`[System] Opening external editor: ${tmpFile}`);

      await new Promise<void>((resolve, reject) => {
        const editor = spawn('notepad.exe', [tmpFile], { stdio: 'ignore' });
        editor.on('close', () => resolve());
        editor.on('error', (err) => reject(err));
      });

      const content = fs.readFileSync(tmpFile, 'utf-8');
      logger.info(`[System] Editor closed, content length: ${content.length}`);
      return { success: true, text: content };
    } catch (error) {
      logger.error(`[System] External editor failed: ${error}`);
      return { success: false, error: String(error) };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }
  });

  // temp:writeContent — write text to a temp file for draft/plan apply
  // Returns the file path on success, or { success: false, error } on failure
  ipcMain.handle('temp:writeContent', async (_, content: string): Promise<{ success: boolean; path?: string; error?: string }> => {
    const tmpDir = getTempDir(dirname);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch (err) {
      logger.warn(`[System] Could not create tmp dir ${tmpDir}: ${err}`);
    }

    const tmpFile = path.join(tmpDir, `helm-work-${Date.now()}.md`);
    try {
      fs.writeFileSync(tmpFile, content, 'utf-8');
      logger.info(`[System] Wrote temp file: ${tmpFile} (${content.length} bytes)`);
      return { success: true, path: tmpFile };
    } catch (error) {
      logger.error(`[System] Failed to write temp file: ${error}`);
      return { success: false, error: String(error) };
    }
  });

  // temp:deleteContent — delete a temp file (best-effort, non-critical)
  ipcMain.handle('temp:deleteContent', async (_, filePath: string): Promise<void> => {
    try {
      fs.unlinkSync(filePath);
      logger.debug(`[System] Deleted temp file: ${filePath}`);
    } catch (error) {
      logger.debug(`[System] Could not delete temp file ${filePath}: ${error}`);
      /* best-effort cleanup — ignore errors */
    }
  });
}

/** Prefixes of temp files Helm owns and may reap wholesale on startup. */
const OWNED_TEMP_PREFIXES = [
  'helm-work-',
  'helm-prompt-',
  'helm-large-text-',
  'helm-plan-export-',
  'helm-attachment-',
  'helm-mcp-artifact-',
  'helm-mcp-attachment-',
  // Self-update: a stranded installer or update script from a failed run
  'helm-update-',
  ARTIFACT_TEMP_PREFIX,
  MEMORY_ATTACHMENT_TEMP_PREFIX,
];

/**
 * Clean up stale temp files from previous sessions.
 *
 * Called on startup to prevent accumulation, and the backstop for anything a
 * crash stranded — including legacy `helm-artifact-*` names from before those
 * files carried a session id. Best-effort: errors are logged, never fatal.
 */
export function cleanupWorkTempFiles(dirname: string, appData?: string): void {
  const tmpDir = getTempDir(dirname, appData);
  try {
    if (!fs.existsSync(tmpDir)) return;
    for (const file of fs.readdirSync(tmpDir)) {
      if (!OWNED_TEMP_PREFIXES.some(prefix => file.startsWith(prefix))) continue;
      // Artifact and plan exports are written read-only, so unlink alone fails.
      if (forceDeleteTempFile(path.join(tmpDir, file))) {
        logger.debug(`[System] Cleaned up temp file: ${file}`);
      }
    }
  } catch (error) {
    logger.warn(`[System] Failed to cleanup temp directory: ${error}`);
  }
}
