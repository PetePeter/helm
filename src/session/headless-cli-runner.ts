/**
 * Runs a real CLI once, headless, as the recording model: prompt in, final
 * text out. The `cli` backend of the silent runner.
 *
 * The run is a PTY in PtyManager like every other CLI (invariant 2), but a
 * row-less one: PtyManager broadcasts nothing about it, so no session, row,
 * state, chat entry or recycle-bin record can come of it. The Helm session
 * variables are blanked in its environment, so the hook shim of the CLI it
 * starts stays silent: a judge pass can never report a Stop that starts
 * another judge pass.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { stripAnsi } from '../utils/strip-ansi.js';
import { fillHeadlessCommand, headlessCommandProblem } from './headless-command.js';
import type { PtyManager } from './pty-manager.js';
import type { RecordingModel, SilentRunBackend, SilentRunRequest } from './silent-model-runner.js';

type CliModel = Extract<RecordingModel, { kind: 'cli' }>;

/** A CLI starts slowly and answers through its whole agent prompt; longer than this it is stuck. */
export const HEADLESS_TIMEOUT_MS = 120_000;

/** How much of the terminal a failure quotes. */
const TAIL_CHARS = 300;

/** What a Helm session's CLI inherits; a headless run must inherit none of it. */
const NOT_A_SESSION = {
  HELM_SESSION_ID: '',
  HELM_SESSION_NAME: '',
  HELM_MCP_TOKEN: '',
  HELM_MCP_URL: '',
  HELM_HOOK_URL: '',
};

export interface HeadlessCliRunnerDeps {
  pty: Pick<PtyManager, 'spawn' | 'kill'>;
  /** Holds the prompt and reply files of a run, and is its working directory. */
  workDir: string;
  timeoutMs?: number;
}

export class HeadlessCliRunner implements SilentRunBackend<CliModel> {
  /** The last pass of each CLI type: the next one starts when it settles. */
  private readonly last = new Map<string, Promise<void>>();

  constructor(private readonly deps: HeadlessCliRunnerDeps) {}

  /** One pass at a time per CLI type: a second CLI process would only race the first for the same quota. */
  run(model: CliModel, request: SilentRunRequest): Promise<string> {
    const problem = headlessCommandProblem(model.headlessCommand);
    if (problem) return Promise.reject(new Error(`Recording model ${model.id} cannot run: ${problem}`));

    const previous = this.last.get(model.id) ?? Promise.resolve();
    const pass = untilTurn(previous, request.signal).then(() => this.runOnce(model.headlessCommand!, model.env, request));
    // A pass aborted in the queue settles at once; the one after it still waits for the one before.
    const settled = Promise.allSettled([previous, pass]).then(() => undefined);
    this.last.set(model.id, settled);
    void settled.then(() => { if (this.last.get(model.id) === settled) this.last.delete(model.id); });
    return pass;
  }

  private async runOnce(command: string, env: Record<string, string> | undefined, request: SilentRunRequest): Promise<string> {
    const id = `headless-${randomUUID()}`;
    // Named relative to the working directory: see fillHeadlessCommand.
    const files = { promptFile: `${id}.prompt.txt`, outputFile: `${id}.reply.txt` };
    const inWorkDir = (name: string): string => join(this.deps.workDir, name);
    try {
      await mkdir(this.deps.workDir, { recursive: true });
      await writeFile(inWorkDir(files.promptFile), request.system ? `${request.system}\n\n${request.prompt}` : request.prompt, 'utf8');
      // The shell outlives the command it was typed into: make it leave, and say how the command went.
      const line = `${fillHeadlessCommand(command, files)} && exit 0 || exit 1`;
      const { exitCode, tail } = await this.untilExit(id, line, env, request.signal);
      if (exitCode !== 0) throw new Error(`Headless run exited with code ${exitCode}: ${tail}`);
      return await readFile(inWorkDir(files.outputFile), 'utf8');
    } finally {
      // A killed CLI can hold its reply file for a moment longer.
      for (const file of [files.promptFile, files.outputFile].map(inWorkDir)) {
        await rm(file, { force: true, maxRetries: 5, retryDelay: 200 })
          .catch((error) => logger.warn(`[AutoMemory] Could not remove ${file}: ${error}`));
      }
    }
  }

  private untilExit(
    id: string,
    line: string,
    env: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ exitCode: number; tail: string }> {
    const timeoutMs = this.deps.timeoutMs ?? HEADLESS_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const settle = (act: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        act();
      };
      const stop = (reason: string): void => settle(() => {
        this.deps.pty.kill(id);
        reject(new Error(reason));
      });
      const onAbort = (): void => stop('Headless run aborted');
      const timer = setTimeout(() => stop(`Headless run timed out after ${timeoutMs / 1000} s`), timeoutMs);
      // An abort that came while the prompt file was being written fires no event now.
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const pty = this.deps.pty.spawn({
          sessionId: id,
          rawCommand: line,
          cwd: this.deps.workDir,
          env: { ...env, ...NOT_A_SESSION },
          headless: true,
        });
        pty.onData((data) => { output = (output + data).slice(-TAIL_CHARS * 4); });
        pty.onExit(({ exitCode }) => settle(() => resolve({
          exitCode,
          tail: stripAnsi(output).replace(/\s+/g, ' ').trim().slice(-TAIL_CHARS),
        })));
      } catch (error) {
        settle(() => reject(error));
      }
    });
  }
}

/** Resolves when the pass before this one is over; rejects at once if the caller gives up first. */
function untilTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return previous;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error('Headless run aborted'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}
