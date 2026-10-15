import { readTranscriptUsageDetails } from './transcript-usage.js';
import type { ContextLevel, ContextLimits } from './context-limits.js';

export type ContextSizeUnknownReason = 'no-transcript' | 'no-usage-yet' | 'unsupported-cli' | 'remote' | 'api-unavailable';

export type SessionContextSize =
  | {
    known: true; tokens: number; window?: number; percent?: number; measuredAtIso?: string; source: 'transcript' | 'api' | 'statusline';
    /** Amber/red token limits and where the tokens sit against them; set on `session_get`. */
    limits?: ContextLimits; level?: ContextLevel;
  }
  | { known: false; reason: ContextSizeUnknownReason };

export type ApiSessionContextSize =
  | { available: true; tokens?: number }
  | { available: false };

export interface ContextSizeSession {
  cliTranscriptPath?: string;
  provider?: string | null;
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
  source: 'transcript' | 'api' | 'statusline',
  measuredAtIso?: string,
): SessionContextSize {
  const validTokens = positive(tokens);
  if (validTokens === undefined) return { known: false, reason: 'no-usage-yet' };
  const contextWindow = positive(window);
  return {
    known: true,
    tokens: validTokens,
    ...(contextWindow ? { window: contextWindow, percent: Math.round(validTokens / contextWindow * 100) } : {}),
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
  if (!session.cliTranscriptPath) return { known: false, reason: 'no-transcript' };

  const result = readTranscriptUsageDetails(session.cliTranscriptPath);
  if (result.status === 'unavailable') return { known: false, reason: 'no-transcript' };
  if (result.status === 'no-usage') return { known: false, reason: 'no-usage-yet' };
  return knownContext(
    result.usage.contextTokens,
    positive(result.usage.contextWindow) ?? options.contextWindow,
    'transcript',
    result.measuredAtIso,
  );
}
