/** Read-only timesheet queries over the TimeTracker (docs/time-tracking.md). */
import { ipcMain } from 'electron';
import { buildTimesheet, periodEdges, summarizeProjects, timesheetToCsv, SUBMIT_WEIGHT, type SessionWhere, type Timesheet, type TimesheetPeriod, type TimeTracker } from '../../session/time-tracker.js';

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
 * The phone's Time tab (gate method `__timesheet__`): with `projectKey`, that
 * project's folder grid; without, every project's totals for the period.
 */
export function timesheetQuery(tracker: SlotSource, params: unknown): { sheet: Timesheet } | { projects: ReturnType<typeof summarizeProjects> } {
  if (!params || typeof params !== 'object') throw new Error('timesheet params must be an object');
  const { projectKey, period, anchor } = params as Record<string, unknown>;
  if (projectKey !== undefined) return { sheet: sheetFor(tracker, ...validate(projectKey, period, anchor)) };
  const [p, a] = validatePeriod(period, anchor);
  const edges = periodEdges(p, a);
  return { projects: summarizeProjects(tracker.query(edges[0], edges[edges.length - 1])) };
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
): () => void {
  ipcMain.handle('time:query', (_event, params: unknown) => timesheetQuery(tracker, params));
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
    ipcMain.removeHandler('time:timesheet');
    ipcMain.removeHandler('time:csv');
  };
}
