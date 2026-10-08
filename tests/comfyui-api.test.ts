import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

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

  it('uploads a bounded source image and submits an img2img workflow', async () => {
    const config = cloneDefaultComfyUiConfig();
    const profile = config.profiles.find(item => item.id === 'image-z-image-turbo')!;
    const tempDir = mkdtempSync(join(tmpdir(), 'helm-comfy-api-img2img-test-'));
    const sourceImagePath = join(tempDir, 'source.png');
    const sourceBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ejoAAAAASUVORK5CYII=', 'base64');
    writeFileSync(sourceImagePath, sourceBytes);
    const imageBytes = Buffer.from([137, 80, 78, 71]);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/system_stats') return new Response('{}');
      if (url.pathname === '/upload/image') {
        const form = init?.body as FormData;
        expect(form.get('type')).toBe('input');
        expect(form.get('overwrite')).toBe('false');
        const image = form.get('image') as File;
        expect(image.name).toMatch(/^helm-[a-f0-9]{32}\.png$/);
        expect(Buffer.from(await image.arrayBuffer())).toEqual(sourceBytes);
        return new Response(JSON.stringify({ name: 'helm-source.png', subfolder: '', type: 'input' }));
      }
      if (url.pathname === '/prompt') {
        const body = JSON.parse(String(init?.body)) as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> };
        const load = Object.values(body.prompt).find(node => node.class_type === 'LoadImage');
        const encode = Object.values(body.prompt).find(node => node.class_type === 'VAEEncode');
        expect(load?.inputs.image).toBe('helm-source.png');
        expect(encode?.inputs.vae).toEqual(['3', 0]);
        expect(body.prompt['9'].inputs.latent_image).toEqual([expect.any(String), 0]);
        expect(body.prompt['9'].inputs.denoise).toBe(0.65);
        return new Response(JSON.stringify({ prompt_id: 'img2img-prompt' }));
      }
      if (url.pathname === '/history/img2img-prompt') {
        return new Response(JSON.stringify({ 'img2img-prompt': {
          status: { completed: true },
          outputs: { [profile.outputNodeIds[0]]: { images: [{ filename: 'edited.png', type: 'output' }] } },
        } }));
      }
      if (url.pathname === '/view') return new Response(imageBytes);
      throw new Error(`Unexpected ComfyUI request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const results = await runComfyPrompt({
        endpoint: config.endpoint,
        workflow: applyComfyUiProfile(profile, 'change the sky to sunset'),
        profile,
        prompt: 'change the sky to sunset',
        inputImagePath: sourceImagePath,
        tempDir,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });

      expect(results[0].filename).toBe('edited.png');
      expect(fetchMock.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual([
        '/system_stats', '/upload/image', '/prompt', '/history/img2img-prompt', '/view',
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uploads and connects multiple references for the Qwen image profile, including an image-only request', async () => {
    const config = cloneDefaultComfyUiConfig();
    const profile = config.profiles.find(item => item.id === 'image-qwen-image-2-1')!;
    const tempDir = mkdtempSync(join(tmpdir(), 'helm-comfy-api-multi-ref-test-'));
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    const paths = [1, 2].map((tag, index) => {
      const path = join(tempDir, `source-${index + 1}.png`);
      writeFileSync(path, Buffer.from([...signature, tag]));
      return path;
    });
    let uploads = 0;
    let promptGraph: Record<string, { class_type: string; inputs: Record<string, unknown> }> | undefined;
    const imageBytes = Buffer.from([137, 80, 78, 71]);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/system_stats') return new Response('{}');
      if (url.pathname === '/upload/image') {
        const form = init?.body as FormData;
        const file = form.get('image') as File;
        expect(Buffer.from(await file.arrayBuffer())).toEqual(readFileSync(paths[uploads]));
        uploads++;
        return new Response(JSON.stringify({ name: `reference-${uploads}.png`, subfolder: '' }));
      }
      if (url.pathname === '/prompt') {
        const body = JSON.parse(String(init?.body)) as { prompt: typeof promptGraph };
        promptGraph = body.prompt;
        return new Response(JSON.stringify({ prompt_id: 'multi-ref-prompt' }));
      }
      if (url.pathname === '/history/multi-ref-prompt') {
        return new Response(JSON.stringify({ 'multi-ref-prompt': {
          status: { completed: true },
          outputs: { [profile.outputNodeIds[0]]: { images: [{ filename: 'combined.png', type: 'output' }] } },
        } }));
      }
      if (url.pathname === '/view') return new Response(imageBytes);
      throw new Error(`Unexpected ComfyUI request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const results = await runComfyPrompt({
        endpoint: config.endpoint,
        workflow: applyComfyUiProfile(profile, ''),
        profile,
        prompt: '',
        inputImagePaths: paths,
        tempDir,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });

      expect(results[0].filename).toBe('combined.png');
      expect(uploads).toBe(2);
      for (const [index, name] of ['reference-1.png', 'reference-2.png'].entries()) {
        const encoder = promptGraph![profile.referenceImages!.nodeId];
        const loadLink = encoder.inputs[`${profile.referenceImages!.inputPrefix}${index + 1}`] as [string, number];
        expect(promptGraph![loadLink[0]].inputs.image).toBe(name);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('continues polling beyond the former 30-minute generation limit', async () => {
    vi.useFakeTimers();
    const profile = cloneDefaultComfyUiConfig().profiles[0];
    const tempDir = mkdtempSync(join(tmpdir(), 'helm-comfy-api-long-job-test-'));
    let complete = false;
    let historyPolls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/system_stats') return new Response('{}');
      if (url.pathname === '/prompt') return new Response(JSON.stringify({ prompt_id: 'long-prompt' }));
      if (url.pathname === '/history/long-prompt') {
        historyPolls++;
        return new Response(JSON.stringify({ 'long-prompt': complete
          ? { status: { completed: true }, outputs: { [profile.outputNodeIds[0]]: { images: [{ filename: 'result.png' }] } } }
          : { status: { completed: false } } }));
      }
      if (url.pathname === '/view') return new Response(Buffer.from([137, 80, 78, 71]));
      if (url.pathname === '/api/jobs/long-prompt/cancel') throw new Error('Long generation was unexpectedly cancelled');
      throw new Error(`Unexpected ComfyUI request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      let settled = false;
      const generation = runComfyPrompt({
        endpoint: 'http://localhost:8188',
        workflow: applyComfyUiProfile(profile, 'a long-running prompt'),
        profile,
        prompt: 'a long-running prompt',
        tempDir,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }).finally(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 2000);
      expect(settled).toBe(false);
      expect(historyPolls).toBeGreaterThan(900);

      complete = true;
      await vi.advanceTimersByTimeAsync(2000);
      await expect(generation).resolves.toHaveLength(1);
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
