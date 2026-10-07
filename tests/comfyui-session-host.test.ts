/**
 * ComfyUiSessionHost — the reply to the session that asked for a generation.
 *
 * The real host, attachment store and API client run against a fake ComfyUI
 * server (stubbed fetch). The endpoint is deliberately not local: a local one
 * makes the GPU lease unload the user's LM Studio model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/system_stats' || url.pathname === '/free') return new Response('{}');
      if (url.pathname === '/prompt') {
        promptsSubmitted += 1;
        return new Response(JSON.stringify({ prompt_id: 'prompt-1' }));
      }
      if (url.pathname === '/history/prompt-1') return new Response(JSON.stringify({ 'prompt-1': history() }));
      if (url.pathname === '/view') return new Response(Buffer.from([137, 80, 78, 71]));
      if (url.pathname === '/api/jobs/prompt-1/cancel') return new Response(JSON.stringify({ cancelled: true }));
      if (url.pathname === '/queue') return new Response(JSON.stringify({ queue_running: [] }));
      throw new Error(`Unexpected ComfyUI request: ${url.pathname}`);
    }));

    const artifacts: Artifact[] = [];
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
      attachments: new ArtifactAttachmentManager(rootDir),
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
});
