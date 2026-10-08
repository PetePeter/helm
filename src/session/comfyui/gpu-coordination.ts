import { spawn } from 'node:child_process';
import { logger } from '../../utils/logger.js';

const MUTEX_NAME = 'Local\\HelmComfyMediaGeneration';
const QWEN_MODEL_KEY = 'huihui-qwen3.8-27b-abliterated';

interface LoadedModel { modelKey?: string; identifier?: string }

const LM_STUDIO_CLI_MISSING_OUTPUT = '__HELM_LM_STUDIO_CLI_MISSING__';

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(stderr.trim() || `PowerShell exited ${code}`)));
  });
}

function psQuote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

async function readModels(): Promise<LoadedModel[] | null> {
  const raw = await runPowerShell(`$ErrorActionPreference='Stop'; $l=Get-Command lms -ErrorAction SilentlyContinue; if(-not $l){[Console]::Out.WriteLine('${LM_STUDIO_CLI_MISSING_OUTPUT}'); exit 0}; if(-not $l.Source){throw 'LM Studio command has no executable path.'}; $r=& $l.Source ps --json; if($LASTEXITCODE -ne 0){exit 2}; ($r -join [Environment]::NewLine)`);
  return parseLoadedModelsOutput(raw);
}

/** Parse LM Studio's model list, or null when the optional CLI is not installed. */
export function parseLoadedModelsOutput(raw: string): LoadedModel[] | null {
  if (raw === LM_STUDIO_CLI_MISSING_OUTPUT) return null;
  if (!raw) return [];
  const models: unknown = JSON.parse(raw);
  if (!Array.isArray(models)) throw new Error('LM Studio returned an invalid loaded-model list');
  return models.filter((entry): entry is LoadedModel => !!entry && typeof entry === 'object');
}

/** Match the existing Helm media helper's GPU handoff and cross-process mutex. */
export async function acquireComfyGpuLease(localComfyEndpoint: boolean, signal: AbortSignal): Promise<() => Promise<void>> {
  throwIfAborted(signal);
  const mutex = process.platform === 'win32' ? await acquireNamedMutex(signal) : null;
  let restoreIdentifier: string | undefined;
  let restoreNeeded = false;
  try {
    throwIfAborted(signal);
    if (localComfyEndpoint) {
      const models = await readModels();
      throwIfAborted(signal);
      if (models === null) {
        logger.warn('[ComfyUI] LM Studio CLI is unavailable; continuing without LM Studio GPU checks.');
      } else if (models.length > 0) {
        if (models.length !== 1 || models[0].modelKey !== QWEN_MODEL_KEY) {
          const keys = models.map(model => model.modelKey ?? 'unknown').join(', ');
          throw new Error(`ComfyUI GPU is busy with LM Studio models: ${keys}. Close them and retry.`);
        }
        restoreIdentifier = models[0].identifier?.trim() || 'claude-sonnet-5';
        await runPowerShell(`$ErrorActionPreference='Stop'; $l=(Get-Command lms -ErrorAction Stop).Source; & $l unload ${psQuote(restoreIdentifier)}; if($LASTEXITCODE -ne 0){throw 'Could not unload the configured LM Studio model.'}`);
        restoreNeeded = true;
        let unloaded = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          throwIfAborted(signal);
          const currentModels = await readModels();
          if (currentModels === null || !currentModels.some(model => model.modelKey === QWEN_MODEL_KEY)) { unloaded = true; break; }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!unloaded) throw new Error('LM Studio did not release GPU memory within 60 seconds.');
      }
    }
    throwIfAborted(signal);
  } catch (error) {
    try {
      if (restoreIdentifier && restoreNeeded) await restoreLoadedModel(restoreIdentifier);
    } catch (restoreError) {
      logger.error(`[ComfyUI] Failed to restore LM Studio model after GPU handoff error: ${restoreError}`);
    } finally {
      await mutex?.release();
    }
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let restoreError: unknown;
    try {
      if (restoreIdentifier && restoreNeeded) await restoreLoadedModel(restoreIdentifier);
    } catch (error) {
      restoreError = error;
      logger.error(`[ComfyUI] Failed to restore LM Studio model: ${error}`);
    } finally {
      await mutex?.release();
    }
    if (restoreError) throw restoreError;
  };
}

async function restoreLoadedModel(identifier: string): Promise<void> {
  await runPowerShell(`$ErrorActionPreference='Stop'; $l=(Get-Command lms -ErrorAction Stop).Source; & $l load --gpu 0.35 --context-length 131072 --identifier ${psQuote(identifier)} ${QWEN_MODEL_KEY} --yes; if($LASTEXITCODE -ne 0){throw 'LM Studio load failed.'}`);
  const restored = await readModels();
  if (!restored || !restored.some(model => model.modelKey === QWEN_MODEL_KEY && model.identifier === identifier)) {
    throw new Error('LM Studio did not report the configured model as restored.');
  }
}

function acquireNamedMutex(signal: AbortSignal): Promise<{ release(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Generation cancelled'));
    const script = `$ErrorActionPreference='Stop'; $m=[System.Threading.Mutex]::new($false, '${MUTEX_NAME}'); $held=$false; try { try { $m.WaitOne() | Out-Null; $held=$true } catch [System.Threading.AbandonedMutexException] { $held=$true }; [Console]::Out.WriteLine('HELM_LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $m.ReleaseMutex() } finally { $m.Dispose() }`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      child.kill();
      reject(new Error('Generation cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (!settled && stdout.includes('HELM_LOCKED')) {
        settled = true;
        removeAbortListener();
        resolve({ release: () => new Promise((done, fail) => {
          child.once('error', fail);
          child.once('close', code => code === 0 ? done() : fail(new Error(`GPU lock helper exited ${code}: ${stderr}`)));
          child.stdin.end('\n');
        }) });
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', error => {
      if (settled) return;
      settled = true; removeAbortListener(); reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true; removeAbortListener();
      reject(new Error(stderr.trim() || `GPU lock helper exited ${code}`));
    });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Generation cancelled');
}
