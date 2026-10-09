import { readTranscriptUsageDetails } from './transcript-usage.js';

export type ContextSizeUnknownReason = 'no-transcript' | 'no-usage-yet' | 'unsupported-cli' | 'remote' | 'api-unavailable';

export type SessionContextSize =
  | { known: true; tokens: number; window?: number; percent?: number; measuredAtIso?: string; source: 'transcript' | 'api' }
  | { known: false; reason: ContextSizeUnknownReason };

export type ApiSessionContextSize =
  | { available: true; tokens?: number }
  | { available: false };

export interface ContextSizeSession {
  cliTranscriptPath?: string;
  provider?: string;
  apiTool?: boolean;
  comfyUiTool?: boolean;
  remote?: unknown;
}

export interface ResolveContextSizeOptions {
  contextWindow?: number;
  apiContext?: ApiSessionContextSize;
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function knownContext(
  tokens: number | undefined,
  window: number | undefined,
  source: 'transcript' | 'api',
  measuredAtIso?: string,
): SessionContextSize {
  if (!positive(tokens)) return { known: false, reason: 'no-usage-yet' };
  const contextWindow = positive(window);
  return {
    known: true,
    tokens,
    ...(contextWindow ? { window: contextWindow, percent: Math.round(tokens / contextWindow * 100) } : {}),
    ...(measuredAtIso ? { measuredAtIso } : {}),
    source,
  };
}

export function resolveSessionContextSize(
  session: ContextSizeSession,
  options: ResolveContextSizeOptions = {},
): SessionContextSize {
  if (session.remote) return { known: false, reason: 'remote' };

  const window = positive(options.contextWindow);
  if (session.apiTool) {
    if (!options.apiContext || !options.apiContext.available) return { known: false, reason: 'api-unavailable' };
    return knownContext(options.apiContext.tokens, window, 'api');
  }

  if (session.comfyUiTool) return { known: false, reason: 'unsupported-cli' };
  if (!session.cliTranscriptPath) {
    return { known: false, reason: session.provider === 'copilot' ? 'unsupported-cli' : 'no-transcript' };
  }

  const result = readTranscriptUsageDetails(session.cliTranscriptPath);
  if (result.status === 'unavailable') return { known: false, reason: 'no-transcript' };
  if (result.status === 'no-usage') {
    return { known: false, reason: session.provider === 'copilot' ? 'unsupported-cli' : 'no-usage-yet' };
  }
  return knownContext(
    result.usage.contextTokens,
    positive(result.usage.contextWindow) ?? options.contextWindow,
    'transcript',
    result.measuredAtIso,
  );
}
