/**
 * Silent runs against the recording model picked in Settings: one tool-less
 * request, no session row, no chat entry, no hook event. Auto memory's judge
 * pass is the caller; it depends on `SilentRunner` only, never on which
 * backend answers.
 *
 * One interface, one backend per kind of model. An API tool is a direct
 * request through its slots (below). A real CLI type is run once, headless,
 * by the `cli` backend (headless-cli-runner.ts).
 */

import type { ApiToolConfig } from '../config/loader-helpers.js';
import type { SilentRunResult } from '../types/auto-memory.js';
import { logger } from '../utils/logger.js';
import type { ChatMessage } from './api/api-agent-loop.js';
import type { ApiSessionHost } from './api/api-session-host.js';

export interface SilentRunRequest {
  prompt: string;
  system?: string;
  signal?: AbortSignal;
}

export interface SilentRunner {
  /** Never throws: a failed request is a `failed` result, never the caller's problem. */
  runSilently(request: SilentRunRequest): Promise<SilentRunResult>;
}

/** The recording model, resolved from its CLI type. */
export type RecordingModel =
  | { id: string; kind: 'api'; api: ApiToolConfig; env?: Record<string, string> }
  | { id: string; kind: 'cli'; headlessCommand?: string; env?: Record<string, string> };

/** Runs one request against one kind of model and returns its text; may throw. */
export interface SilentRunBackend<TModel extends RecordingModel = RecordingModel> {
  run(model: TModel, request: SilentRunRequest): Promise<string>;
}

export interface RecordingModelRunnerDeps {
  /** Live read of the picked CLI type id; empty = none. */
  getRecordingModel: () => string;
  resolveModel: (ref: string) => RecordingModel | null;
  backends: {
    api: SilentRunBackend<Extract<RecordingModel, { kind: 'api' }>>;
    cli?: SilentRunBackend<Extract<RecordingModel, { kind: 'cli' }>>;
  };
}

export class RecordingModelRunner implements SilentRunner {
  constructor(private readonly deps: RecordingModelRunnerDeps) {}

  async runSilently(request: SilentRunRequest): Promise<SilentRunResult> {
    try {
      const picked = this.deps.getRecordingModel();
      if (!picked) return { status: 'inert', reason: 'No recording model is picked' };
      const model = this.deps.resolveModel(picked);
      if (!model) return this.failed(`Recording model ${picked} no longer exists`);
      const text = (await this.run(model, request)).trim();
      return text ? { status: 'ok', text } : this.failed('The recording model returned no text');
    } catch (err) {
      return this.failed(err instanceof Error ? err.message : String(err));
    }
  }

  private run(model: RecordingModel, request: SilentRunRequest): Promise<string> {
    if (model.kind === 'api') return this.deps.backends.api.run(model, request);
    const backend = this.deps.backends.cli;
    if (!backend) throw new Error(`Recording model ${model.id} needs the headless runner`);
    return backend.run(model, request);
  }

  private failed(error: string): SilentRunResult {
    logger.warn(`[AutoMemory] Silent run failed: ${error}`);
    return { status: 'failed', error };
  }
}

/** API tools: one direct chat-completions request, queued on the tool's own slots. */
export function apiSilentBackend(
  host: Pick<ApiSessionHost, 'completeSilently'>,
): SilentRunBackend<Extract<RecordingModel, { kind: 'api' }>> {
  return {
    run: (model, request) => {
      const messages: ChatMessage[] = [
        ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
        { role: 'user' as const, content: request.prompt },
      ];
      return host.completeSilently({ cliType: model.id, api: model.api, env: model.env }, messages, request.signal);
    },
  };
}
