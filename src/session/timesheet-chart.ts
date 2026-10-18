/**
 * The timesheet chart as self-contained markup (inline SVG + CSS, no script),
 * so the desktop Timesheet pane and the phone's WebView draw the same thing.
 * You/AI minutes are bars on the left axis; tokens a line on the right axis.
 * The series toggles are CSS-only checkboxes, which works in either host.
 * The token chart stacks one bar segment per CLI.
 */

import { buildTimesheetChartModel, buildTokenChartModel, type ChartModel } from './chart-model.js';
import type { Timesheet, TimesheetPeriod, TokenSheet } from './time-tracker.js';
export { columnLabel } from './chart-model.js';

const W = 700, H = 290, L = 60, R = 640, TOP = 20, BOTTOM = 260;
const GRID = 4;
const BASE_STYLE = `
.tsc{font-family:Consolas,'Cascadia Mono',monospace;font-size:12px;color:#eee}
.tsc input{display:none}
.tsc .toggles{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.tsc label{padding:3px 10px;border:1px solid #222;border-radius:4px;cursor:pointer;color:#555;user-select:none}
.tsc label i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;opacity:.3}
.tsc svg{width:100%;height:auto;display:block}
.tsc svg text{fill:#999;font-size:10px;font-family:inherit}`;

interface ChartSeries {
  id: string;
  key: string;
  label: string;
  color: string;
  total: string;
}

/** One CSS-only legend toggle pattern shared by the timesheet and token charts. */
function chartControls(series: ChartSeries[]): { style: string; html: string } {
  const activeLabels = series.map(s => `.tsc #${s.id}:checked~.toggles .l-${s.key}`).join(',');
  const activeSwatches = series.map(s => `.tsc #${s.id}:checked~.toggles .l-${s.key} i`).join(',');
  const hiddenSeries = series.map(s => `.tsc #${s.id}:not(:checked)~svg .s-${s.key}{display:none}`).join('');
  return {
    style: `${BASE_STYLE}\n${activeLabels}{color:#eee;background:#1a1a1a}\n${activeSwatches}{opacity:1}\n${hiddenSeries}`,
    html: series.map(s => `<input type="checkbox" id="${s.id}" checked>`).join('')
      + '<div class="toggles">'
      + series.map(s => `<label for="${s.id}" class="l-${s.key}"><i style="background:${s.color}"></i>${escapeHtml(s.label)} ${s.total}</label>`).join('')
      + '</div>',
  };
}

export function renderTimesheetChart(sheet: Pick<Timesheet, 'columns' | 'totals'>, period: TimesheetPeriod, now = Date.now()): string {
  return renderTimesheetChartModel(buildTimesheetChartModel(sheet, period, now));
}

export function renderTimesheetChartModel(model: ChartModel): string {
  const n = model.columns.length;
  const [you, ai, tokens] = model.series.map(series => series.values);
  const timeMax = niceMinutes(Math.max(0, ...you, ...ai));
  const tokMax = niceCeil(Math.max(0, ...tokens));
  const yTime = (v: number) => BOTTOM - (v / timeMax) * (BOTTOM - TOP);
  const yTok = (v: number) => BOTTOM - (v / tokMax) * (BOTTOM - TOP);
  const step = (R - L) / Math.max(n, 1);
  const centre = (i: number) => L + step * (i + 0.5);
  const barW = Math.max(2, Math.min(22, step * 0.38));
  const labelEvery = Math.ceil(n / 12);

  const grid: string[] = [], leftAxis: string[] = [], rightAxis: string[] = [];
  for (let g = 0; g <= GRID; g++) {
    const y = TOP + ((BOTTOM - TOP) * g) / GRID;
    const frac = 1 - g / GRID;
    grid.push(`<line x1="${L}" y1="${y}" x2="${R}" y2="${y}"${g === GRID ? ' stroke="#555"' : ''}/>`);
    leftAxis.push(`<text x="${L - 6}" y="${y + 3}">${formatMinutes(timeMax * frac)}</text>`);
    rightAxis.push(`<text x="${R + 6}" y="${y + 3}">${formatTokens(tokMax * frac)}</text>`);
  }
  const bars = (values: number[], dx: number) => values
    .map((v, i) => v > 0 ? `<rect x="${fx(centre(i) + dx)}" y="${fx(yTime(v))}" width="${fx(barW)}" height="${fx(BOTTOM - yTime(v))}"/>` : '')
    .join('');
  const points = tokens.map((v, i) => `${fx(centre(i))},${fx(yTok(v))}`);
  const labels = model.labels
    .map((label, i) => i % labelEvery ? '' : `<text x="${fx(centre(i))}" y="${BOTTOM + 18}">${label}</text>`)
    .join('');
  const sum = (a: number[]) => a.reduce((t, v) => t + v, 0);
  const controls = chartControls([
    { id: 'tsc-you', key: 'you', label: model.series[0].label, color: model.series[0].color, total: formatMinutes(sum(you)) },
    { id: 'tsc-ai', key: 'ai', label: model.series[1].label, color: model.series[1].color, total: formatMinutes(sum(ai)) },
    { id: 'tsc-tok', key: 'tok', label: model.series[2].label, color: model.series[2].color, total: formatTokens(sum(tokens)) },
  ]);

  return `<div class="tsc"><style>${controls.style}</style>${controls.html}`
    + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Time and tokens per period">`
    + `<g stroke="#222">${grid.join('')}</g>`
    + `<g text-anchor="end">${leftAxis.join('')}</g>`
    + `<g class="s-tok" text-anchor="start">${rightAxis.join('')}</g>`
    + `<g text-anchor="middle">${labels}</g>`
    + `<g class="s-you" fill="${model.series[0].color}">${bars(you, -barW - 1)}</g>`
    + `<g class="s-ai" fill="${model.series[1].color}">${bars(ai, 1)}</g>`
    + `<g class="s-tok"><polyline fill="none" stroke="${model.series[2].color}" stroke-width="2" points="${points.join(' ')}"/>`
    + `<g fill="${model.series[2].color}">${tokens.map((v, i) => `<circle cx="${fx(centre(i))}" cy="${fx(yTok(v))}" r="3"/>`).join('')}</g></g>`
    + '</svg></div>';
}

export function renderTokenChart(sheet: TokenSheet, period: TimesheetPeriod, now = Date.now()): string {
  return renderTokenChartModel(buildTokenChartModel(sheet, period, now));
}

export function renderTokenChartModel(model: ChartModel): string {
  const n = model.columns.length;
  const rows = model.series;
  const totals = model.columns.map((_, i) => rows.reduce((sum, row) => sum + (row.values[i] ?? 0), 0));
  const max = niceCeil(Math.max(0, ...totals));
  const y = (v: number) => BOTTOM - (v / max) * (BOTTOM - TOP);
  const step = (R - L) / Math.max(n, 1);
  const barW = Math.max(2, Math.min(36, step * 0.6));
  const labelEvery = Math.ceil(n / 12);
  const sum = (a: number[]) => a.reduce((t, v) => t + v, 0);

  const grid: string[] = [], axis: string[] = [];
  for (let g = 0; g <= GRID; g++) {
    const gy = TOP + ((BOTTOM - TOP) * g) / GRID;
    grid.push(`<line x1="${L}" y1="${gy}" x2="${R}" y2="${gy}"${g === GRID ? ' stroke="#555"' : ''}/>`);
    axis.push(`<text x="${L - 6}" y="${gy + 3}">${formatTokens(max * (1 - g / GRID))}</text>`);
  }
  const stacked = new Array<number>(n).fill(0);
  const bars = rows.map((row, r) => {
    const rects = row.values.map((v, i) => {
      if (v <= 0) return '';
      const top = y(stacked[i] + v), bottom = y(stacked[i]);
      stacked[i] += v;
      const tooltip = `${escapeHtml(row.label)} — ${escapeHtml(model.labels[i])}: ${v.toLocaleString('en-US')} tokens`;
      return `<rect x="${fx(L + step * (i + 0.5) - barW / 2)}" y="${fx(top)}" width="${fx(barW)}" height="${fx(bottom - top)}"><title>${tooltip}</title></rect>`;
    }).join('');
    return `<g class="s-model-${r}" fill="${row.color}">${rects}</g>`;
  }).join('');
  const labels = model.labels
    .map((label, i) => i % labelEvery ? '' : `<text x="${fx(L + step * (i + 0.5))}" y="${BOTTOM + 18}">${label}</text>`)
    .join('');
  const controls = chartControls(rows.map((row, r) => ({
    id: `tsc-model-${r}`,
    key: `model-${r}`,
    label: row.label,
    color: row.color,
    total: formatTokens(sum(row.values)),
  })));

  return `<div class="tsc"><style>${controls.style}</style>${controls.html}`
    + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens per CLI per period">`
    + `<g stroke="#222">${grid.join('')}</g>`
    + `<g text-anchor="end">${axis.join('')}</g>`
    + `<g text-anchor="middle">${labels}</g>`
    + bars
    + '</svg></div>';
}

/**
 * Smallest grid of GRID clock-friendly steps (5m … 12h, then whole days)
 * covering v. Parallel AI time can pass 24h a day, so the steps keep going.
 */
function niceMinutes(v: number): number {
  const steps = [5, 15, 30, 60, 90, 120, 180, 240, 360, 480, 720];
  const step = steps.find(s => s * GRID >= v) ?? Math.ceil(v / GRID / 1440) * 1440;
  return step * GRID;
}

/** Smallest 1/2/2.5/5 × 10^k at or above v, so grid lines land on round numbers. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find(m => m * base >= v) ?? 10) * base;
}

/** CLI type names come from user config and land in v-html. */
function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function fx(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function formatMinutes(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const rest = m % 60;
  return rest ? `${Math.floor(m / 60)}h${String(rest).padStart(2, '0')}` : `${m / 60}h`;
}

export function formatTokens(t: number, compact = true): string {
  if (compact && t >= 1e6) return `${+(t / 1e6).toFixed(2)}M`;
  if (compact && t >= 1e3) return `${+(t / 1e3).toFixed(1)}k`;
  return Math.round(t).toLocaleString('en-US');
}
