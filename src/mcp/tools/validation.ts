import type { ContextBindingTargetType } from '../../types/context.js';
import type { ArtifactKind } from '../../types/artifact.js';
import { validateGraphDepth } from '../../session/memory-graph.js';
import {
  MEMORY_DREAM_MAX_CANDIDATES,
  MEMORY_DREAM_MIN_CANDIDATES,
  type MemoryExportFormat,
} from '../../types/memory.js';

export const MEMORY_SORT_FIELDS = ['created', 'updated', 'accessed'] as const;
export const MEMORY_SORT_ORDERS = ['asc', 'desc'] as const;

export function asDreamPercentile(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error('percentile must be a finite number greater than 0 and at most 100');
  }
  return value;
}

export function asDreamCandidateCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < MEMORY_DREAM_MIN_CANDIDATES || value > MEMORY_DREAM_MAX_CANDIDATES) {
    throw new Error(`${field} must be an integer from ${MEMORY_DREAM_MIN_CANDIDATES} through ${MEMORY_DREAM_MAX_CANDIDATES}`);
  }
  return value;
}

/**
 * Parse a value constrained to a fixed set, naming the allowed options in the
 * error so a caller that guessed wrong can correct itself without the schema.
 */
export function asEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function asString(value: unknown, errorMessage: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(errorMessage);
  }
  return value;
}

/**
 * Parse a required boolean ARGUMENT. Distinct from requireBooleanResult, which
 * asserts a truthy *result* and so rejects `false` — using that on an argument
 * makes `false` unsendable, which is how unlocking a session became impossible.
 */
export function asBoolean(value: unknown, errorMessage: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(errorMessage);
  }
  return value;
}

/**
 * Parse a required array-of-strings ARGUMENT. An empty array is valid and
 * meaningful — for an allow-list it is how a grant is revoked — so only the
 * shape is enforced, never the length.
 */
export function asStringArray(value: unknown, errorMessage: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(errorMessage);
  }
  return value as string[];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}


export function asPlanStatus(value: unknown): 'planning' | 'ready' | 'coding' | 'review' | 'blocked' {
  if (value === 'planning' || value === 'ready' || value === 'coding' || value === 'review' || value === 'blocked') {
    return value;
  }
  throw new Error('status must be one of planning, ready, coding, review, or blocked');
}


export function asPlanTypeOrNull(value: unknown): 'bug' | 'feature' | 'research' | null {
  if (value === null || value === 'bug' || value === 'feature' || value === 'research') {
    return value;
  }
  throw new Error('type must be one of bug, feature, research, or null');
}


export function asPlanFilter(value: unknown, fallback: 'all' | 'active' | 'startable' = 'active'): 'all' | 'active' | 'startable' {
  if (value === undefined || value === null) return fallback;
  if (value === 'all' || value === 'active' || value === 'startable') return value;
  throw new Error('filter must be one of all, active, or startable');
}


export function asContextBindingTargetType(value: unknown): ContextBindingTargetType {
  if (value === 'sequence' || value === 'plan') {
    return value;
  }
  throw new Error('targetType must be one of sequence or plan');
}


export function asAiagentState(value: unknown, errorMessage?: string): 'planning' | 'implementing' | 'completed' | 'idle' {
  if (value === 'planning' || value === 'implementing' || value === 'completed' || value === 'idle') {
    return value;
  }
  throw new Error(errorMessage ?? 'state must be one of planning, implementing, completed, or idle');
}


export function asTerminalOutputMode(value: unknown): 'raw' | 'stripped' | 'both' {
  if (value === undefined) return 'both';
  if (value === 'raw' || value === 'stripped' || value === 'both') return value;
  throw new Error('mode must be one of raw, stripped, or both');
}


export function asArtifactKind(value: unknown): ArtifactKind {
  if (value === 'markdown' || value === 'html') {
    return value;
  }
  throw new Error('kind must be one of markdown or html');
}

export function asStringValue(value: unknown, errorMessage: string): string {
  if (typeof value !== 'string') throw new Error(errorMessage);
  return value;
}

export function asFiniteNumber(value: unknown, errorMessage: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(errorMessage);
  return value;
}

export function asGraphDepth(value: unknown): number {
  if (value === undefined) return 0;
  validateGraphDepth(value);
  return value;
}

export function asMemoryExportFormat(value: unknown): MemoryExportFormat {
  if (value === 'markdown' || value === 'json') return value;
  throw new Error('format must be one of markdown or json');
}


export function requireResult<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}


export function requireBooleanResult(value: boolean, message: string): true {
  if (!value) {
    throw new Error(message);
  }
  return true;
}

export function normalizeStructuredContent(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) {
    return { items: value };
  }
  return { result: value ?? null };
}
