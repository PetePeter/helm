/**
 * Artifact IPC Handlers
 *
 * Renderer-facing surface for session artifacts. Includes:
 * - Read/consume operations (list, get, counts, reveal, export)
 * - Manual creation operations (createText, createWithFile, pickAndReadFile, rename)
 *
 * AI-driven create/update remain MCP-only; the renderer gains create access
 * for user-initiated manual artifacts.
 */

import { ipcMain, dialog, BrowserWindow, shell } from 'electron';
import { readFile, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ArtifactManager } from '../../session/artifact-manager.js';
import type { ArtifactAttachmentManager } from '../../session/artifact-attachment-manager.js';
import type { WindowManager } from '../window-manager.js';
import { mimeForPath } from '../helm-img-protocol.js';
import { setPendingDocument } from '../helm-artifact-protocol.js';
import { sanitizeFilename, artifactExtension, artifactTempFileName } from '../../session/artifact-temp-file.js';
import { ArtifactTempRegistry } from '../../session/artifact-temp-registry.js';
import { createArtifactFromBytes } from '../../session/artifact-file-import.js';
import { getTempDir } from '../../utils/app-paths.js';
import { logger } from '../../utils/logger.js';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Decode a base64 attachment input, refusing oversized files before decoding.
 * Shared by every handler that turns renderer base64 into stored bytes.
 */
function decodeAttachmentInput(input: {
  filename: string;
  contentBase64: string;
  contentType?: string;
}): { filename: string; content: Buffer; contentType?: string } {
  // Validate size before decoding (base64 is ~4/3 of raw size)
  const rawSize = Math.ceil(input.contentBase64.length * 3 / 4);
  if (rawSize > MAX_ATTACHMENT_BYTES) {
    throw new Error('File exceeds 10MB size limit');
  }
  return {
    filename: input.filename,
    content: Buffer.from(input.contentBase64, 'base64'),
    contentType: input.contentType,
  };
}

export function setupArtifactHandlers(
  artifactManager: ArtifactManager,
  attachmentManager: ArtifactAttachmentManager,
  windowManager?: WindowManager,
  moduleDirname?: string,
  tempRegistry: ArtifactTempRegistry = new ArtifactTempRegistry(),
): void {
  // ── Read operations (existing) ───────────────────────────────────────────

  ipcMain.handle('artifact:list', (_event, sessionId: string) => {
    return artifactManager.getForSession(sessionId);
  });

  // Version-agnostic artifact count per session, for the session-card badges.
  ipcMain.handle('artifact:counts', (): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const [sessionId, artifacts] of Object.entries(artifactManager.exportAll())) {
      counts[sessionId] = artifacts.length;
    }
    return counts;
  });

  // Hand a built HTML artifact document to the helm-artifact:// handler and
  // return the nonce the renderer puts in the iframe src. The renderer builds
  // the document because that is where DOMParser lives; main only serves it,
  // with the CSP response header that makes the isolation real.
  ipcMain.handle('artifact:prepareRender', (_event, html: string): string => {
    return setPendingDocument(html);
  });

  ipcMain.handle('artifact:get', (_event, artifactId: string) => {
    return artifactManager.get(artifactId);
  });

  ipcMain.handle('artifact:delete', (_event, artifactId: string) => {
    return artifactManager.delete(artifactId);
  });

  ipcMain.handle('artifact:deleteAll', (_event, sessionId: string) => {
    artifactManager.deleteAllForSession(sessionId);
    return true;
  });

  ipcMain.handle('artifact:reveal', (_event, artifactId: string) => {
    return artifactManager.reveal(artifactId);
  });

  ipcMain.handle('artifact:export', async (_event, artifactId: string): Promise<string | null> => {
    const artifact = artifactManager.get(artifactId);
    if (!artifact) return null;

    const ext = artifactExtension(artifact.kind);
    const filterName = artifact.kind === 'html' ? 'HTML' : 'Markdown';
    const focusedWindow = windowManager?.getMainWindow() ?? BrowserWindow.getFocusedWindow();
    const options: Electron.SaveDialogOptions = {
      title: 'Export Artifact',
      defaultPath: `${sanitizeFilename(artifact.title)}.${ext}`,
      filters: [
        { name: filterName, extensions: [ext] },
        { name: 'All Files', extensions: ['*'] },
      ],
    };

    const result = focusedWindow
      ? await dialog.showSaveDialog(focusedWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;

    const latest = artifact.versions[artifact.versions.length - 1];
    try {
      await fsWriteFile(result.filePath, latest.content, 'utf8');
      logger.info(`[IPC] Exported artifact ${artifactId} to ${result.filePath}`);
      return result.filePath;
    } catch (err) {
      logger.error(`[artifact:export] Failed to write ${result.filePath}: ${err}`);
      return null;
    }
  });

  /**
   * Materialise one artifact version to a temp file and hand it to the OS default
   * app. `version` defaults to the latest; an unknown number falls back to it too,
   * matching the viewer's own tolerance.
   *
   * The copy is left behind deliberately — the external app still holds it. It is
   * marked read-only (edits there would be silently lost, since artifacts.yaml is
   * the source of truth), registered against the owning session so closing that
   * session reaps it, and swept on next startup by `cleanupWorkTempFiles`.
   */
  ipcMain.handle('artifact:openExternal', async (
    _event,
    artifactId: string,
    version?: number,
  ): Promise<{ success: boolean; path?: string; error?: string }> => {
    const artifact = artifactManager.get(artifactId);
    if (!artifact || artifact.versions.length === 0) {
      return { success: false, error: 'Artifact not found' };
    }

    const shown = artifact.versions.find(v => v.version === version)
      ?? artifact.versions[artifact.versions.length - 1];

    const tmpDir = getTempDir(moduleDirname ?? '');
    const tmpPath = join(
      tmpDir,
      artifactTempFileName(artifact.sessionId, artifact.title, artifact.kind, Date.now()),
    );
    try {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(tmpPath, shown.content, 'utf8');
      tempRegistry.record(artifact.sessionId, tmpPath);
      try { chmodSync(tmpPath, 0o444); } catch (err) {
        logger.warn(`[artifact:openExternal] Could not mark ${tmpPath} read-only: ${err}`);
      }

      // openPath resolves a non-empty message on failure rather than throwing —
      // e.g. Windows with no application registered for .md.
      const openErr = await shell.openPath(tmpPath);
      if (openErr) {
        logger.warn(`[artifact:openExternal] ${tmpPath}: ${openErr}`);
        return { success: false, error: openErr };
      }

      logger.info(`[IPC] Opened artifact ${artifactId} v${shown.version} externally: ${tmpPath}`);
      return { success: true, path: tmpPath };
    } catch (err) {
      logger.error(`[artifact:openExternal] Failed for ${artifactId}: ${err}`);
      return { success: false, error: String(err) };
    }
  });

  // ── Manual creation operations (new) ───────────────────────────────────────

  /** Create a manual text/markdown artifact. */
  ipcMain.handle('artifact:createText', (_event, sessionId: string, title: string, content: string, kind?: 'markdown' | 'html') => {
    return artifactManager.create(sessionId, title, kind ?? 'markdown', content, 'manual');
  });

  /** Create a manual artifact from a base64-encoded file (clipboard paste or drag-drop). */
  ipcMain.handle('artifact:createWithFile', (_event, sessionId: string, input: {
    filename: string;
    contentBase64: string;
    contentType?: string;
  }) => {
    try {
      return createArtifactFromBytes(artifactManager, attachmentManager, sessionId, decodeAttachmentInput(input), undefined, 'manual', false);
    } catch (err) {
      logger.error(`[artifact:createWithFile] Failed to store ${input.filename}: ${err}`);
      throw err;
    }
  });

  /** Open a native file picker, read the file, return base64-encoded content. */
  ipcMain.handle('artifact:pickAndReadFile', async () => {
    const focusedWindow = windowManager?.getMainWindow() ?? BrowserWindow.getFocusedWindow();
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, {
          properties: ['openFile'],
          title: 'Attach File to Artifact',
        })
      : await dialog.showOpenDialog({
          properties: ['openFile'],
          title: 'Attach File to Artifact',
        });
    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_ATTACHMENT_BYTES) {
        throw new Error('File exceeds 10MB size limit');
      }
      const buffer = await readFile(filePath);
      const filename = basename(filePath);
      const mime = mimeForPath(filePath);

      return {
        filename,
        contentBase64: buffer.toString('base64'),
        contentType: mime ?? undefined,
      };
    } catch (err) {
      logger.error(`[artifact:pickAndReadFile] Failed to read ${filePath}: ${err}`);
      throw err;
    }
  });

  /** Rename an artifact. */
  ipcMain.handle('artifact:rename', (_event, artifactId: string, newTitle: string) => {
    return artifactManager.rename(artifactId, newTitle);
  });

  /**
   * Save an edited body as a NEW version (history is never rewritten). Blank
   * content is refused rather than stored — an empty save is always a mistake,
   * and it would otherwise leave the artifact showing nothing.
   */
  ipcMain.handle('artifact:update', (_event, artifactId: string, content: string) => {
    if (typeof content !== 'string' || content.trim() === '') return null;
    return artifactManager.update(artifactId, content);
  });

  /** Open an attachment file in the system's default app. */
  ipcMain.handle('artifact:openAttachment', async (_event, artifactId: string, attachmentId: string) => {
    try {
      const absPath = attachmentManager.getPath(artifactId, attachmentId);
      await shell.openPath(absPath);
      return true;
    } catch (err) {
      logger.error(`[artifact:openAttachment] Failed to open ${attachmentId}: ${err}`);
      return false;
    }
  });

  // ── Attachment CRUD on existing artifacts ──────────────────────────────────

  /** List an artifact's attachments. Metadata only — no bytes cross the bridge. */
  ipcMain.handle('artifact:attachmentList', (_event, artifactId: string) => {
    return attachmentManager.list(artifactId);
  });

  /**
   * Attach a base64-encoded file to an existing artifact. The artifact body is
   * not rewritten — attachments are a side store, and body links stay as-is.
   */
  ipcMain.handle('artifact:attachmentAdd', (_event, artifactId: string, input: {
    filename: string;
    contentBase64: string;
    contentType?: string;
  }) => {
    if (!artifactManager.get(artifactId)) throw new Error('Artifact not found');
    return attachmentManager.add(artifactId, decodeAttachmentInput(input));
  });

  /** Delete one attachment. Any body link to it becomes inert text. */
  ipcMain.handle('artifact:attachmentDelete', (_event, artifactId: string, attachmentId: string) => {
    return attachmentManager.delete(artifactId, attachmentId);
  });

  logger.info('[IPC] Artifact handlers registered');
}
