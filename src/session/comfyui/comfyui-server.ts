import { spawn } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { checkComfyConnection } from './comfyui-api.js';

const PROBE_TIMEOUT_MS = 3000;
const READY_POLL_MS = 2000;
const READY_TIMEOUT_MS = 120_000;

export function isLocalEndpoint(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

async function isUp(endpoint: string, signal: AbortSignal): Promise<boolean> {
  try {
    await checkComfyConnection(endpoint, AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]));
    return true;
  } catch {
    return false;
  }
}

function runStartCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Detached with no pipes: the server the command launches must outlive
    // both the launcher and Helm.
    const child = spawn(command, { shell: true, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`ComfyUI start command exited ${code}`)));
    child.unref();
  });
}

/**
 * Make sure the server answers before a job takes the GPU. Only a local
 * endpoint is started: a remote one is somebody else's machine.
 */
export async function ensureComfyServer(
  endpoint: string,
  startCommand: string | undefined,
  signal: AbortSignal,
  onStarting: () => void,
): Promise<void> {
  if (await isUp(endpoint, signal)) return;
  if (signal.aborted) throw new Error('Generation cancelled');
  if (!startCommand || !isLocalEndpoint(endpoint)) throw new Error(`ComfyUI server is not running at ${endpoint}`);

  logger.info(`[ComfyUI] ${endpoint} is down; running the start command.`);
  onStarting();
  await runStartCommand(startCommand);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isUp(endpoint, signal)) return;
    if (signal.aborted) throw new Error('Generation cancelled');
    await new Promise(resolve => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`ComfyUI did not become ready at ${endpoint} within ${READY_TIMEOUT_MS / 1000} seconds of starting it`);
}
