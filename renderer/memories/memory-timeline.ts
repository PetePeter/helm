import type { MemorySummary } from '../../src/types/memory.js';

export type MemoryTimelinePreset = '7d' | '30d' | '90d' | 'all' | 'custom';

export interface MemoryTimelineRange {
  start: number;
  end: number;
}

export interface MemoryTimelineBucket extends MemoryTimelineRange {
  count: number;
  label: string;
}

export type MemoryTimelineBounds = MemoryTimelineRange;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BUCKETS = 30;

export function memoryTimelineBounds(memories: readonly MemorySummary[]): MemoryTimelineBounds | null {
  if (memories.length === 0) return null;
  let start = memories[0].createdAt;
  let end = start;
  for (const memory of memories) {
    start = Math.min(start, memory.createdAt);
    end = Math.max(end, memory.createdAt);
  }
  return { start, end };
}

export function memoryRangeForPreset(
  bounds: MemoryTimelineBounds,
  preset: Exclude<MemoryTimelinePreset, 'custom'>,
): MemoryTimelineRange {
  if (preset === 'all') return { ...bounds };
  const days = Number.parseInt(preset, 10);
  return { start: Math.max(bounds.start, bounds.end - days * DAY_MS), end: bounds.end };
}

export function sortMemoriesNewestFirst(memories: readonly MemorySummary[]): MemorySummary[] {
  return [...memories].sort((a, b) => b.createdAt - a.createdAt
    || b.updatedAt - a.updatedAt
    || a.id.localeCompare(b.id));
}

export function memoriesInTimelineRange(
  memories: readonly MemorySummary[],
  range: MemoryTimelineRange,
): MemorySummary[] {
  return memories.filter((memory) => memory.createdAt >= range.start && memory.createdAt <= range.end);
}

export function buildMemoryHistogram(
  memories: readonly MemorySummary[],
  range: MemoryTimelineRange,
): MemoryTimelineBucket[] {
  const duration = Math.max(0, range.end - range.start);
  const count = Math.max(1, Math.min(MAX_BUCKETS, Math.ceil(duration / DAY_MS)));
  const bucketWidth = count === 0 ? 0 : duration / count;
  const counts = Array.from({ length: count }, () => 0);

  for (const memory of memories) {
    if (memory.createdAt < range.start || memory.createdAt > range.end) continue;
    const index = duration === 0
      ? 0
      : Math.min(count - 1, Math.floor((memory.createdAt - range.start) / bucketWidth));
    counts[index]++;
  }

  const includeYear = duration > 365 * DAY_MS;
  return counts.map((bucketCount, index) => {
    const start = Math.floor(range.start + bucketWidth * index);
    const end = index === count - 1
      ? range.end
      : Math.floor(range.start + bucketWidth * (index + 1)) - 1;
    const label = new Date(start).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(includeYear ? { year: '2-digit' } : {}),
    });
    return { start, end, count: bucketCount, label };
  });
}
