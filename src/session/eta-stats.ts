/** The Statistics pane's Estimates tab: ETA accuracy over a period (docs/session-eta.md). */

import { columnLabel } from './chart-model.js';
import { periodEdges, type TimesheetPeriod } from './time-tracker.js';
import { summarizeEstimates, type EtaOutcome, type EtaRecord, type EtaSummary } from './eta-tracker.js';

/** Upper edges of the actual ÷ predicted bins; the last bin is open-ended. */
const RATIO_BINS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const RECENT_ROWS = 30;

export interface EstimatePoint { predictedMin: number; actualMin: number; cliType: string; label: string; unmarked: boolean }
export interface EstimateRow { sessionName: string; note?: string; predictedMin: number; actualMin: number; slipMin: number; outcome: EtaOutcome; endedAt: number }

export interface EstimateView {
  summary: EtaSummary;
  points: EstimatePoint[];
  /** Cleared estimates by ratio bin; unmarked ones are capped, so counted apart. */
  histogram: { labels: string[]; counts: number[]; unmarked: number };
  /** On-time % per period column; null where nothing finished. */
  trend: { labels: string[]; values: (number | null)[] };
  recent: EstimateRow[];
  /** Every folder with estimates in the period, for the filter. */
  dirs: string[];
}

const minutes = (ms: number): number => Math.round(ms / 60_000);

export function buildEstimateView(
  all: EtaRecord[],
  period: TimesheetPeriod,
  anchor: number,
  dir: string | null,
  labelOf: (cliType: string) => string,
): EstimateView {
  const edges = periodEdges(period, anchor);
  const inPeriod = all.filter(r => r.startedAt >= edges[0] && r.startedAt < edges[edges.length - 1]);
  const records = dir ? inPeriod.filter(r => r.dir === dir) : inPeriod;

  const counts = new Array(RATIO_BINS.length + 1).fill(0);
  for (const r of records) {
    if (r.outcome !== 'cleared') continue;
    const ratio = (r.endedAt - r.startedAt) / Math.max(1, r.firstAt - r.startedAt);
    const bin = RATIO_BINS.findIndex(edge => ratio < edge);
    counts[bin === -1 ? RATIO_BINS.length : bin]++;
  }

  const columns = edges.slice(0, -1);
  const trend = columns.map((start, i) => {
    const inColumn = records.filter(r => r.startedAt >= start && r.startedAt < edges[i + 1]);
    return inColumn.length ? summarizeEstimates(inColumn).onTimePct : null;
  });

  return {
    summary: summarizeEstimates(records),
    points: records.map(r => ({
      predictedMin: minutes(r.firstAt - r.startedAt),
      actualMin: minutes(r.endedAt - r.startedAt),
      cliType: r.cliType,
      label: labelOf(r.cliType),
      unmarked: r.outcome === 'unmarked',
    })),
    histogram: {
      labels: [`<${RATIO_BINS[0]}×`, ...RATIO_BINS.slice(1).map((edge, i) => `${RATIO_BINS[i]}–${edge}×`), `${RATIO_BINS[RATIO_BINS.length - 1]}×+`],
      counts,
      unmarked: records.filter(r => r.outcome === 'unmarked').length,
    },
    trend: { labels: columns.map(start => columnLabel(period, start)), values: trend },
    recent: [...records].sort((a, b) => b.endedAt - a.endedAt).slice(0, RECENT_ROWS).map(r => ({
      sessionName: r.sessionName,
      ...(r.note ? { note: r.note } : {}),
      predictedMin: minutes(r.firstAt - r.startedAt),
      actualMin: minutes(r.endedAt - r.startedAt),
      slipMin: minutes(r.endedAt - r.firstAt),
      outcome: r.outcome,
      endedAt: r.endedAt,
    })),
    dirs: [...new Set(inPeriod.map(r => r.dir))].sort(),
  };
}
