/** Read-only timesheet queries over the TimeTracker (docs/time-tracking.md). */
import { ipcMain } from 'electron';
import { buildTimesheetChartModel, buildTokenChartModel } from '../../session/chart-model.js';
import { buildEstimateView, type EstimateView } from '../../session/eta-stats.js';
import type { EtaTracker } from '../../session/eta-tracker.js';
import { buildKeySheet, buildTimesheet, buildTokenSheet, periodEdges, summarizeProjects, timesheetToCsv, SUBMIT_WEIGHT, type KeyQueryResult, type SessionWhere, type Timesheet, type TimesheetPeriod, type TimesheetQueryResult, type TimeTracker, type TokenQueryResult } from '../../session/time-tracker.js';

const PERIODS: readonly TimesheetPeriod[] = ['hour', 'day', 'week', 'month'];

function validatePeriod(period: unknown, anchor: unknown): [TimesheetPeriod, number] {
  if (!PERIODS.includes(period as TimesheetPeriod)) throw new Error(`period must be one of ${PERIODS.join(', ')}`);
  if (typeof anchor !== 'number' || !Number.isFinite(anchor)) throw new Error('anchor must be a timestamp');
  return [period as TimesheetPeriod, anchor];
}

function validate(projectKey: unknown, period: unknown, anchor: unknown): [string, TimesheetPeriod, number] {
  if (typeof projectKey !== 'string' || !projectKey) throw new Error('projectKey must be a non-empty string');
  return [projectKey, ...validatePeriod(period, anchor)];
}

type SlotSource = Pick<TimeTracker, 'query'>;

function sheetFor(tracker: SlotSource, projectKey: string, period: TimesheetPeriod, anchor: number): Timesheet {
  const edges = periodEdges(period, anchor);
  return buildTimesheet(tracker.query(edges[0], edges[edges.length - 1]), projectKey, edges);
}

/**
 * The Time view on desktop and phone (gate method `__timesheet__`): with
 * `projectKey`, that project's folder grid; without, every project's totals
 * plus an all-project sheet. Both carry the shared chart data model.
 */
export function timesheetQuery(tracker: SlotSource, params: unknown): TimesheetQueryResult {
  if (!params || typeof params !== 'object') throw new Error('timesheet params must be an object');
  const { projectKey, period, anchor } = params as Record<string, unknown>;
  if (projectKey !== undefined) {
    const [key, p, a] = validate(projectKey, period, anchor);
    const sheet = sheetFor(tracker, key, p, a);
    const chartModel = buildTimesheetChartModel(sheet, p);
    return { sheet, chartModel };
  }
  const [p, a] = validatePeriod(period, anchor);
  const edges = periodEdges(p, a);
  const slots = tracker.query(edges[0], edges[edges.length - 1]);
  const sheet = buildTimesheet(slots, null, edges);
  const chartModel = buildTimesheetChartModel(sheet, p);
  return { projects: summarizeProjects(slots), sheet, chartModel };
}

/** The Statistics pane's Tokens tab: tokens per configured CLI per column, with shared chart data. */
export function tokenQuery(tracker: SlotSource, cliTypes: string[], labelOf: (cliType: string) => string, period: unknown, anchor: unknown): TokenQueryResult {
  const [p, a] = validatePeriod(period, anchor);
  const edges = periodEdges(p, a);
  const sheet = buildTokenSheet(tracker.query(edges[0], edges[edges.length - 1]), edges, cliTypes, labelOf);
  const chartModel = buildTokenChartModel(sheet, p);
  return { sheet, chartModel };
}

/** The Statistics pane's Keys tab: desktop keydowns per project and column. */
export function keyQuery(tracker: SlotSource, period: unknown, anchor: unknown): KeyQueryResult {
  const [p, a] = validatePeriod(period, anchor);
  const edges = periodEdges(p, a);
  return { sheet: buildKeySheet(tracker.query(edges[0], edges[edges.length - 1]), edges) };
}

type EstimateSource = Pick<EtaTracker, 'query'>;

/** The Statistics pane's Estimates tab: ETA accuracy in the period, optionally one folder. */
export function estimatesQuery(etas: EstimateSource, labelOf: (cliType: string) => string, period: unknown, anchor: unknown, dir?: unknown): EstimateView {
  const [p, a] = validatePeriod(period, anchor);
  if (dir !== undefined && dir !== null && typeof dir !== 'string') throw new Error('dir must be a string');
  return buildEstimateView(etas.query(0, Infinity), p, a, dir || null, labelOf);
}

/** The phone's existing reserved route selects any Statistics view. */
export function statisticsQuery(
  tracker: SlotSource,
  params: unknown,
  cliTypes: string[],
  labelOf: (cliType: string) => string,
  etas?: EstimateSource,
): TimesheetQueryResult | TokenQueryResult | KeyQueryResult | EstimateView {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('statistics params must be an object');
  const request = params as Record<string, unknown>;
  switch (request.view ?? 'timesheet') {
    case 'timesheet': return timesheetQuery(tracker, request);
    case 'tokens': return tokenQuery(tracker, cliTypes, labelOf, request.period, request.anchor);
    case 'keys': return keyQuery(tracker, request.period, request.anchor);
    case 'estimates':
      if (!etas) throw new Error('estimates are unavailable');
      return estimatesQuery(etas, labelOf, request.period, request.anchor, request.dir);
    default: throw new Error('view must be timesheet, tokens, keys or estimates');
  }
}

/** Phone calls that only look (read/list/search/download) are not the user working. */
const PHONE_READ_ONLY = /_(get|list|read_terminal|info|search|graph|export|summary|status|check|history|download|tools)$/;
/** Credited by the delivery path itself (origin 'user'), so never twice. */
const PHONE_CREDITED_BY_DELIVERY = new Set(['session_send_text']);

/**
 * Where a phone call counts as the user's time: the session it acts on, or
 * the folder of the plan it edits. Null for read-only calls, calls that
 * reported failure, or no target.
 */
export function phoneActivityTarget(
  method: string,
  params: unknown,
  planDir: (planId: string) => string | null,
  result?: unknown,
): { sessionId: string } | { dirPath: string } | null {
  if (PHONE_READ_ONLY.test(method) || PHONE_CREDITED_BY_DELIVERY.has(method)) return null;
  if (!params || typeof params !== 'object') return null;
  if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) return null;
  const p = params as Record<string, unknown>;
  if (typeof p.sessionId === 'string' && p.sessionId) return { sessionId: p.sessionId };
  if (typeof p.dirPath === 'string' && p.dirPath) return { dirPath: p.dirPath };
  const planId = method.startsWith('plan_') ? (p.id ?? p.planId) : p.planId;
  const dir = typeof planId === 'string' ? planDir(planId) : null;
  return dir ? { dirPath: dir } : null;
}

/** User input in a non-terminal pane: the session it belongs to, or the folder it edits. */
export interface TimeActivityTarget { sessionId?: string; dirPath?: string; submit?: boolean }

export function setupTimeTrackingHandlers(
  tracker: TimeTracker,
  whereIsDir: (dir: string) => SessionWhere,
  cliTypes: () => string[],
  cliTypeLabel: (cliType: string) => string,
  etas?: EstimateSource,
): () => void {
  if (etas) {
    ipcMain.handle('time:estimates', (_event, period: unknown, anchor: unknown, dir: unknown) => estimatesQuery(etas, cliTypeLabel, period, anchor, dir));
  }
  ipcMain.handle('time:query', (_event, params: unknown) => timesheetQuery(tracker, params));
  ipcMain.handle('time:tokens', (_event, period: unknown, anchor: unknown) => tokenQuery(tracker, cliTypes(), cliTypeLabel, period, anchor));
  ipcMain.handle('time:keys', (_event, period: unknown, anchor: unknown) => keyQuery(tracker, period, anchor));
  ipcMain.handle('time:record-keys', (_event, sessionId: unknown, count: unknown, at: unknown) => {
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 10_000
      || typeof at !== 'number' || !Number.isFinite(at)) return;
    tracker.recordKeys(sessionId, count as number, at);
  });
  ipcMain.handle('time:timesheet', (_event, projectKey: unknown, period: unknown, anchor: unknown) =>
    sheetFor(tracker, ...validate(projectKey, period, anchor)));

  ipcMain.handle('time:csv', (_event, projectKey: unknown, period: unknown, anchor: unknown, projectName: unknown) =>
    timesheetToCsv(sheetFor(tracker, ...validate(projectKey, period, anchor)), typeof projectName === 'string' ? projectName : String(projectKey)));

  // The renderer reports keystrokes in the planner and artifacts (batched, not awaited).
  ipcMain.handle('time:activity', (_event, target: TimeActivityTarget, keystrokes: unknown) => {
    if (!target || typeof target !== 'object') return;
    const weight = target.submit ? SUBMIT_WEIGHT : Math.min(SUBMIT_WEIGHT, Math.max(0, Math.floor(Number(keystrokes) || 0)));
    if (!weight) return;
    if (typeof target.sessionId === 'string') tracker.recordUser(weight, target.sessionId);
    else if (typeof target.dirPath === 'string' && target.dirPath) tracker.recordUserAt(weight, whereIsDir(target.dirPath));
  });

  return () => {
    ipcMain.removeHandler('time:activity');
    ipcMain.removeHandler('time:query');
    ipcMain.removeHandler('time:tokens');
    ipcMain.removeHandler('time:keys');
    ipcMain.removeHandler('time:record-keys');
    ipcMain.removeHandler('time:timesheet');
    ipcMain.removeHandler('time:csv');
    if (etas) ipcMain.removeHandler('time:estimates');
  };
}
