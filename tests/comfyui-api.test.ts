import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyComfyUiProfile, cloneDefaultComfyUiConfig } from '../src/session/comfyui/comfyui-config.js';
import { cancelComfyPrompt, runComfyPrompt } from '../src/session/comfyui/comfyui-api.js';

describe('ComfyUI cancellation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('targets the requested prompt and waits for it to leave the running queue', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ cancelled: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queue_running: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const cancelled = await cancelComfyPrompt('http://localhost:8188', 'prompt / 1');

    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8188/api/jobs/prompt%20%2F%201/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://localhost:8188/queue', expect.any(Object));
  });
});

describe('ComfyUI generation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('submits the mapped prompt and saves the configured output node', async () => {
    const config = cloneDefaultComfyUiConfig();
    const profile = config.profiles[0];
    const tempDir = mkdtempSync(join(tmpdir(), 'helm-comfy-api-test-'));
    const imageBytes = Buffer.from([137, 80, 78, 71]);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/system_stats') return new Response('{}');
      if (url.pathname === '/prompt') {
        const body = JSON.parse(String(init?.body)) as { prompt: Record<string, { inputs: Record<string, unknown> }> };
        expect(body.prompt['2'].inputs.text).toBe('a quiet lake');
        return new Response(JSON.stringify({ prompt_id: 'prompt-1' }));
      }
      if (url.pathname === '/history/prompt-1') {
        return new Response(JSON.stringify({ 'prompt-1': {
          status: { completed: true },
          outputs: { [profile.outputNodeIds[0]]: { images: [{ filename: 'result.png', type: 'output' }] } },
        } }));
      }
      if (url.pathname === '/view') return new Response(imageBytes);
      throw new Error(`Unexpected ComfyUI request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const results = await runComfyPrompt({
        endpoint: config.endpoint,
        workflow: applyComfyUiProfile(profile, 'a quiet lake'),
        profile,
        prompt: 'a quiet lake',
        tempDir,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });

      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe('result.png');
      expect(results[0].mimeType).toBe('image/png');
      expect(readFileSync(results[0].filePath)).toEqual(imageBytes);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('cancels an accepted prompt when status polling fails', async () => {
    const profile = cloneDefaultComfyUiConfig().profiles[0];
    const tempDir = mkdtempSync(join(tmpdir(), 'helm-comfy-api-cancel-test-'));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/system_stats') return new Response('{}');
      if (url.pathname === '/prompt') return new Response(JSON.stringify({ prompt_id: 'prompt-1' }));
      if (url.pathname === '/history/prompt-1') return new Response('temporary error', { status: 500 });
      if (url.pathname === '/api/jobs/prompt-1/cancel') return new Response(JSON.stringify({ cancelled: true }));
      if (url.pathname === '/queue') return new Response(JSON.stringify({ queue_running: [] }));
      throw new Error(`Unexpected ComfyUI request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSubmitted = vi.fn();
    const onSubmitFailed = vi.fn();

    try {
      await expect(runComfyPrompt({
        endpoint: 'http://localhost:8188',
        workflow: applyComfyUiProfile(profile, 'a test prompt'),
        profile,
        prompt: 'a test prompt',
        tempDir,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onSubmitted,
        onSubmitFailed,
      })).rejects.toThrow('ComfyUI /history/prompt-1 returned HTTP 500');
      expect(onSubmitted).toHaveBeenCalledWith('prompt-1');
      expect(onSubmitFailed).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8188/api/jobs/prompt-1/cancel',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('releases submission waiters when ComfyUI rejects a workflow', async () => {
    const profile = cloneDefaultComfyUiConfig().profiles[0];
    const tempDir = mkdtempSync(join(tmpdir(), 'helm-comfy-api-reject-test-'));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/system_stats') return new Response('{}');
      if (url.pathname === '/prompt') return new Response(JSON.stringify({ node_errors: { '2': { errors: [] } } }));
      throw new Error(`Unexpected ComfyUI request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSubmitFailed = vi.fn();

    try {
      await expect(runComfyPrompt({
        endpoint: 'http://localhost:8188',
        workflow: applyComfyUiProfile(profile, 'a test prompt'),
        profile,
        prompt: 'a test prompt',
        tempDir,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onSubmitFailed,
      })).rejects.toThrow('ComfyUI rejected the workflow');
      expect(onSubmitFailed).toHaveBeenCalledOnce();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
