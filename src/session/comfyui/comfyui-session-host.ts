import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ComfyUiToolConfig } from '../../config/loader.js';
import { MAX_ATTACHMENT_BYTES, type ArtifactAttachmentManager } from '../artifact-attachment-manager.js';
import type { Artifact } from '../../types/artifact.js';
import type { PtyProcess } from '../pty-manager.js';
import type { ChatAttachmentRef } from '../chat/chat-bridge.js';
import { logger } from '../../utils/logger.js';
import { MAX_GENERATED_MEDIA_BYTES } from '../generated-media-policy.js';
import {
  applyComfyUiProfile,
  COMFYUI_IMAGE_SIZE_OPTIONS,
  comfyUiChatProfiles,
  comfyUiImageSizes,
  comfyUiMaxReferenceImages,
  validateComfyUiConfig,
} from './comfyui-config.js';
import { cancelComfyPrompt, runComfyPrompt } from './comfyui-api.js';
import { hasMatchingComfyImageSignature } from './comfyui-image-input.js';
import { ensureComfyServer, isLocalEndpoint } from './comfyui-server.js';
import { acquireComfyGpuLease } from './gpu-coordination.js';

export interface ComfyUiArtifacts {
  getForSession(sessionId: string): Artifact[];
  create(sessionId: string, title: string, kind: 'markdown', content: string, source: 'manual'): Artifact;
}

export interface ComfyUiSessionHostDeps {
  tempDir: string;
  artifacts: ComfyUiArtifacts;
  attachments: Pick<ArtifactAttachmentManager, 'add' | 'addGeneratedMediaFromFile' | 'get' | 'getPath' | 'list' | 'delete'>;
  onAttachmentDeleted?: (sessionId: string, artifactId: string, attachmentId: string) => void;
  postChat: (sessionId: string, text: string, attachment?: ChatAttachmentRef) => Promise<void>;
  /** Put a prompt another session sent into the chat; the chat pane and a phone record their own. */
  recordPrompt: (sessionId: string, text: string) => void;
  /** Tell the session that asked for a generation how its job ended. */
  notifyRequester: (requesterSessionId: string, comfySessionId: string, text: string) => Promise<void>;
}

export interface ComfyUiSessionProcess extends PtyProcess {
  comfyUiTool: true;
  profiles: ReturnType<typeof comfyUiChatProfiles>;
  imageSizes: ReturnType<typeof comfyUiImageSizes>;
}

interface Job {
  id: string;
  sessionId: string;
  /** The session that sent the prompt; chat prompts have none. */
  requesterSessionId?: string;
  endpoint: string;
  profileId: string;
  imageSizeId?: string;
  prompt: string;
  inputImagePaths: string[];
  controller: AbortController;
  promptId?: string;
  submitting: boolean;
  submissionSettled: Promise<void>;
  finishSubmission: () => void;
  cancelled: boolean;
  executing: boolean;
}

const CHAT_FILES_TITLE = 'Chat files';
const CHAT_FILES_BODY = 'Files generated or shared in this ComfyUI session. Stored images are removed when the session closes.\n';

/** ComfyUI sessions share one serialized GPU queue and the existing chat journal. */
export class ComfyUiSessionHost {
  private readonly sessions = new Map<string, SessionProcess>();
  private readonly jobs = new Map<string, Job>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ComfyUiSessionHostDeps) {}

  create(sessionId: string, configValue: ComfyUiToolConfig): ComfyUiSessionProcess {
    const config = validateComfyUiConfig(configValue);
    const process = new SessionProcess(sessionId, this, config);
    this.sessions.set(sessionId, process);
    return process;
  }

  submit(
    sessionId: string,
    prompt: string,
    profileId?: string,
    imageSizeId?: string,
    requesterSessionId?: string,
    inputImagePath?: string,
    inputAttachmentIds: string[] = [],
  ): { jobId: string; profileId: string } {
    const process = this.sessions.get(sessionId);
    if (!process) throw new Error('ComfyUI session is not running');
    const trimmed = prompt.trim();
    const profile = process.config.profiles.find(item => item.id === profileId)
      ?? (profileId ? undefined : process.config.profiles[0]);
    if (!profile) throw new Error(`Unknown ComfyUI profile: ${profileId}`);
    const attachmentIds = [...new Set(inputAttachmentIds)];
    const referenceCount = attachmentIds.length + (inputImagePath ? 1 : 0);
    const maxReferences = comfyUiMaxReferenceImages(profile);
    if (!trimmed && referenceCount === 0) throw new Error('Enter a prompt or attach a reference image');
    if (referenceCount > maxReferences) {
      throw new Error(`Profile ${profile.name} accepts at most ${maxReferences} reference image${maxReferences === 1 ? '' : 's'}`);
    }
    if (imageSizeId !== undefined) applyComfyUiProfile(profile, trimmed, 1, imageSizeId);
    const imageSize = COMFYUI_IMAGE_SIZE_OPTIONS.find(option => option.id === imageSizeId);
    const referencePaths: string[] = [];
    if (attachmentIds.length > 0) {
      const filesArtifact = this.deps.artifacts.getForSession(sessionId).find(a => a.title === CHAT_FILES_TITLE);
      if (!filesArtifact) throw new Error('A selected reference image is no longer available in this session');
      for (const attachmentId of attachmentIds) {
        const attachment = this.deps.attachments.get(filesArtifact.id, attachmentId);
        if (!attachment || !attachment.contentType?.toLowerCase().startsWith('image/')) {
          throw new Error('A selected reference image is no longer available in this session');
        }
        referencePaths.push(this.deps.attachments.getPath(filesArtifact.id, attachment.id));
      }
    }
    if (inputImagePath) {
      const imported = this.importReferenceImage(sessionId, inputImagePath);
      referencePaths.unshift(imported.filePath);
      void this.deps.postChat(sessionId, 'Reference image added to this session.', imported.attachment).catch(() => undefined);
    }
    const job: Job = {
      id: randomUUID(),
      sessionId,
      ...(requesterSessionId ? { requesterSessionId } : {}),
      endpoint: process.config.endpoint,
      profileId: profile.id,
      ...(imageSizeId ? { imageSizeId } : {}),
      prompt: trimmed,
      inputImagePaths: referencePaths,
      controller: new AbortController(),
      submitting: false,
      submissionSettled: Promise.resolve(),
      finishSubmission: () => undefined,
      cancelled: false,
      executing: false,
    };
    this.jobs.set(job.id, job);
    if (requesterSessionId && trimmed) this.deps.recordPrompt(sessionId, trimmed);
    const inputLabel = referenceCount > 0 ? ` · ${referenceCount} reference image${referenceCount === 1 ? '' : 's'}` : '';
    process.writeStatus(`Queued · ${profile.name}${imageSize ? ` · ${imageSize.name}` : ''}${inputLabel}`);
    void this.deps.postChat(sessionId, `Queued for ${profile.name}${imageSize ? ` · ${imageSize.name}` : ''}${inputLabel}.`).catch(() => undefined);
    this.queue = this.queue.then(() => this.run(job, process, profile)).catch(() => undefined);
    return { jobId: job.id, profileId: profile.id };
  }

  async cancel(sessionId: string): Promise<boolean> {
    const sessionJobs = [...this.jobs.values()].filter(job => job.sessionId === sessionId);
    const job = sessionJobs.find(candidate => candidate.executing) ?? sessionJobs[0];
    if (!job) return false;
    return this.cancelJob(job);
  }

  remove(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      for (const job of this.jobs.values()) {
        if (job.sessionId === sessionId) {
          void this.cancelJob(job).catch(error => logger.warn(`[ComfyUI] Could not cancel closed session job ${job.id}: ${error}`));
        }
      }
    }
  }

  /** Permanently expire stored images after SessionManager removes this session. */
  closeSession(sessionId: string): void {
    this.remove(sessionId);
    this.deleteStoredImages(sessionId);
  }

  private deleteStoredImages(sessionId: string): void {
    for (const artifact of this.deps.artifacts.getForSession(sessionId).filter(item => item.title === CHAT_FILES_TITLE)) {
      for (const attachment of this.deps.attachments.list(artifact.id)) {
        if (!attachment.contentType?.toLowerCase().startsWith('image/')) continue;
        try {
          if (!this.deps.attachments.delete(artifact.id, attachment.id)) continue;
          try {
            this.deps.onAttachmentDeleted?.(sessionId, artifact.id, attachment.id);
          } catch (error) {
            logger.warn(`[ComfyUI] Deleted image ${attachment.id}, but chat-history cleanup failed: ${error}`);
          }
        } catch (error) {
          logger.warn(`[ComfyUI] Could not delete stored image ${attachment.id} for closed session ${sessionId}: ${error}`);
        }
      }
    }
  }

  private async cancelJob(job: Job): Promise<boolean> {
    if (job.submitting) await job.submissionSettled;
    if (job.promptId && !(await cancelComfyPrompt(job.endpoint, job.promptId))) return false;
    job.cancelled = true;
    job.controller.abort();
    return true;
  }

  private async run(job: Job, process: SessionProcess, profile: ComfyUiToolConfig['profiles'][number]): Promise<void> {
    let tempDir: string | undefined;
    let leaseRelease: (() => Promise<void>) | undefined;
    let failure: unknown;
    let cleanupWarning: unknown;
    const storedPaths: string[] = [];
    const endpoint = process.config.endpoint;
    try {
      if (job.controller.signal.aborted) throw new Error('Generation cancelled');
      job.executing = true;
      process.writeStatus(`Generating · ${profile.name}`);
      await this.deps.postChat(job.sessionId, `Generating with ${profile.name}…`);
      await ensureComfyServer(endpoint, process.config.startCommand, job.controller.signal, () => {
        process.writeStatus('Starting ComfyUI…');
        void this.deps.postChat(job.sessionId, 'ComfyUI is not running. Starting it…').catch(() => undefined);
      });
      process.writeStatus('Waiting for GPU…');
      void this.deps.postChat(job.sessionId, 'Waiting for the GPU to become available…').catch(() => undefined);
      leaseRelease = await acquireComfyGpuLease(isLocalEndpoint(endpoint), job.controller.signal);
      if (job.controller.signal.aborted) throw new Error('Generation cancelled');
      tempDir = mkdtempSync(join(this.deps.tempDir, 'comfy-media-'));
      const files = await runComfyPrompt({
        endpoint,
        workflow: applyComfyUiProfile(profile, job.prompt, undefined, job.imageSizeId),
        profile,
        prompt: job.prompt,
        ...(job.inputImagePaths.length > 0 ? { inputImagePaths: job.inputImagePaths } : {}),
        tempDir,
        signal: job.controller.signal,
        onSubmitting: () => {
          job.submitting = true;
          job.submissionSettled = new Promise(resolve => { job.finishSubmission = resolve; });
        },
        onSubmitted: id => {
          job.promptId = id;
          job.submitting = false;
          job.finishSubmission();
        },
        onSubmitFailed: () => {
          job.submitting = false;
          job.finishSubmission();
        },
        onProgress: message => {
          process.writeStatus(message);
          void this.deps.postChat(job.sessionId, message).catch(() => undefined);
        },
      });
      for (const [index, file] of files.entries()) {
        if (job.controller.signal.aborted || this.sessions.get(job.sessionId) !== process) break;
        const artifact = this.chatFilesArtifact(job.sessionId);
        const stored = await this.deps.attachments.addGeneratedMediaFromFile(artifact.id, {
          filePath: file.filePath,
          filename: file.filename,
          contentType: file.mimeType,
        });
        if (stored.sizeBytes > MAX_GENERATED_MEDIA_BYTES || !stored.sha256) throw new Error('Generated media failed its storage integrity check');
        // Close can race the async copy/hash in addGeneratedMediaFromFile. The
        // session removal pass may have run before the row reached the index;
        // remove this late result instead of leaving it behind after close.
        if (this.sessions.get(job.sessionId) !== process) {
          if (this.deps.attachments.delete(stored.artifactId, stored.id)) {
            try {
              this.deps.onAttachmentDeleted?.(job.sessionId, stored.artifactId, stored.id);
            } catch (error) {
              logger.warn(`[ComfyUI] Deleted late image ${stored.id}, but chat-history cleanup failed: ${error}`);
            }
          }
          break;
        }
        const storedPath = this.deps.attachments.getPath(stored.artifactId, stored.id);
        const attachment: ChatAttachmentRef = {
          artifactId: stored.artifactId,
          attachmentId: stored.id,
          filename: stored.filename,
          mimeType: stored.contentType ?? file.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          generatedMedia: true,
          filePath: storedPath,
        };
        storedPaths.push(storedPath);
        const label = profile.kind === 'video' ? 'Generated video' : 'Generated image';
        await this.deps.postChat(job.sessionId, files.length > 1 ? `${label} ${index + 1} of ${files.length}.` : `${label}.`, attachment);
      }
      process.writeStatus('Generation complete');
    } catch (error) {
      failure = error;
    } finally {
      job.executing = false;
      try {
        if (job.promptId) await freeComfyMemory(endpoint);
      } catch { /* best-effort server cleanup */ }
      try { await leaseRelease?.(); } catch (error) {
        cleanupWarning = error;
        logger.warn(`[ComfyUI] Generation finished but GPU handoff cleanup failed: ${error}`);
      }
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }

    let failureMessage: string | undefined;
    if (failure) {
      const cancelled = job.cancelled || job.controller.signal.aborted;
      failureMessage = cancelled
        ? 'Generation cancelled.'
        : `Generation failed: ${failure instanceof Error ? failure.message : String(failure)}`;
      // The chat line is the only other trace, and it expires with the session.
      if (!cancelled) logger.warn(`[ComfyUI] ${profile.name} on ${endpoint} (session ${job.sessionId}): ${failureMessage}`);
      if (this.sessions.get(job.sessionId) === process) {
        process.writeStatus(failureMessage);
        await this.deps.postChat(job.sessionId, failureMessage).catch(() => undefined);
      }
    } else if (cleanupWarning && this.sessions.get(job.sessionId) === process) {
      const message = `Generation finished, but GPU handoff cleanup failed: ${cleanupWarning instanceof Error ? cleanupWarning.message : String(cleanupWarning)}`;
      process.writeStatus(message);
      await this.deps.postChat(job.sessionId, message).catch(() => undefined);
    }
    this.jobs.delete(job.id);
    // Not awaited: delivery to a busy session is slow and must not hold the GPU queue.
    void this.notifyRequester(job, profile, storedPaths, failureMessage);
  }

  /** The requester is another session: it never sees this session's chat. */
  private async notifyRequester(
    job: Job,
    profile: ComfyUiToolConfig['profiles'][number],
    storedPaths: string[],
    failureMessage: string | undefined,
  ): Promise<void> {
    if (!job.requesterSessionId) return;
    const text = failureMessage
      ?? (storedPaths.length === 0
        ? 'Generation ended without a result: the ComfyUI session closed.'
        : [
          `Generated ${profile.kind} from ${profile.name}:`,
          ...storedPaths,
          'Stored until the ComfyUI session closes; copy it to keep it longer.',
        ].join('\n'));
    try {
      await this.deps.notifyRequester(job.requesterSessionId, job.sessionId, text);
    } catch (error) {
      logger.warn(`[ComfyUI] Could not tell session ${job.requesterSessionId} how job ${job.id} ended: ${error}`);
    }
  }

  private chatFilesArtifact(sessionId: string): Artifact {
    return this.deps.artifacts.getForSession(sessionId).find(a => a.title === CHAT_FILES_TITLE)
      ?? this.deps.artifacts.create(sessionId, CHAT_FILES_TITLE, 'markdown', CHAT_FILES_BODY, 'manual');
  }

  private importReferenceImage(sessionId: string, filePath: string): { filePath: string; attachment: ChatAttachmentRef } {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error('ComfyUI image input must be a file');
    if (stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`ComfyUI image input must be between 1 byte and ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    const mimeType = mimeForImagePath(filePath);
    if (!mimeType) throw new Error('ComfyUI image input must be a PNG, JPEG, or WebP image');
    const content = readFileSync(filePath);
    if (!hasMatchingComfyImageSignature(content, mimeType)) {
      throw new Error('ComfyUI image input content does not match its file type');
    }
    const artifact = this.chatFilesArtifact(sessionId);
    const stored = this.deps.attachments.add(artifact.id, {
      filename: basename(filePath), content, contentType: mimeType,
    });
    const storedPath = this.deps.attachments.getPath(stored.artifactId, stored.id);
    return {
      filePath: storedPath,
      attachment: {
        artifactId: stored.artifactId,
        attachmentId: stored.id,
        filename: stored.filename,
        mimeType,
        sizeBytes: stored.sizeBytes,
        filePath: storedPath,
      },
    };
  }
}

function mimeForImagePath(filePath: string): string | undefined {
  switch (extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return undefined;
  }
}

class SessionProcess extends EventEmitter implements ComfyUiSessionProcess {
  readonly pid = 0;
  readonly comfyUiTool = true as const;
  readonly profiles: ComfyUiSessionProcess['profiles'];
  readonly imageSizes: ComfyUiSessionProcess['imageSizes'];
  private exited = false;

  constructor(readonly sessionId: string, private readonly host: ComfyUiSessionHost, readonly config: ComfyUiToolConfig) {
    super();
    this.profiles = comfyUiChatProfiles(config);
    this.imageSizes = comfyUiImageSizes(config);
  }

  write(data: string): void {
    // PTY writes include reminders, keep-warm pings, setup prompts and terminal
    // keys. Only the explicit chat dispatch path may submit a generation job.
    void data;
  }

  writeStatus(message: string): void { this.emit('data', `${message}\r\n`); }
  resize(): void { /* chat sessions have no terminal dimensions */ }
  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.host.remove(this.sessionId);
    this.emit('exit', { exitCode: 0 });
  }
  onData(callback: (data: string) => void): void { this.on('data', callback); }
  onExit(callback: (exitCode: { exitCode: number; signal?: number }) => void): void { this.on('exit', callback); }
}

async function freeComfyMemory(endpoint: string): Promise<void> {
  await fetch(`${endpoint}/free`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000),
  });
}

let registered: ComfyUiSessionHost | null = null;

export function registerComfyUiSessionHost(host: ComfyUiSessionHost | null): void { registered = host; }

export function getComfyUiSessionHost(): ComfyUiSessionHost {
  if (!registered) throw new Error('ComfyUI session host has not been initialized');
  return registered;
}
