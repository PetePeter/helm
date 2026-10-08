/**
 * ComfyUiSessionHost — the reply to the session that asked for a generation.
 *
 * The real host, attachment store and API client run against a fake ComfyUI
 * server (stubbed fetch). The endpoint is deliberately not local: a local one
 * makes the GPU lease unload the user's LM Studio model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactAttachmentManager } from '../src/session/artifact-attachment-manager.js';
import { ComfyUiSessionHost } from '../src/session/comfyui/comfyui-session-host.js';
import { cloneDefaultComfyUiConfigForKind } from '../src/session/comfyui/comfyui-config.js';
import type { Artifact } from '../src/types/artifact.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ENDPOINT = 'http://comfy.test:8188';
const COMFY_SESSION = 'comfy-session';
const REQUESTER = 'llm-session';
const JOB_TIMEOUT_MS = 30_000;

type History = { status: { completed?: boolean; status_str?: string }; outputs?: Record<string, unknown> };

interface Notification { requesterSessionId: string; comfySessionId: string; text: string }

describe('ComfyUI requester reply', () => {
  let rootDir: string;
  let notifications: Notification[];
  let recordedPrompts: Array<{ sessionId: string; text: string }>;
  let notifyRequester: (requesterSessionId: string, comfySessionId: string, text: string) => Promise<void>;
  let host: ComfyUiSessionHost;
  let history: () => History;
  let promptsSubmitted: number;
  let artifacts: Artifact[];
  let attachments: ArtifactAttachmentManager;
  let deletedAttachments: Array<{ sessionId: string; artifactId: string; attachmentId: string }>;

  const config = { ...cloneDefaultComfyUiConfigForKind('image'), endpoint: ENDPOINT };
  const profile = config.profiles[0];
  const completedWith = (...filenames: string[]): History => ({
    status: { completed: true },
    outputs: { [profile.outputNodeIds[0]]: { images: filenames.map(filename => ({ filename, type: 'output' })) } },
  });

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'helm-comfy-host-test-'));
    notifications = [];
    recordedPrompts = [];
    notifyRequester = async (requesterSessionId, comfySessionId, text) => {
      notifications.push({ requesterSessionId, comfySessionId, text });
    };
    history = () => completedWith('result.png');
    promptsSubmitted = 0;
    artifacts = [];
    attachments = new ArtifactAttachmentManager(rootDir);
    deletedAttachments = [];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/system_stats' || url.pathname === '/free') return new Response('{}');
      if (url.pathname === '/prompt') {
        promptsSubmitted += 1;
        return new Response(JSON.stringify({ prompt_id: 'prompt-1' }));
      }
      if (url.pathname === '/upload/image') return new Response(JSON.stringify({ name: 'reference.png', subfolder: '' }));
      if (url.pathname === '/history/prompt-1') return new Response(JSON.stringify({ 'prompt-1': history() }));
      if (url.pathname === '/view') return new Response(Buffer.from([137, 80, 78, 71]));
      if (url.pathname === '/api/jobs/prompt-1/cancel') return new Response(JSON.stringify({ cancelled: true }));
      if (url.pathname === '/queue') return new Response(JSON.stringify({ queue_running: [] }));
      throw new Error(`Unexpected ComfyUI request: ${url.pathname}`);
    }));

    host = new ComfyUiSessionHost({
      tempDir: rootDir,
      artifacts: {
        getForSession: sessionId => artifacts.filter(artifact => artifact.sessionId === sessionId),
        create: (sessionId, title) => {
          const artifact = { id: `artifact-${artifacts.length + 1}`, sessionId, title } as Artifact;
          artifacts.push(artifact);
          return artifact;
        },
      },
      attachments,
      onAttachmentDeleted: (sessionId, artifactId, attachmentId) => {
        deletedAttachments.push({ sessionId, artifactId, attachmentId });
      },
      postChat: async () => undefined,
      recordPrompt: (sessionId, text) => { recordedPrompts.push({ sessionId, text }); },
      notifyRequester: (...args) => notifyRequester(...args),
    });
    host.create(COMFY_SESSION, config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(rootDir, { recursive: true, force: true });
  });

  const waitForNotifications = (count: number) =>
    vi.waitFor(() => expect(notifications).toHaveLength(count), { timeout: JOB_TIMEOUT_MS, interval: 100 });

  /** Absolute paths named in a notification, one per line. */
  const pathsIn = (text: string) => text.split('\n').filter(line => line.startsWith(rootDir));

  it('sends the requester the stored file path and the profile name', async () => {
    host.submit(COMFY_SESSION, 'a quiet lake', undefined, undefined, REQUESTER);

    await waitForNotifications(1);

    const [notification] = notifications;
    expect(notification.requesterSessionId).toBe(REQUESTER);
    expect(notification.comfySessionId).toBe(COMFY_SESSION);
    expect(notification.text).toContain(profile.name);
    const paths = pathsIn(notification.text);
    expect(paths).toHaveLength(1);
    expect(existsSync(paths[0])).toBe(true);
  }, JOB_TIMEOUT_MS);

  it('lists every file of a multi-file result in one notification', async () => {
    history = () => completedWith('first.png', 'second.png');

    host.submit(COMFY_SESSION, 'two lakes', undefined, undefined, REQUESTER);

    await waitForNotifications(1);
    const paths = pathsIn(notifications[0].text);
    expect(paths).toHaveLength(2);
    expect(paths.every(path => existsSync(path))).toBe(true);
  }, JOB_TIMEOUT_MS);

  it('tells the requester why a generation failed', async () => {
    history = () => ({ status: { status_str: 'error' } });

    host.submit(COMFY_SESSION, 'a broken lake', undefined, undefined, REQUESTER);

    await waitForNotifications(1);
    expect(notifications[0].text).toContain('Generation failed: ComfyUI reported a workflow error');
    expect(pathsIn(notifications[0].text)).toHaveLength(0);
  }, JOB_TIMEOUT_MS);

  it('tells the requester when its job was cancelled', async () => {
    history = () => ({ status: {} });

    host.submit(COMFY_SESSION, 'a slow lake', undefined, undefined, REQUESTER);
    await vi.waitFor(() => expect(promptsSubmitted).toBe(1), { timeout: JOB_TIMEOUT_MS, interval: 100 });
    expect(await host.cancel(COMFY_SESSION)).toBe(true);

    await waitForNotifications(1);
    expect(notifications[0].text).toContain('Generation cancelled.');
  }, JOB_TIMEOUT_MS);

  it('notifies nobody when the prompt came from chat', async () => {
    // A requester job queued behind the chat job proves the chat job has ended.
    host.submit(COMFY_SESSION, 'typed in the chat pane');
    host.submit(COMFY_SESSION, 'asked by a session', undefined, undefined, REQUESTER);

    await waitForNotifications(1);
    expect(promptsSubmitted).toBe(2);
    // The pane records what is typed into it; only the session's prompt needs adding to the chat.
    expect(recordedPrompts).toEqual([{ sessionId: COMFY_SESSION, text: 'asked by a session' }]);
  }, JOB_TIMEOUT_MS * 2);

  it('keeps the queue moving when the requester cannot be reached', async () => {
    notifyRequester = async (requesterSessionId, comfySessionId, text) => {
      if (requesterSessionId === 'closed-session') throw new Error('Session not found: closed-session');
      notifications.push({ requesterSessionId, comfySessionId, text });
    };

    host.submit(COMFY_SESSION, 'for a session that closed', undefined, undefined, 'closed-session');
    host.submit(COMFY_SESSION, 'for a live session', undefined, undefined, REQUESTER);

    await waitForNotifications(1);
    expect(notifications[0].requesterSessionId).toBe(REQUESTER);
    expect(pathsIn(notifications[0].text)).toHaveLength(1);
  }, JOB_TIMEOUT_MS * 2);

  it('deletes stored images and their chat references on session close, preserving other files', async () => {
    const referencePath = join(rootDir, 'reference.png');
    writeFileSync(referencePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
    host.submit(COMFY_SESSION, 'use this reference', undefined, undefined, REQUESTER, referencePath);

    await waitForNotifications(1);
    const artifact = artifacts.find(item => item.sessionId === COMFY_SESSION)!;
    const images = attachments.list(artifact.id).filter(item => item.contentType?.startsWith('image/'));
    expect(images).toHaveLength(2); // Uploaded reference plus generated result.
    const imagePaths = images.map(item => attachments.getPath(artifact.id, item.id));
    const document = attachments.add(artifact.id, {
      filename: 'notes.txt', content: Buffer.from('keep'), contentType: 'text/plain',
    });

    // PTY removal alone also happens during app shutdown; storage expires only
    // when SessionManager confirms that the session itself has closed.
    host.remove(COMFY_SESSION);
    expect(imagePaths.every(path => existsSync(path))).toBe(true);

    host.closeSession(COMFY_SESSION);
    expect(imagePaths.every(path => !existsSync(path))).toBe(true);
    expect(attachments.list(artifact.id).map(item => item.id)).toEqual([document.id]);
    expect(deletedAttachments).toEqual(images.map(item => ({
      sessionId: COMFY_SESSION, artifactId: artifact.id, attachmentId: item.id,
    })));
  }, JOB_TIMEOUT_MS);

  it('removes a generated image that finishes storing after session close', async () => {
    let signalStorageStarted!: () => void;
    let releaseStorage!: () => void;
    let signalStorageFinished!: () => void;
    let storageOutcome: { ok: true } | { ok: false; error: string } | undefined;
    const storageStarted = new Promise<void>(resolve => { signalStorageStarted = resolve; });
    const storageFinished = new Promise<void>(resolve => { signalStorageFinished = resolve; });
    const storageGate = new Promise<void>(resolve => { releaseStorage = resolve; });
    const store = attachments.addGeneratedMediaFromFile.bind(attachments);
    vi.spyOn(attachments, 'addGeneratedMediaFromFile').mockImplementation(async (artifactId, input) => {
      signalStorageStarted();
      await storageGate;
      try {
        const stored = await store(artifactId, input);
        storageOutcome = { ok: true };
        return stored;
      } catch (error) {
        storageOutcome = { ok: false, error: String(error) };
        throw error;
      } finally {
        signalStorageFinished();
      }
    });

    host.submit(COMFY_SESSION, 'a closing session', undefined, undefined, REQUESTER);
    await storageStarted;
    const artifact = artifacts.find(item => item.sessionId === COMFY_SESSION)!;
    host.closeSession(COMFY_SESSION);
    releaseStorage();

    await vi.waitFor(() => expect(storageOutcome).toBeDefined(), { timeout: 5000, interval: 20 });
    await storageFinished;
    await waitForNotifications(1);
    expect(storageOutcome).toEqual({ ok: true });
    expect(attachments.list(artifact.id).filter(item => item.contentType?.startsWith('image/'))).toHaveLength(0);
    expect(deletedAttachments).toEqual([{
      sessionId: COMFY_SESSION,
      artifactId: artifact.id,
      attachmentId: expect.any(String),
    }]); // Cleanup also covers the late result even though it was never posted.
  }, JOB_TIMEOUT_MS);
});
