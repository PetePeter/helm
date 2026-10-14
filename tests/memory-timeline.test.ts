import { describe, expect, it } from 'vitest';
import type { MemorySummary } from '../src/types/memory.js';
import {
  buildMemoryHistogram,
  memoriesInTimelineRange,
  memoryRangeForPreset,
  memoryTimelineBounds,
  sortMemoriesNewestFirst,
} from '../renderer/memories/memory-timeline.js';

const DAY = 24 * 60 * 60 * 1000;

function memory(id: string, createdAt: number, updatedAt = createdAt): MemorySummary {
  return { id, tldr: id, createdAt, updatedAt, attachmentCount: 0 };
}

describe('memory timeline helpers', () => {
  it('sorts newest first by creation time with stable tie breakers', () => {
    expect(sortMemoriesNewestFirst([
      memory('old', 1),
      memory('same-z', 2, 4),
      memory('same-a', 2, 4),
      memory('updated', 2, 5),
    ]).map((item) => item.id)).toEqual(['updated', 'same-a', 'same-z', 'old']);
  });

  it('uses the latest memory as the end of a quick range and clamps to available history', () => {
    const bounds = memoryTimelineBounds([memory('first', 0), memory('latest', 40 * DAY)]);
    expect(bounds).toEqual({ start: 0, end: 40 * DAY });
    expect(memoryRangeForPreset(bounds!, '7d')).toEqual({ start: 33 * DAY, end: 40 * DAY });
    expect(memoryRangeForPreset(bounds!, '30d')).toEqual({ start: 10 * DAY, end: 40 * DAY });
    expect(memoryRangeForPreset(bounds!, 'all')).toEqual(bounds);
    expect(memoryRangeForPreset({ start: 0, end: 3 * DAY }, '30d')).toEqual({ start: 0, end: 3 * DAY });
  });

  it('filters inclusively and counts each memory in one histogram bucket', () => {
    const records = [memory('first', 0), memory('middle', 10 * DAY), memory('last', 20 * DAY)];
    const range = { start: 0, end: 20 * DAY };
    const buckets = buildMemoryHistogram(records, range);
    expect(buckets).toHaveLength(20);
    expect(buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(3);
    expect(memoriesInTimelineRange(records, { start: 10 * DAY, end: 20 * DAY }).map((item) => item.id))
      .toEqual(['middle', 'last']);
  });

  it('keeps all-time charts bounded and supports a single-timestamp history', () => {
    const longHistory = Array.from({ length: 80 }, (_, index) => memory(String(index), index * 20 * DAY));
    const bounds = memoryTimelineBounds(longHistory)!;
    expect(buildMemoryHistogram(longHistory, bounds)).toHaveLength(30);
    expect(buildMemoryHistogram([memory('only', 123)], { start: 123, end: 123 }))
      .toMatchObject([{ start: 123, end: 123, count: 1 }]);
  });
});
