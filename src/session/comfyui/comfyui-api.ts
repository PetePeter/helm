import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ComfyUiProfileConfig } from '../../config/loader.js';
import { mimeForPath } from '../../electron/helm-img-protocol.js';
import { MAX_GENERATED_MEDIA_BYTES } from '../generated-media-policy.js';
import { applyComfyInputImages, hasMatchingComfyImageSignature } from './comfyui-image-input.js';

interface ComfyFile { filename: string; subfolder?: string; type?: string }
interface ComfyHistory { status?: { completed?: boolean; status_str?: string; messages?: unknown[] }; outputs?: Record<string, Record<string, unknown>> }

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new Error('Generation cancelled'));
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Error('Generation cancelled'));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

async function requestJson<T>(endpoint: string, path: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const requestSignal = init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${endpoint}${path}`, { ...init, signal: requestSignal });
  if (!response.ok) throw new Error(`ComfyUI ${path} returned HTTP ${response.status}`);
  return await response.json() as T;
}

export async function checkComfyConnection(endpoint: string, signal?: AbortSignal): Promise<void> {
  await requestJson(endpoint, '/system_stats', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
}

export async function cancelComfyPrompt(endpoint: string, promptId: string): Promise<boolean> {
  const modern = await fetch(`${endpoint}/api/jobs/${encodeURIComponent(promptId)}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  if (modern.ok) {
    const cancelled = (await modern.json().catch(() => null) as { cancelled?: unknown } | null)?.cancelled === true;
    if (cancelled) await waitUntilPromptStops(endpoint, promptId);
    return cancelled;
  }
  if (modern.status !== 404 && modern.status !== 405) throw new Error(`ComfyUI could not cancel the job (HTTP ${modern.status})`);

  // Older ComfyUI builds expose the queue primitives instead of job cancellation.
  const queueResponse = await fetch(`${endpoint}/queue`, { signal: AbortSignal.timeout(5000) });
  if (!queueResponse.ok) throw new Error(`ComfyUI queue lookup failed (HTTP ${queueResponse.status})`);
  const queue = await queueResponse.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  const isRunning = queue.queue_running?.some(item => Array.isArray(item) && item[1] === promptId) ?? false;
  const isPending = queue.queue_pending?.some(item => Array.isArray(item) && item[1] === promptId) ?? false;
  if (isPending) {
    const deleted = await fetch(`${endpoint}/queue`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }), signal: AbortSignal.timeout(5000),
    });
    if (!deleted.ok) throw new Error(`ComfyUI could not remove the queued job (HTTP ${deleted.status})`);
    return true;
  }
  if (isRunning) {
    const interrupted = await fetch(`${endpoint}/interrupt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId }), signal: AbortSignal.timeout(5000),
    });
    if (!interrupted.ok) throw new Error(`ComfyUI could not interrupt the running job (HTTP ${interrupted.status})`);
    await waitUntilPromptStops(endpoint, promptId);
    return true;
  }
  return false;
}

async function waitUntilPromptStops(endpoint: string, promptId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${endpoint}/queue`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`ComfyUI queue lookup failed while cancelling (HTTP ${response.status})`);
    const queue = await response.json() as { queue_running?: unknown[] };
    if (!(queue.queue_running?.some(item => Array.isArray(item) && item[1] === promptId) ?? false)) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('ComfyUI acknowledged cancellation but the job is still using the GPU');
}

export async function runComfyPrompt(input: {
  endpoint: string;
  workflow: Record<string, unknown>;
  profile: ComfyUiProfileConfig;
  prompt: string;
  inputImagePaths?: string[];
  /** Backwards-compatible single-file input for callers not yet using the gallery. */
  inputImagePath?: string;
  tempDir: string;
  signal: AbortSignal;
  onProgress: (message: string) => void;
  onSubmitting?: () => void;
  onSubmitted?: (promptId: string) => void;
  onSubmitFailed?: () => void;
}): Promise<Array<{ filePath: string; filename: string; mimeType: string }>> {
  let promptId: string | undefined;
  let submissionSettled = false;
  let generationFinished = false;
  const submitFailed = () => {
    if (submissionSettled) return;
    submissionSettled = true;
    input.onSubmitFailed?.();
  };
  try {
    await checkComfyConnection(input.endpoint, input.signal);
    if (input.signal.aborted) throw new Error('Generation cancelled');
    let workflow = input.workflow;
    const imagePaths = [...new Set([...(input.inputImagePaths ?? []), ...(input.inputImagePath ? [input.inputImagePath] : [])])];
    if (imagePaths.length > input.profile.referenceImages?.maxImages && input.profile.referenceImages) {
      throw new Error(`Profile ${input.profile.name} accepts at most ${input.profile.referenceImages.maxImages} reference images`);
    }
    if (!input.profile.referenceImages && imagePaths.length > 1) {
      throw new Error(`Profile ${input.profile.name} accepts one reference image; select one image`);
    }
    if (imagePaths.length > 0) {
      const totalBytes = imagePaths.reduce((total, path) => total + statSync(path).size, 0);
      if (totalBytes > MAX_GENERATED_MEDIA_BYTES) {
        throw new Error(`ComfyUI reference images exceed the ${MAX_GENERATED_MEDIA_BYTES}-byte total limit`);
      }
      const uploadedNames: string[] = [];
      for (const [index, imagePath] of imagePaths.entries()) {
        input.onProgress(`Uploading reference image ${index + 1} of ${imagePaths.length}`);
        uploadedNames.push(await uploadInputImage(input.endpoint, imagePath, input.signal));
      }
      workflow = applyComfyInputImages(input.profile, workflow, uploadedNames);
    }
    const clientId = randomUUID();
    input.onSubmitting?.();
    let submitted: { prompt_id?: string; node_errors?: unknown };
    try {
      submitted = await requestJson<{ prompt_id?: string; node_errors?: unknown }>(input.endpoint, '/prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        signal: input.signal,
      }, 30_000);
    } catch (error) {
      submitFailed();
      throw error;
    }
    if (submitted.prompt_id) {
      promptId = submitted.prompt_id;
      submissionSettled = true;
      input.onSubmitted?.(promptId);
    } else {
      submitFailed();
    }
    if (submitted.node_errors && Object.keys(submitted.node_errors as object).length > 0) {
      throw new Error('ComfyUI rejected the workflow. Check the node mappings and installed models.');
    }
    if (!promptId) throw new Error('ComfyUI did not return a prompt id');

    const startedAt = Date.now();
    let lastProgressAt = Date.now();
    input.onProgress(`${input.profile.kind === 'video' ? 'Video' : 'Image'} queued in ComfyUI`);
    while (true) {
      await sleep(2000, input.signal);
      const history = await requestJson<Record<string, ComfyHistory>>(input.endpoint, `/history/${encodeURIComponent(promptId)}`, { signal: input.signal });
      const job = history[promptId];
      if (job?.status?.status_str === 'error') throw new Error('ComfyUI reported a workflow error. Check its server log.');
      if (job?.status?.completed) {
        generationFinished = true;
        return await downloadOutputs(input, job.outputs ?? {});
      }
      if (Date.now() - lastProgressAt >= 20_000) {
        input.onProgress(`Still generating (${Math.floor((Date.now() - startedAt) / 1000)}s)`);
        lastProgressAt = Date.now();
      }
    }
  } catch (error) {
    submitFailed();
    if (promptId && !generationFinished) {
      try {
        // A history error or abort must stop the server job before the
        // caller releases the shared GPU lease.
        await cancelComfyPrompt(input.endpoint, promptId);
      } catch (cancelError) {
        const original = error instanceof Error ? error.message : String(error);
        const cancellation = cancelError instanceof Error ? cancelError.message : String(cancelError);
        throw new Error(`${original}; ComfyUI cancellation failed: ${cancellation}`);
      }
    }
    throw error;
  }
}

async function uploadInputImage(endpoint: string, imagePath: string, signal: AbortSignal): Promise<string> {
  const stat = statSync(imagePath);
  if (!stat.isFile()) throw new Error('ComfyUI image input must be a file');
  if (stat.size > MAX_GENERATED_MEDIA_BYTES) {
    throw new Error(`ComfyUI image input exceeds the ${MAX_GENERATED_MEDIA_BYTES}-byte limit`);
  }
  const mimeType = mimeForPath(imagePath);
  const extension = extname(imagePath).toLowerCase();
  if (!mimeType || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    throw new Error('ComfyUI image input must be a PNG, JPEG, or WebP image');
  }
  const bytes = readFileSync(imagePath);
  if (!hasMatchingComfyImageSignature(bytes, mimeType)) {
    throw new Error('ComfyUI image input content does not match its file type');
  }
  if (signal.aborted) throw new Error('Generation cancelled');

  // A content-addressed name lets ComfyUI reuse an existing input when a user
  // iterates on the same image; its upload endpoint deduplicates identical bytes.
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  const canonicalExtension = mimeType === 'image/jpeg' ? '.jpg' : extension;
  const filename = `helm-${hash}${canonicalExtension}`;
  const form = new FormData();
  const blobBytes = Uint8Array.from(bytes);
  form.set('image', new Blob([blobBytes.buffer as ArrayBuffer], { type: mimeType }), filename);
  form.set('type', 'input');
  form.set('overwrite', 'false');
  const response = await fetch(`${endpoint}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) throw new Error(`ComfyUI image upload returned HTTP ${response.status}`);
  const uploaded = await response.json() as { name?: unknown; filename?: unknown; subfolder?: unknown };
  const name = typeof uploaded.name === 'string' ? uploaded.name : uploaded.filename;
  if (typeof name !== 'string' || !name || name.includes('..') || name.includes('\\')) {
    throw new Error('ComfyUI did not return a valid uploaded image name');
  }
  const subfolder = typeof uploaded.subfolder === 'string' ? uploaded.subfolder.replace(/^\/+|\/+$/g, '') : '';
  if (subfolder.split('/').some(part => part === '..')) throw new Error('ComfyUI returned an invalid image subfolder');
  return subfolder ? `${subfolder}/${name}` : name;
}

async function downloadOutputs(
  input: { endpoint: string; profile: ComfyUiProfileConfig; tempDir: string; signal: AbortSignal },
  outputs: Record<string, Record<string, unknown>>,
): Promise<Array<{ filePath: string; filename: string; mimeType: string }>> {
  const files: ComfyFile[] = [];
  for (const nodeId of input.profile.outputNodeIds) {
    const output = outputs[nodeId];
    if (!output) continue;
    const groups = input.profile.kind === 'video' ? ['videos', 'video', 'gifs', 'images'] : ['images'];
    for (const group of groups) {
      const items = output[group];
      if (Array.isArray(items)) files.push(...items.filter(isComfyFile));
    }
  }
  if (files.length === 0) throw new Error('ComfyUI finished without a file from the configured output nodes');
  mkdirSync(input.tempDir, { recursive: true });
  const saved: Array<{ filePath: string; filename: string; mimeType: string }> = [];
  for (const file of files) {
    if (input.signal.aborted) throw new Error('Generation cancelled');
    const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' });
    const response = await fetch(`${input.endpoint}/view?${params}`, {
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) throw new Error(`ComfyUI could not return ${file.filename} (HTTP ${response.status})`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_GENERATED_MEDIA_BYTES) throw new Error(`Generated media exceeds the ${MAX_GENERATED_MEDIA_BYTES}-byte limit`);
    const bytes = await readBoundedBody(response, MAX_GENERATED_MEDIA_BYTES);
    if (bytes.length === 0) throw new Error('ComfyUI returned an empty generated media file');
    const ext = extname(file.filename).replace(/[^.a-z0-9]/gi, '').slice(0, 12) || (input.profile.kind === 'video' ? '.mp4' : '.png');
    const stem = basename(file.filename, extname(file.filename)).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || 'result';
    const filename = `${stem}${ext}`;
    const filePath = join(input.tempDir, `${randomUUID()}-${filename}`);
    writeFileSync(filePath, bytes, { flag: 'wx' });
    saved.push({ filePath, filename, mimeType: mimeForPath(filePath) ?? (input.profile.kind === 'video' ? 'video/mp4' : 'image/png') });
  }
  return saved;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error('ComfyUI returned an unreadable media body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error(`Generated media exceeds the ${maximumBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function isComfyFile(value: unknown): value is ComfyFile {
  return !!value && typeof value === 'object' && typeof (value as ComfyFile).filename === 'string';
}
